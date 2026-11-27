import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHandler } from '../src/app.mjs';
import { fakeDb } from '../fake-db.mjs';
import { migrateToTenancy } from '../src/tenancy-migration.mjs';

const tables = { items: 'items', reservations: 'reservations', tenancy: 'tenancy' };
const admin = { id: randomUUID(), platformAdmin: true };
const ownerA = { id: randomUUID() };
const staffA = { id: randomUUID() };
const ownerB = { id: randomUUID() };
const student = { id: randomUUID() };

async function setup({ stock = 5 } = {}) {
  const db = fakeDb([
    { id: 'a-1', shopId: 'shop-a', name: 'Drawing sheet', stock, version: 0 },
    { id: 'a-2', shopId: 'shop-a', name: 'Graph paper', stock, version: 0 },
    { id: 'b-1', shopId: 'shop-b', name: 'Lab coat', stock, version: 0 },
  ]);
  let clock = Date.parse('2026-11-27T10:00:00Z');
  const handler = makeHandler(db, {
    itemsTable: 'items', reservationsTable: 'reservations', tenancyTable: 'tenancy', shopKey: 'legacy-key-123456',
    holdMinutes: 60, now: () => new Date(clock), actorFrom: (event) => event.actor,
  });
  const call = async (routeKey, { as, params, body } = {}) => {
    const res = await handler({ routeKey, actor: as, pathParameters: params, body: body && JSON.stringify(body), headers: {} });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const reserve = (as, itemId = 'a-1', id = randomUUID()) => call('POST /reservations', { as, body: { id, itemId } });
  const act = (as, shopId, id, action) => call(`POST /shops/{shopId}/reservations/{id}/${action}`, { as, params: { shopId, id } });
  const activeHolds = (who, shopId = 'shop-a') => db.tables.tenancy.get(JSON.stringify([`STUDENT#${who.id}`, `HOLDS#${shopId}`]))?.active;
  assert.equal((await call('POST /admin/shops', { as: admin, body: { id: 'shop-a', name: 'Shop A', ownerId: ownerA.id } })).status, 201);
  assert.equal((await call('POST /admin/shops', { as: admin, body: { id: 'shop-b', name: 'Shop B', ownerId: ownerB.id } })).status, 201);
  assert.equal((await call('PUT /shops/{shopId}/staff/{userId}', { as: ownerA, params: { shopId: 'shop-a', userId: staffA.id }, body: { role: 'staff' } })).status, 200);
  return { db, call, reserve, act, activeHolds, advance: (minutes) => { clock += minutes * 60_000; },
    sweep: () => handler({ source: 'aws.events' }) };
}

test('reserving needs a signed-in student', async () => {
  const { call } = await setup();
  assert.equal((await call('POST /reservations', { body: { id: randomUUID(), itemId: 'a-1' } })).status, 401);
  assert.equal((await call('GET /shops/{shopId}/items', { params: { shopId: 'shop-a' } })).body.length, 2, 'browsing stays open');
});

test('a student can hold three items per shop, and a finished hold frees a place', async () => {
  const { reserve, act, activeHolds } = await setup();
  const holds = [];
  for (let n = 0; n < 3; n++) holds.push((await reserve(student)).body);
  const blocked = await reserve(student, 'a-2');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'HOLD_LIMIT');
  assert.equal((await reserve(student, 'b-1')).status, 201, 'the limit is per shop');
  assert.equal((await act(staffA, 'shop-a', holds[0].id, 'collect')).status, 200);
  assert.equal(activeHolds(student), 2);
  assert.equal((await reserve(student, 'a-2')).status, 201);
  assert.equal((await act(staffA, 'shop-a', holds[1].id, 'release')).status, 200);
  assert.equal(activeHolds(student), 2);
});

