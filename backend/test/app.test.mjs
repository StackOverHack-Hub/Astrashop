import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHandler } from '../src/app.mjs';
import { fakeDb } from '../fake-db.mjs';

const SHOP = 'test-shop-key';
function setup(stock = 1, options) {
  const db = fakeDb([{ id: 'item-1', name: 'Mini drafter', stock }], options);
  let clock = Date.parse('2026-11-26T10:00:00Z');
  const handler = makeHandler(db, {
    itemsTable: 'items', reservationsTable: 'reservations', shopKey: SHOP, holdMinutes: 60, now: () => new Date(clock),
  });
  const advance = (minutes) => { clock += minutes * 60_000; };
  const sweep = () => handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' });
  const call = async (routeKey, { body, params, shop } = {}) => {
    const res = await handler({
      routeKey,
      body: body && JSON.stringify(body),
      pathParameters: params,
      headers: shop ? { 'x-shop-key': SHOP } : {},
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const stockLeft = () => db.tables.items.get('item-1').stock;
  return { call, stockLeft, db, advance, sweep };
}

const counts = (expired, deferred = 0) => ({ expired, deferred, failed: 0 });

test('a database connection failure returns a retryable response', async () => {
  const { call, db } = setup();
  db.send = async () => { throw Object.assign(new Error('Connection failed'), { code: 'ECONNREFUSED' }); };
  assert.equal((await call('GET /items')).status, 503);
  assert.equal((await call('POST /reservations', { body: { id: randomUUID(), itemId: 'item-1' } })).status, 503);
});

test('a hold expires after the hold window and its unit returns to the shelf', async () => {
  const { call, stockLeft, advance, sweep } = setup(1);
  const id = randomUUID();
  const { body } = await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  assert.equal(body.expiresAt, '2026-11-26T11:00:00.000Z');
  advance(59);
  assert.deepEqual(await sweep(), counts(0));
  assert.equal(stockLeft(), 0);
  advance(2);
  assert.deepEqual(await sweep(), counts(1));
  assert.equal(stockLeft(), 1);
  assert.equal((await call('GET /reservations/{id}', { params: { id } })).body.status, 'EXPIRED');
  assert.deepEqual(await sweep(), counts(0), 'a second sweep must not restock twice');
  assert.equal(stockLeft(), 1);
  assert.equal((await call('POST /shop/reservations/{id}/collect', { params: { id }, shop: true })).status, 409);
});

test('expired holds stay on the shop list until marked back on the shelf', async () => {
  const { call, advance, sweep, stockLeft } = setup(1);
  const id = randomUUID();
  await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  const returned = () => call('POST /shop/reservations/{id}/returned', { params: { id }, shop: true });
  assert.equal((await returned()).status, 409, 'a live hold cannot be marked returned');
  advance(61);
  await sweep();
  advance(3 * 24 * 60); // shop closed for three days
  const listed = (await call('GET /shop/reservations', { shop: true })).body;
  assert.deepEqual(listed.map((r) => [r.id, r.status]), [[id, 'EXPIRED']]);
  assert.equal((await returned()).status, 200);
  assert.equal((await returned()).status, 200, 'repeating it is harmless');
  assert.deepEqual((await call('GET /shop/reservations', { shop: true })).body, []);
  assert.equal(stockLeft(), 1, 'marking returned does not restock again');
});

test('a hold made before expiry existed still expires from its createdAt', async () => {
  const { call, advance, sweep, stockLeft, db } = setup(1);
  const id = randomUUID();
  await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  delete db.tables.reservations.get(id).expiresAt; // pre-upgrade row
  advance(59);
  assert.deepEqual(await sweep(), counts(0));
  advance(2);
  assert.deepEqual(await sweep(), counts(1));
  assert.equal(stockLeft(), 1);
});

test('expiry skips collected holds and defers busy ones', async () => {
  const { call, stockLeft, advance, sweep, db } = setup(2);
  const collected = randomUUID();
  const busy = randomUUID();
  await call('POST /reservations', { body: { id: collected, itemId: 'item-1' } });
  await call('POST /reservations', { body: { id: busy, itemId: 'item-1' } });
  await call('POST /shop/reservations/{id}/collect', { params: { id: collected }, shop: true });
  advance(120);
  db.failNext = 'TransactionConflict';
  assert.deepEqual(await sweep(), counts(0, 1));
  assert.equal(stockLeft(), 0);
  assert.deepEqual(await sweep(), counts(1), 'the busy hold expires on the next run');
  assert.equal(stockLeft(), 1);
});

test('a hold that cannot expire fails the run so the alarm fires', async () => {
  const { call, advance, sweep, db, stockLeft } = setup(1);
  const id = randomUUID();
  await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  advance(61);
  db.failNext = 'ValidationError'; // e.g. the item row is missing after a partial restore
  await assert.rejects(sweep(), /could not expire/);
  assert.equal((await call('GET /reservations/{id}', { params: { id } })).body.status, 'HELD');
  assert.equal(stockLeft(), 0);
});

test('two students racing for the last unit get exactly one hold', async () => {
  const { call, stockLeft } = setup(1);
  const results = await Promise.all([
    call('POST /reservations', { body: { id: randomUUID(), itemId: 'item-1' } }),
    call('POST /reservations', { body: { id: randomUUID(), itemId: 'item-1' } }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(stockLeft(), 0);
});

test('a retry with the same id returns the same hold and takes one unit', async () => {
  const { call, stockLeft } = setup(2);
  const id = randomUUID();
  const first = await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  const retry = await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.code, first.body.code);
  assert.equal(stockLeft(), 1);
});

test('a retry still returns the hold after the item sells out', async () => {
  const { call } = setup(1);
  const id = randomUUID();
  await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  const retry = await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  assert.equal(retry.status, 200);
});

test('out of stock and bad input are rejected', async () => {
  const { call } = setup(0);
  assert.equal((await call('POST /reservations', { body: { id: randomUUID(), itemId: 'item-1' } })).status, 409);
  assert.equal((await call('POST /reservations', { body: { id: 'not-a-uuid', itemId: 'item-1' } })).status, 400);
});

test('shop routes need the shop key', async () => {
  const { call } = setup(1);
  assert.equal((await call('GET /shop/reservations')).status, 401);
  assert.equal((await call('GET /shop/reservations', { shop: true })).status, 200);
});

test('releasing twice puts the unit back only once', async () => {
  const { call, stockLeft } = setup(1);
  const id = randomUUID();
  await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  assert.equal((await call('POST /shop/reservations/{id}/release', { params: { id }, shop: true })).status, 200);
  assert.equal((await call('POST /shop/reservations/{id}/release', { params: { id }, shop: true })).status, 409);
  assert.equal(stockLeft(), 1);
});

test('a collected item cannot be released', async () => {
  const { call, stockLeft } = setup(1);
  const id = randomUUID();
  await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  assert.equal((await call('POST /shop/reservations/{id}/collect', { params: { id }, shop: true })).status, 200);
  assert.equal((await call('POST /shop/reservations/{id}/release', { params: { id }, shop: true })).status, 409);
  assert.equal(stockLeft(), 0);
  assert.equal((await call('GET /reservations/{id}', { params: { id } })).body.status, 'COLLECTED');
});

test('shopkeeper sets stock and confirms the time', async () => {
  const { call, stockLeft } = setup(1);
  const put = (id, body) => call('PUT /shop/items/{id}', { params: { id }, body, shop: true });
  assert.equal((await put('item-1', { stock: 7, expectedStock: 1 })).status, 200);
  assert.equal(stockLeft(), 7);
  assert.equal((await put('nope', { stock: 1, expectedStock: 0 })).status, 404);
  assert.equal((await put('item-1', { stock: -1, expectedStock: 7 })).status, 400);
  assert.equal((await put('item-1', { stock: 2 ** 53, expectedStock: 7 })).status, 400);
  assert.equal((await put('item-1', { stock: 3 })).status, 400);
});

test('a recount made before a reservation landed is rejected', async () => {
  const { call, stockLeft } = setup(1);
  // Shopkeeper loaded stock = 1, then a student reserved that unit before the recount arrived.
  await call('POST /reservations', { body: { id: randomUUID(), itemId: 'item-1' } });
  const stale = await call('PUT /shop/items/{id}', { params: { id: 'item-1' }, body: { stock: 1, expectedStock: 1 }, shop: true });
  assert.equal(stale.status, 409);
  assert.equal(stockLeft(), 0);
});

test('a throttled reserve says busy, not sold out', async () => {
  const { call, db, stockLeft } = setup(3);
  db.failNext = 'ThrottlingError';
  assert.equal((await call('POST /reservations', { body: { id: randomUUID(), itemId: 'item-1' } })).status, 503);
  assert.equal(stockLeft(), 3);
});

test('a conflicting release says busy and leaves the hold', async () => {
  const { call, db, stockLeft } = setup(1);
  const id = randomUUID();
  await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  db.failNext = 'TransactionConflict';
  assert.equal((await call('POST /shop/reservations/{id}/release', { params: { id }, shop: true })).status, 503);
  assert.equal((await call('GET /reservations/{id}', { params: { id } })).body.status, 'HELD');
  assert.equal(stockLeft(), 0);
});

test('held reservations on later scan pages still reach the shop', async () => {
  const { call } = setup(5, { pageSize: 1 });
  const collected = randomUUID();
  for (const id of [collected, randomUUID(), randomUUID()]) {
    await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  }
  await call('POST /shop/reservations/{id}/collect', { params: { id: collected }, shop: true });
  assert.equal((await call('GET /shop/reservations', { shop: true })).body.length, 2);
});

test('oversized ids and non-uuid paths are rejected before the database', async () => {
  const { call } = setup(1);
  assert.equal((await call('POST /reservations', { body: { id: randomUUID(), itemId: 'x'.repeat(3000) } })).status, 400);
  assert.equal((await call('GET /reservations/{id}', { params: { id: 'abc' } })).status, 404);
  assert.equal((await call('POST /shop/reservations/{id}/collect', { params: { id: 'abc' }, shop: true })).status, 404);
});

test('the shop confirms a hold is set aside once, then collects it', async () => {
  const { call, advance } = setup(1);
  const id = randomUUID();
  const setAside = () => call('POST /shop/reservations/{id}/set-aside', { params: { id }, shop: true });
  assert.equal((await setAside()).status, 409, 'an unknown hold is not on hold (same as collect)');
  await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  assert.equal((await call('POST /shop/reservations/{id}/set-aside', { params: { id } })).status, 401);
  advance(4);
  assert.equal((await setAside()).status, 200);
  const first = (await call('GET /reservations/{id}', { params: { id } })).body.setAsideAt;
  assert.equal(first, '2026-11-26T10:04:00.000Z');
  advance(3);
  assert.equal((await setAside()).status, 200, 'pressing it again is harmless');
  assert.equal((await call('GET /reservations/{id}', { params: { id } })).body.setAsideAt, first, 'keeps the first time');
  assert.equal((await call('POST /shop/reservations/{id}/collect', { params: { id }, shop: true })).status, 200);
  assert.equal((await setAside()).status, 409, 'a collected hold cannot be set aside');
  assert.equal((await call('GET /shop/stats')).status, 401, 'stats need the shop key');
});

test('pilot numbers count outcomes and median times', async () => {
  const { call, advance, sweep } = setup(5, { pageSize: 1 });
  const stats = async () => (await call('GET /shop/stats', { shop: true })).body;
  assert.equal((await stats()).medianMinutesToSetAside, null);
  const [a, b, c, walkUp, released] = Array.from({ length: 5 }, () => randomUUID());
  for (const id of [a, b, c, walkUp, released]) await call('POST /reservations', { body: { id, itemId: 'item-1' } });
  advance(5);
  await call('POST /shop/reservations/{id}/set-aside', { params: { id: a }, shop: true });
  await call('POST /shop/reservations/{id}/release', { params: { id: released }, shop: true });
  advance(5);
  await call('POST /shop/reservations/{id}/set-aside', { params: { id: b }, shop: true });
  await call('POST /shop/reservations/{id}/collect', { params: { id: walkUp }, shop: true });
  assert.equal((await stats()).waitingToSetAside, 1);
  advance(10);
  await call('POST /shop/reservations/{id}/collect', { params: { id: a }, shop: true });
  advance(60);
  await sweep(); // b and c are past their 60-minute hold
  assert.deepEqual(await stats(), {
    reservations: 5, waitingToSetAside: 0, setAside: 2, collected: 2, expired: 2, released: 1,
    medianMinutesToSetAside: 7.5, medianMinutesToCollect: 15, since: '2026-11-26T10:00:00.000Z',
  });
});
