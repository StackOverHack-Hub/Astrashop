import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { makeHandler } from '../src/app.mjs';
import { fakeDb } from '../fake-db.mjs';
import { emfMetrics } from '../src/metrics.mjs';

const secret = 'whsec_test_only_value';
const admin = { id: randomUUID(), platformAdmin: true };
const owner = { id: randomUUID() };

async function setup({ razorpaySecret = secret } = {}) {
  const db = fakeDb([{ id: 'a-1', shopId: 'shop-a', name: 'Lab coat', price: 350, stock: 9, version: 0 }]);
  let clock = Date.parse('2026-11-30T10:00:00Z');
  const metrics = [];
  const handler = makeHandler(db, {
    itemsTable: 'items', reservationsTable: 'reservations', tenancyTable: 'tenancy', holdMinutes: 60, razorpaySecret,
    now: () => new Date(clock), actorFrom: (event) => event.actor, emit: (name, shopId) => metrics.push([name, shopId ?? null]),
  });
  const call = async (routeKey, { as, params, body, headers = {} } = {}) => {
    const res = await handler({ routeKey, actor: as, pathParameters: params, body: typeof body === 'string' ? body : body && JSON.stringify(body), headers });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  assert.equal((await call('POST /admin/shops', { as: admin, body: { id: 'shop-a', name: 'Shop A', ownerId: owner.id } })).status, 201);
  const event = (status, { shopId = 'shop-a', id = randomUUID(), createdAt = Math.floor(clock / 1000), name = `subscription.${status}` } = {}) => {
    const raw = JSON.stringify({
      event: name, created_at: createdAt,
      payload: { subscription: { entity: { id: 'sub_123', plan_id: 'plan_monthly', status, notes: { shopId } } } },
    });
    return call('POST /billing/razorpay', { body: raw, headers: { 'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'), 'x-razorpay-event-id': id } });
  };
  const shop = () => db.tables.tenancy.get(JSON.stringify(['SHOP', 'shop-a']));
  const ledger = (pk = 'SHOP#shop-a') => [...db.tables.tenancy.values()].filter((row) => row.pk === pk && row.sk.startsWith('BILLING#'));
  return { db, call, event, shop, ledger, metrics, handler, advance: (minutes) => { clock += minutes * 60_000; } };
}

test('Razorpay webhooks must carry a valid signature, and need a configured secret', async () => {
  const { call } = await setup();
  const raw = JSON.stringify({ event: 'subscription.activated', payload: {} });
  assert.equal((await call('POST /billing/razorpay', { body: raw })).status, 401);
  assert.equal((await call('POST /billing/razorpay', { body: raw, headers: { 'x-razorpay-signature': 'f'.repeat(64) } })).status, 401);
  const tampered = createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal((await call('POST /billing/razorpay', { body: raw.replace('activated', 'cancelled'), headers: { 'x-razorpay-signature': tampered } })).status, 401);
  const { call: unconfigured } = await setup({ razorpaySecret: null });
  assert.equal((await unconfigured('POST /billing/razorpay', { body: raw, headers: { 'x-razorpay-signature': tampered } })).status, 501);
});

test('a subscription’s status sets the shop’s, once per event, and every event is kept', async () => {
  const { event, shop, ledger, advance } = await setup();
  const id = randomUUID();
  assert.deepEqual((await event('active', { id })).body, { received: true, shopId: 'shop-a', status: 'active' });
  assert.equal(shop().status, 'active');
  assert.equal(shop().statusSource, 'billing');
  assert.deepEqual((await event('active', { id })).body, { received: true, duplicate: true }, 'Razorpay retries are recorded once');
  assert.equal(ledger().length, 1);
  advance(60);
  await event('pending');
  assert.equal(shop().status, 'active', 'a retrying payment keeps the shop open');
  advance(60);
  await event('halted', { name: 'subscription.halted' });
  assert.equal(shop().status, 'suspended');
  assert.deepEqual(ledger().map(({ event: name, subscriptionStatus }) => [name, subscriptionStatus]),
    [['subscription.active', 'active'], ['subscription.pending', 'pending'], ['subscription.halted', 'halted']]);
});

test('an older event arriving late does not undo a newer one', async () => {
  const { event, shop, ledger, advance } = await setup();
  const earlier = Math.floor(Date.parse('2026-11-30T10:00:00Z') / 1000);
  advance(120);
  await event('cancelled', { name: 'subscription.cancelled' });
  assert.equal(shop().status, 'suspended');
  const late = await event('active', { name: 'subscription.charged', createdAt: earlier });
  assert.equal(late.body.status, null);
  assert.equal(shop().status, 'suspended');
  assert.equal(ledger().length, 2, 'the late event is still recorded');
});

test('a shop an admin suspended stays suspended when a payment arrives', async () => {
  const { call, event, shop } = await setup();
  await call('PUT /admin/shops/{shopId}', { as: admin, params: { shopId: 'shop-a' }, body: { status: 'suspended' } });
  assert.equal((await event('active')).body.status, null);
  assert.equal(shop().status, 'suspended');
  assert.equal(shop().statusSource, 'admin');
});

