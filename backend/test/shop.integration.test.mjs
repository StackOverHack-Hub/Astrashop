import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { makeHandler } from '../src/app.mjs';
import { initializeLocalTables } from '../src/container-bootstrap.mjs';
import { migrateToTenancy } from '../src/tenancy-migration.mjs';

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
  const legacy = { id: randomUUID(), itemId: 'item-02', code: '123456', status: 'HELD', createdAt: '2026-11-27T08:00:00.000Z' };
  await db.send(new PutCommand({ TableName: tables.reservations, Item: legacy }));
  assert.equal((await migrateToTenancy(db, tables, { shopId: 'campus-shop', name: 'Campus shop', holdMinutes: 60 })).reservations, 1);

  let clock = Date.parse('2026-11-27T10:00:00Z');
  const handler = makeHandler(db, {
    itemsTable: tables.items, reservationsTable: tables.reservations, tenancyTable: tables.tenancy, shopKey: 'legacy-key-123456',
    holdMinutes: 60, now: () => new Date(clock), actorFrom: (event) => event.actor,
  });
  const call = async (routeKey, { as, params, body, headers = {} } = {}) => {
    const res = await handler({ routeKey, actor: as, pathParameters: params, body: body && JSON.stringify(body), headers });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const admin = { id: randomUUID(), platformAdmin: true };
  const owner = { id: randomUUID() };
  const student = { id: randomUUID() };
  const reserve = (itemId, id = randomUUID(), as = student) => call('POST /reservations', { as, body: { id, itemId } });

  assert.equal((await call('PUT /shops/{shopId}/staff/{userId}', { as: admin, params: { shopId: 'campus-shop', userId: owner.id }, body: { role: 'owner' } })).status, 200);
  assert.deepEqual((await call('GET /me', { as: owner })).body.shops, [{ shopId: 'campus-shop', name: 'Campus shop', role: 'owner' }]);
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

  assert.equal((await call('POST /admin/shops', { as: admin, body: { id: 'second-shop', name: 'Second shop', ownerId: randomUUID() } })).status, 201);
  assert.equal((await call('GET /shops/{shopId}/reservations', { as: owner, params: { shopId: 'second-shop' } })).status, 404);
  await db.send(new PutCommand({ TableName: tables.tenancy, Item: { pk: 'SHOP', sk: 'campus-shop', name: 'Campus shop', status: 'suspended' } }));
  assert.equal((await reserve('item-01', randomUUID(), { id: randomUUID() })).status, 403);
});
