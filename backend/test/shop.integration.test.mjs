import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { makeHandler } from '../src/app.mjs';
import { initializeLocalTables } from '../src/container-bootstrap.mjs';
import { migrateToTenancy } from '../src/tenancy-migration.mjs';
import { memoryPhotos } from '../src/photo-store.mjs';

const dynamoEndpoint = process.env.MARKETPLACE_DYNAMO_ENDPOINT;

// The unit tests use an in-memory imitation of DynamoDB. This runs the same shop flows against
// DynamoDB Local, so the condition, update and index expressions are checked by the real parser.
test('shop tenancy, hold limits, the counter queue and an in-place upgrade work on DynamoDB', {
  skip: !dynamoEndpoint, timeout: 60_000,
}, async (context) => {
  const client = new DynamoDBClient({
    endpoint: dynamoEndpoint, region: 'us-east-1', credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' },
  });
  const db = DynamoDBDocumentClient.from(client);
  const run = randomUUID().slice(0, 8);
  const tables = { items: `items-${run}`, reservations: `reservations-${run}`, tenancy: `tenancy-${run}` };
  context.after(async () => {
    try { await Promise.all(Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName })).catch(() => {}))); }
    finally { client.destroy(); }
  });
  // An items table from before indexes existed, holding a pilot item and a pilot hold.
  await client.send(new CreateTableCommand({
    TableName: tables.items, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
  }));
  await initializeLocalTables(client, db, tables);
  const { Table } = await client.send(new DescribeTableCommand({ TableName: tables.items }));
  assert.deepEqual(Table.GlobalSecondaryIndexes.map(({ IndexName }) => IndexName), ['ByShop'], 'the older table gained its index');
  const reservationIndexes = (await client.send(new DescribeTableCommand({ TableName: tables.reservations }))).Table.GlobalSecondaryIndexes;
  assert.deepEqual(reservationIndexes.map(({ IndexName }) => IndexName).sort(), ['ByShopCreated', 'ByStudent', 'Queue']);
  const legacy = { id: randomUUID(), itemId: 'item-02', code: '123456', status: 'HELD', createdAt: '2026-11-27T08:00:00.000Z' };
  await db.send(new PutCommand({ TableName: tables.reservations, Item: legacy }));
  assert.equal((await migrateToTenancy(db, tables, { shopId: 'campus-shop', name: 'Campus shop', holdMinutes: 60 })).reservations, 1);

  let clock = Date.parse('2026-11-27T10:00:00Z');
  const handler = makeHandler(db, {
    itemsTable: tables.items, reservationsTable: tables.reservations, tenancyTable: tables.tenancy, shopKey: 'legacy-key-123456',
    holdMinutes: 60, now: () => new Date(clock), actorFrom: (event) => event.actor, photos: memoryPhotos('https://photos.example'),
  });
  const call = async (routeKey, { as, params, body, query, headers = {} } = {}) => {
    const res = await handler({ routeKey, actor: as, pathParameters: params, queryStringParameters: query, body: body && JSON.stringify(body), headers });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const admin = { id: randomUUID(), platformAdmin: true };
  const owner = { id: randomUUID() };
  const student = { id: randomUUID() };
  const reserve = (itemId, id = randomUUID(), as = student) => call('POST /reservations', { as, body: { id, itemId } });

  assert.equal((await call('PUT /shops/{shopId}/staff/{userId}', { as: admin, params: { shopId: 'campus-shop', userId: owner.id }, body: { role: 'owner' } })).status, 200);
  assert.deepEqual((await call('GET /me', { as: owner })).body.shops, [{ shopId: 'campus-shop', name: 'Campus shop', role: 'owner', status: 'active', pickupWindow: '' }]);
  const catalog = (await call('GET /items')).body;
  assert.equal(catalog.length, 12);
  assert.deepEqual(catalog.map(({ name }) => name), [...catalog.map(({ name }) => name)].sort(), 'the index returns the catalog by name');

  const id = randomUUID();
  const first = await reserve('item-01', id);
  assert.equal(first.status, 201);
  const second = await reserve('item-01');
  assert.equal(second.status, 201);
  const third = await reserve('item-08'); // item-08 has one unit
  assert.equal(third.status, 201);
  const limited = await reserve('item-01');
  assert.equal(limited.status, 409);
  assert.equal(limited.body.code, 'HOLD_LIMIT');
  assert.equal((await reserve('item-01', id)).body.code, first.body.code, 'a retry at the limit returns the original hold');
  assert.equal((await reserve('item-08', randomUUID(), { id: randomUUID() })).body.error, 'Out of stock');

  const queue = (await call('GET /shop/reservations', { headers: { 'x-shop-key': 'legacy-key-123456' } })).body;
  assert.deepEqual(queue.map((r) => r.id).sort(), [legacy.id, first.body.id, second.body.id, third.body.id].sort());
  const act = (reservation, action) => call(`POST /shops/{shopId}/reservations/{id}/${action}`, { as: owner, params: { shopId: 'campus-shop', id: reservation } });
  assert.equal((await act(legacy.id, 'collect')).status, 200, 'a pilot hold without a student is collected');
  assert.equal((await act(first.body.id, 'set-aside')).status, 200);
  assert.equal((await act(first.body.id, 'collect')).status, 200);
  assert.equal((await reserve('item-01')).status, 201, 'collecting freed a hold');

  clock += 61 * 60_000;
  assert.deepEqual(await handler({ source: 'aws.events' }), { expired: 3, deferred: 0, failed: 0 });
  const awaiting = (await call('GET /shops/{shopId}/reservations', { as: owner, params: { shopId: 'campus-shop' } })).body;
  assert.ok(awaiting.length === 3 && awaiting.every((r) => r.status === 'EXPIRED'), 'expired holds wait for the shelf');
  assert.equal((await act(third.body.id, 'returned')).status, 200);
  assert.equal((await call('GET /shops/{shopId}/reservations', { as: owner, params: { shopId: 'campus-shop' } })).body.length, 2);
  assert.equal((await reserve('item-01')).status, 201, 'expiry gave the student their holds back');

  const item = (await call('GET /items')).body.find((entry) => entry.id === 'item-01');
  const recount = (expectedVersion) => call('PUT /shops/{shopId}/items/{id}', { as: owner, params: { shopId: 'campus-shop', id: 'item-01' }, body: { stock: 50, expectedVersion } });
  assert.equal((await recount(item.version - 1)).status, 409);
  assert.equal((await recount(item.version)).status, 200);

  // Phase 2: catalog editing, invites, the activity log and windowed stats.
  const shop = { shopId: 'campus-shop' };
  const newItem = { id: randomUUID(), name: 'Drawing pencils', course: 'Engineering Drawing', price: 120, stock: 6 };
  // The test clock stands still, so step it: entries made in the same millisecond have no set order.
  clock += 60_000;
  assert.equal((await call('POST /shops/{shopId}/items', { as: owner, params: shop, body: newItem })).status, 201);
  clock += 60_000;
  assert.equal((await call('PUT /shops/{shopId}/items/{id}/details', { as: owner, params: { ...shop, id: newItem.id },
    body: { name: 'Drawing pencils, set of 6', course: '', price: 130, active: false, expectedVersion: 0 } })).status, 200);
  assert.ok(!(await call('GET /items')).body.some(({ id: itemId }) => itemId === newItem.id), 'off-sale items leave the public catalog');
  assert.equal((await call('GET /shops/{shopId}/catalog', { as: owner, params: shop })).body.find(({ id: itemId }) => itemId === newItem.id).name, 'Drawing pencils, set of 6');
  clock += 60_000;
  const { token } = (await call('POST /shops/{shopId}/invites', { as: owner, params: shop, body: { role: 'staff' } })).body;
  clock += 60_000;
  const clerk = { id: randomUUID() };
  assert.equal((await call('POST /invites/accept', { as: clerk, body: { token, name: 'Clerk' } })).status, 200);
  assert.equal((await call('POST /invites/accept', { as: { id: randomUUID() }, body: { token } })).status, 404, 'an invite works once');
  assert.deepEqual((await call('GET /shops/{shopId}/staff', { as: owner, params: shop })).body.map(({ name }) => name).sort(), ['', 'Clerk']);
  const activity = (await call('GET /shops/{shopId}/audit', { as: owner, params: shop })).body;
  assert.deepEqual(activity.entries.slice(0, 3).map(({ action }) => action), ['joined', 'invite', 'item-updated'], 'newest first');
  // Five holds made above, plus the migrated pilot hold from earlier the same day.
  assert.equal((await call('GET /shops/{shopId}/stats', { as: owner, params: shop, query: { days: '1' } })).body.reservations, 6);

  // Phase 3: shop list, passes across devices through ByStudent, and the photo field.
  assert.deepEqual((await call('GET /shops')).body.map(({ id: shopId }) => shopId), ['campus-shop']);
  const passes = (await call('GET /me/reservations', { as: student })).body;
  assert.equal(passes.length, 5);
  assert.ok(passes.every((pass, index) => index === 0 || passes[index - 1].createdAt >= pass.createdAt), 'newest first');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 1)]).toString('base64');
  const photo = (data) => call('PUT /shops/{shopId}/items/{id}/photo', { as: owner, params: { ...shop, id: 'item-02' }, body: { data } });
  assert.match((await photo(jpeg)).body.photoUrl, /^https:\/\/photos\.example\/items\/campus-shop\//);
  assert.ok((await call('GET /items')).body.find(({ id: itemId }) => itemId === 'item-02').photoUrl);
  assert.equal((await photo(null)).status, 200);
  assert.equal((await call('GET /items')).body.find(({ id: itemId }) => itemId === 'item-02').photoUrl, undefined);

  assert.equal((await call('POST /admin/shops', { as: admin, body: { id: 'second-shop', name: 'Second shop', ownerId: randomUUID() } })).status, 201);
  assert.equal((await call('GET /shops/{shopId}/reservations', { as: owner, params: { shopId: 'second-shop' } })).status, 404);
  await db.send(new PutCommand({ TableName: tables.tenancy, Item: { pk: 'SHOP', sk: 'campus-shop', name: 'Campus shop', status: 'suspended' } }));
  assert.equal((await reserve('item-01', randomUUID(), { id: randomUUID() })).status, 403);
});