test('a shop suspended before billing existed is not reopened by a payment', async () => {
  const { event, shop } = await setup();
  const row = shop();
  row.status = 'suspended'; // as Phase 2 left it: no statusSource
  delete row.statusSource;
  assert.equal((await event('active')).body.status, null);
  assert.equal(shop().status, 'suspended');
});

test('an event id that is not a plain token is replaced by a digest of the body', async () => {
  const { call, ledger } = await setup();
  const raw = JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: { status: 'active', notes: { shopId: 'shop-a' } } } } });
  const headers = { 'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'), 'x-razorpay-event-id': 'x'.repeat(5000) };
  assert.equal((await call('POST /billing/razorpay', { body: raw, headers })).status, 200);
  assert.match(ledger()[0].eventId, /^[a-f0-9]{64}$/);
});

test('events for an unknown shop are kept aside and acknowledged', async () => {
  const { event, ledger } = await setup();
  assert.deepEqual((await event('active', { shopId: 'no-such-shop' })).body, { received: true, shopId: null, status: null });
  assert.equal(ledger('BILLING#UNMATCHED').length, 1);
});

test('pickups are counted per shop per month for billing', async () => {
  const { call, advance } = await setup();
  const collect = async () => {
    const hold = (await call('POST /reservations', { as: { id: randomUUID() }, body: { id: randomUUID(), itemId: 'a-1' } })).body;
    assert.equal((await call('POST /shops/{shopId}/reservations/{id}/collect', { as: owner, params: { shopId: 'shop-a', id: hold.id } })).status, 200);
  };
  await collect();
  await collect();
  advance(24 * 60); // into December
  await collect();
  const [listed] = (await call('GET /admin/shops', { as: admin })).body;
  assert.deepEqual(listed.usage, [{ month: '2026-12', collected: 1 }, { month: '2026-11', collected: 2 }]);
});

test('a suspended shop’s owners can’t change it, but its counter finishes pickups', async () => {
  const { call } = await setup();
  const hold = (await call('POST /reservations', { as: { id: randomUUID() }, body: { id: randomUUID(), itemId: 'a-1' } })).body;
  await call('PUT /admin/shops/{shopId}', { as: admin, params: { shopId: 'shop-a' }, body: { status: 'suspended' } });
  const item = { id: randomUUID(), name: 'Goggles', price: 120, stock: 3 };
  assert.equal((await call('POST /shops/{shopId}/items', { as: owner, params: { shopId: 'shop-a' }, body: item })).status, 403);
  assert.equal((await call('POST /shops/{shopId}/invites', { as: owner, params: { shopId: 'shop-a' }, body: { role: 'staff' } })).status, 403);
  assert.equal((await call('POST /shops/{shopId}/reservations/{id}/collect', { as: owner, params: { shopId: 'shop-a', id: hold.id } })).status, 200);
  assert.equal((await call('POST /shops/{shopId}/items', { as: admin, params: { shopId: 'shop-a' }, body: item })).status, 201, 'support can still fix it');
});

test('platform admins set a plan without touching the status', async () => {
  const { call, shop } = await setup();
  const put = (body) => call('PUT /admin/shops/{shopId}', { as: admin, params: { shopId: 'shop-a' }, body });
  assert.equal((await put({ plan: 'Campus monthly' })).status, 200);
  assert.deepEqual([shop().plan, shop().status], ['Campus monthly', 'trial']);
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ plan: 'x'.repeat(41) })).status, 400);
  assert.equal((await put({ status: 'gone' })).status, 400);
});

test('reservations, hold limits, pickups and sweeps are counted as metrics', async () => {
  const { call, metrics, handler, advance } = await setup();
  const student = { id: randomUUID() };
  const holds = [];
  for (let n = 0; n < 4; n++) holds.push((await call('POST /reservations', { as: student, body: { id: randomUUID(), itemId: 'a-1' } })).body);
  await call('POST /shops/{shopId}/reservations/{id}/collect', { as: owner, params: { shopId: 'shop-a', id: holds[0].id } });
  advance(61);
  await handler({ source: 'aws.events' });
  assert.deepEqual(metrics, [
    ['ReservationCreated', 'shop-a'], ['ReservationCreated', 'shop-a'], ['ReservationCreated', 'shop-a'], ['HoldLimitHit', 'shop-a'],
    ['Collected', 'shop-a'], ['Expired', 'shop-a'], ['Expired', 'shop-a'], ['SweepRun', null],
  ]);
});

test('metric lines are in CloudWatch embedded metric format', () => {
  const lines = [];
  emfMetrics('Astrashop', (line) => lines.push(JSON.parse(line)))('Collected', 'shop-a');
  const [line] = lines;
  assert.deepEqual(line._aws.CloudWatchMetrics, [{ Namespace: 'Astrashop', Dimensions: [[], ['shopId']], Metrics: [{ Name: 'Collected', Unit: 'Count' }] }]);
  assert.equal(line.shopId, 'shop-a');
  assert.equal(line.Collected, 1);
  assert.ok(Number.isSafeInteger(line._aws.Timestamp));
});