test('two phones racing for the last free hold get exactly one', async () => {
  const { reserve, activeHolds } = await setup();
  await reserve(student);
  await reserve(student);
  const results = await Promise.all([reserve(student, 'a-1'), reserve(student, 'a-2')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(activeHolds(student), 3);
});

test('a retry of the hold that reached the limit returns that hold', async () => {
  const { reserve, db } = await setup({ stock: 3 });
  await reserve(student);
  await reserve(student);
  const id = randomUUID();
  const first = await reserve(student, 'a-1', id); // takes the last unit and the last free hold
  const retry = await reserve(student, 'a-1', id); // the phone never saw the first response
  assert.equal(retry.status, 200);
  assert.equal(retry.body.code, first.body.code);
  assert.equal(db.tables.items.get('a-1').stock, 0);
  assert.equal((await reserve({ id: randomUUID() }, 'a-1', id)).status, 409, 'another student cannot claim that id');
});

test('expiry gives the student their hold back', async () => {
  const { reserve, activeHolds, advance, sweep } = await setup();
  await reserve(student);
  advance(61);
  assert.equal((await sweep()).expired, 1);
  assert.equal(activeHolds(student), 0);
});

test('a lost hold count never blocks a pickup', async () => {
  const { reserve, act, db } = await setup();
  const hold = (await reserve(student)).body;
  db.tables.tenancy.delete(JSON.stringify([`STUDENT#${student.id}`, 'HOLDS#shop-a']));
  assert.equal((await act(staffA, 'shop-a', hold.id, 'collect')).status, 200);
});

test('staff of one shop cannot see or change another shop', async () => {
  const { call, reserve, act } = await setup();
  const holdB = (await reserve(student, 'b-1')).body;
  assert.equal((await call('GET /shops/{shopId}/reservations', { as: staffA, params: { shopId: 'shop-b' } })).status, 404);
  assert.equal((await call('GET /shops/{shopId}/stats', { as: staffA, params: { shopId: 'shop-b' } })).status, 404);
  for (const action of ['set-aside', 'collect', 'release', 'returned']) {
    assert.equal((await act(staffA, 'shop-a', holdB.id, action)).status, 404, `${action} through shop A`);
    assert.equal((await act(staffA, 'shop-b', holdB.id, action)).status, 404, `${action} on shop B`);
  }
  const recount = (shopId) => call('PUT /shops/{shopId}/items/{id}', { as: staffA, params: { shopId, id: 'b-1' }, body: { stock: 0, expectedVersion: 1 } });
  assert.equal((await recount('shop-a')).status, 404);
  assert.equal((await recount('shop-b')).status, 404);
  assert.equal((await call('GET /shops/{shopId}/reservations', { as: student, params: { shopId: 'shop-a' } })).status, 404, 'students are not staff');
  const queue = await call('GET /shops/{shopId}/reservations', { as: ownerB, params: { shopId: 'shop-b' } });
  assert.deepEqual(queue.body.map((r) => r.id), [holdB.id]);
  assert.equal(queue.body[0].studentId, undefined, 'staff do not see account ids');
});

test('owners manage staff, staff cannot, and nobody changes their own access', async () => {
  const { call } = await setup();
  const newcomer = { id: randomUUID() };
  const grant = (as, shopId, userId, role) => call('PUT /shops/{shopId}/staff/{userId}', { as, params: { shopId, userId }, body: { role } });
  assert.equal((await grant(staffA, 'shop-a', newcomer.id, 'staff')).status, 403);
  assert.equal((await grant(ownerB, 'shop-a', newcomer.id, 'staff')).status, 404);
  assert.equal((await grant(ownerA, 'shop-a', ownerA.id, null)).status, 409);
  assert.equal((await grant(ownerA, 'shop-a', newcomer.id, 'manager')).status, 400);
  assert.equal((await grant(ownerA, 'shop-a', newcomer.id, 'staff')).status, 200);
  assert.deepEqual((await call('GET /me', { as: newcomer })).body.shops, [{ shopId: 'shop-a', name: 'Shop A', role: 'staff' }]);
  assert.equal((await call('GET /shops/{shopId}/reservations', { as: newcomer, params: { shopId: 'shop-a' } })).status, 200);
  assert.equal((await grant(ownerA, 'shop-a', newcomer.id, null)).status, 200);
  assert.equal((await call('GET /shops/{shopId}/reservations', { as: newcomer, params: { shopId: 'shop-a' } })).status, 404, 'removal takes effect at once');
  assert.deepEqual((await call('GET /me', { as: newcomer })).body.shops, []);
  assert.equal((await grant(admin, 'shop-a', newcomer.id, 'owner')).status, 200, 'platform admins can fix a shop with no owner');
});

test('only platform admins open shops, and shop ids are unique', async () => {
  const { call } = await setup();
  const body = { id: 'shop-c', name: 'Shop C', ownerId: ownerA.id };
  assert.equal((await call('POST /admin/shops', { as: ownerA, body })).status, 403);
  assert.equal((await call('POST /admin/shops', { as: admin, body: { ...body, id: 'Shop C!' } })).status, 400);
  assert.equal((await call('POST /admin/shops', { as: admin, body })).status, 201);
  assert.equal((await call('POST /admin/shops', { as: admin, body })).status, 409);
  const me = (await call('GET /me', { as: ownerA })).body;
  assert.deepEqual(me.shops.map((shop) => [shop.shopId, shop.role]).sort(), [['shop-a', 'owner'], ['shop-c', 'owner']]);
});

test('a suspended shop takes no new reservations', async () => {
  const { reserve, db } = await setup();
  db.tables.tenancy.get(JSON.stringify(['SHOP', 'shop-a'])).status = 'suspended';
  assert.equal((await reserve(student)).status, 403);
  assert.equal(db.tables.items.get('a-1').stock, 5);
});

test('every staff action is recorded with who did it', async () => {
  const { reserve, act, call, db } = await setup();
  const hold = (await reserve(student)).body;
  await act(staffA, 'shop-a', hold.id, 'set-aside');
  await act(staffA, 'shop-a', hold.id, 'collect');
  await call('PUT /shops/{shopId}/items/{id}', { as: ownerA, params: { shopId: 'shop-a', id: 'a-2' }, body: { stock: 9, expectedVersion: 0 } });
  const trail = [...db.tables.tenancy.values()].filter((row) => row.pk === 'SHOP#shop-a' && row.sk.startsWith('AUDIT#'))
    .map(({ actor, action, target }) => [actor, action, target]);
  assert.deepEqual(trail, [
    [admin.id, 'shop-created', 'shop-a'], [ownerA.id, 'staff', staffA.id],
    [staffA.id, 'set-aside', hold.id], [staffA.id, 'collected', hold.id], [ownerA.id, 'recount', 'a-2'],
  ]);
  assert.ok([...db.tables.tenancy.values()].filter((row) => row.sk.startsWith('AUDIT#')).every((row) => row.expires > 0));
});

test('a recount is refused when stock changed and changed back since it was loaded', async () => {
  const { reserve, act, call, db } = await setup({ stock: 1 });
  const loaded = db.tables.items.get('a-1').version;
  const hold = (await reserve(student)).body; // stock 1 -> 0
  await act(staffA, 'shop-a', hold.id, 'release'); // stock 0 -> 1, the same number the shopkeeper saw
  const stale = await call('PUT /shops/{shopId}/items/{id}', { as: staffA, params: { shopId: 'shop-a', id: 'a-1' }, body: { stock: 4, expectedVersion: loaded } });
  assert.equal(stale.status, 409);
  const fresh = db.tables.items.get('a-1').version;
  assert.equal((await call('PUT /shops/{shopId}/items/{id}', { as: staffA, params: { shopId: 'shop-a', id: 'a-1' }, body: { stock: 4, expectedVersion: fresh } })).status, 200);
});

test('the migration moves pilot data into the pilot shop and can run again', async () => {
  const db = fakeDb([{ id: 'item-01', name: 'Mini drafter', stock: 2 }]);
  const held = { id: randomUUID(), itemId: 'item-01', code: '111111', status: 'HELD', createdAt: '2026-11-27T09:00:00.000Z' };
  const expired = { id: randomUUID(), itemId: 'item-01', code: '222222', status: 'EXPIRED', createdAt: '2026-11-25T09:00:00.000Z', expiresAt: '2026-11-26T09:00:00.000Z' };
  const done = { id: randomUUID(), itemId: 'item-01', code: '333333', status: 'COLLECTED', createdAt: '2026-11-25T09:00:00.000Z' };
  for (const r of [held, expired, done]) db.tables.reservations.set(r.id, r);
  const handler = makeHandler(db, {
    itemsTable: 'items', reservationsTable: 'reservations', tenancyTable: 'tenancy', shopKey: 'legacy-key-123456',
    defaultShopId: 'pilot', actorFrom: (event) => event.actor, now: () => new Date('2026-11-27T10:00:00Z'),
  });
  const call = async (routeKey, extra = {}) => JSON.parse((await handler({ routeKey, headers: { 'x-shop-key': 'legacy-key-123456' }, ...extra })).body);
  assert.deepEqual(await call('GET /items'), [], 'the catalog appears once the migration runs');
  const options = { shopId: 'pilot', name: 'Pilot shop', ownerId: ownerA.id };
  assert.deepEqual(await migrateToTenancy(db, tables, options), { shop: 1, owner: 1, items: 1, reservations: 3, skipped: 0 });
  assert.deepEqual(await migrateToTenancy(db, tables, options), { shop: 0, owner: 1, items: 0, reservations: 0, skipped: 0 });
  assert.deepEqual((await call('GET /items')).map((item) => [item.id, item.version]), [['item-01', 0]]);
  assert.deepEqual((await call('GET /shop/reservations')).map((r) => r.id).sort(), [held.id, expired.id].sort());
  assert.equal(db.tables.reservations.get(held.id).expiresAt, '2026-11-28T09:00:00.000Z');
  assert.deepEqual((await call('GET /me', { actor: ownerA, headers: {} })).shops, [{ shopId: 'pilot', name: 'Pilot shop', role: 'owner' }]);
  const collect = await handler({ routeKey: 'POST /shops/{shopId}/reservations/{id}/collect', actor: ownerA, pathParameters: { shopId: 'pilot', id: held.id }, headers: {} });
  assert.equal(collect.statusCode, 200, 'an anonymous pilot hold is collected by account');
});
