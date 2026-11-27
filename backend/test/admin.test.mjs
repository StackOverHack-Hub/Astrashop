import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHandler } from '../src/app.mjs';
import { fakeDb } from '../fake-db.mjs';

const admin = { id: randomUUID(), platformAdmin: true };
const owner = { id: randomUUID() };
const otherOwner = { id: randomUUID() };
const student = { id: randomUUID() };

async function setup() {
  const db = fakeDb([]);
  let clock = Date.parse('2026-11-27T10:00:00Z');
  const handler = makeHandler(db, {
    itemsTable: 'items', reservationsTable: 'reservations', tenancyTable: 'tenancy',
    now: () => new Date(clock), actorFrom: (event) => event.actor,
  });
  const call = async (routeKey, { as, params, body, query } = {}) => {
    const res = await handler({ routeKey, actor: as, pathParameters: params, queryStringParameters: query, body: body && JSON.stringify(body), headers: {} });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  assert.equal((await call('POST /admin/shops', { as: admin, body: { id: 'shop-a', name: 'Shop A', pickupWindow: 'Mon–Fri', ownerId: owner.id } })).status, 201);
  assert.equal((await call('POST /admin/shops', { as: admin, body: { id: 'shop-b', name: 'Shop B', ownerId: otherOwner.id } })).status, 201);
  const addItem = (as = owner, body = {}, shopId = 'shop-a') => call('POST /shops/{shopId}/items', {
    as, params: { shopId }, body: { id: randomUUID(), name: 'Lab coat', course: 'Chemistry Lab', price: 350, stock: 4, ...body },
  });
  const invite = (as, role = 'staff', shopId = 'shop-a') => call('POST /shops/{shopId}/invites', { as, params: { shopId }, body: { role } });
  const accept = (as, token, name = 'New hire') => call('POST /invites/accept', { as, body: { token, name } });
  return { db, call, addItem, invite, accept, advance: (minutes) => { clock += minutes * 60_000; } };
}

test('owners add, edit and take items off sale; students see only what is on sale', async () => {
  const { call, addItem } = await setup();
  const id = randomUUID();
  const created = await addItem(owner, { id });
  assert.equal(created.status, 201);
  assert.equal(created.body.pickupWindow, 'Mon–Fri', 'new items take the shop hours');
  assert.equal((await addItem(owner, { id })).status, 200, 'a retried create returns the same item');
  assert.equal((await addItem(owner, { id, name: 'Something else' })).status, 409);
  assert.equal((await addItem(owner, { price: -1 })).status, 400);
  assert.equal((await addItem(owner, { name: 'x' })).status, 400);
  assert.equal((await addItem(otherOwner)).status, 404, 'another shop cannot add to this one');
  const publicCatalog = async () => (await call('GET /shops/{shopId}/items', { params: { shopId: 'shop-a' } })).body.map((item) => item.id);
  assert.deepEqual(await publicCatalog(), [id]);

  const edit = (body) => call('PUT /shops/{shopId}/items/{id}/details', {
    as: owner, params: { shopId: 'shop-a', id }, body: { name: 'Lab coat, size M', course: 'Chemistry Lab', price: 380, active: false, expectedVersion: 0, ...body },
  });
  assert.equal((await edit({})).status, 200);
  assert.equal((await edit({})).status, 409, 'an edit from a stale screen is refused');
  assert.deepEqual(await publicCatalog(), [], 'hidden items leave the public catalog');
  const counter = (await call('GET /shops/{shopId}/catalog', { as: owner, params: { shopId: 'shop-a' } })).body;
  assert.deepEqual(counter.map(({ name, price, active }) => [name, price, active]), [['Lab coat, size M', 380, false]]);
  const reserve = await call('POST /reservations', { as: student, body: { id: randomUUID(), itemId: id } });
  assert.equal(reserve.status, 409);
  assert.equal(reserve.body.code, 'UNAVAILABLE');
  assert.equal((await edit({ active: true, expectedVersion: 1 })).status, 200);
  assert.equal((await call('POST /reservations', { as: student, body: { id: randomUUID(), itemId: id } })).status, 201);
});

test('staff count stock but only owners change the catalog', async () => {
  const { call, addItem, invite, accept } = await setup();
  const clerk = { id: randomUUID() };
  await accept(clerk, (await invite(owner)).body.token);
  assert.equal((await addItem(clerk)).status, 403);
  assert.equal((await call('GET /shops/{shopId}/catalog', { as: clerk, params: { shopId: 'shop-a' } })).status, 200);
  assert.equal((await invite(clerk)).status, 403);
  assert.equal((await call('GET /shops/{shopId}/audit', { as: clerk, params: { shopId: 'shop-a' } })).status, 403);
  assert.equal((await call('PUT /shops/{shopId}', { as: clerk, params: { shopId: 'shop-a' }, body: { name: 'Mine now' } })).status, 403);
});

test('an invite link adds one person, once, before it expires', async () => {
  const { call, invite, accept, advance } = await setup();
  const clerk = { id: randomUUID() };
  const latecomer = { id: randomUUID() };
  const { token, expiresAt } = (await invite(owner)).body;
  assert.equal(expiresAt, '2026-12-04T10:00:00.000Z');
  assert.equal((await accept(owner, token)).status, 409, 'an owner cannot demote themselves through a staff invite');
  const joined = await accept(clerk, token, 'Priya at the counter');
  assert.deepEqual(joined.body, { shopId: 'shop-a', name: 'Shop A', role: 'staff' });
  assert.equal((await accept(latecomer, token)).status, 404, 'a used link stops working');
  assert.equal((await accept(latecomer, 'x'.repeat(32))).status, 404);
  assert.equal((await accept(latecomer, 'short')).status, 400);
  const stale = (await invite(owner)).body.token;
  advance(7 * 24 * 60 + 1);
  assert.equal((await accept(latecomer, stale)).status, 404, 'an expired link stops working');
  const staff = (await call('GET /shops/{shopId}/staff', { as: owner, params: { shopId: 'shop-a' } })).body;
  assert.deepEqual(staff.map(({ userId, role, name }) => [userId, role, name]).sort(),
    [[owner.id, 'owner', ''], [clerk.id, 'staff', 'Priya at the counter']].sort());
  assert.equal((await call('GET /shops/{shopId}/reservations', { as: clerk, params: { shopId: 'shop-a' } })).status, 200);
});

test('platform admins open a shop and hand it over with an owner invite', async () => {
  const { call, invite, accept } = await setup();
  const keeper = { id: randomUUID() };
  assert.equal((await call('POST /admin/shops', { as: admin, body: { id: 'shop-c', name: 'Shop C' } })).status, 201);
  assert.equal((await invite(owner, 'owner', 'shop-c')).status, 404, 'owners of other shops cannot invite');
  const { token } = (await invite(admin, 'owner', 'shop-c')).body;
  assert.equal((await accept(keeper, token)).status, 200);
  assert.deepEqual((await call('GET /me', { as: keeper })).body.shops, [{ shopId: 'shop-c', name: 'Shop C', role: 'owner', status: 'trial', pickupWindow: '' }]);
  const shops = (await call('GET /admin/shops', { as: admin })).body;
  assert.deepEqual(shops.map(({ id, status }) => [id, status]), [['shop-a', 'trial'], ['shop-b', 'trial'], ['shop-c', 'trial']]);
  assert.equal((await call('GET /admin/shops', { as: owner })).status, 403);
});

test('suspending a shop stops new reservations and owners can rename their shop', async () => {
  const { call, addItem } = await setup();
  const { id } = (await addItem()).body;
  const status = (as, value, shopId = 'shop-a') => call('PUT /admin/shops/{shopId}', { as, params: { shopId }, body: { status: value } });
  assert.equal((await status(owner, 'active')).status, 403);
  assert.equal((await status(admin, 'closed')).status, 400);
  assert.equal((await status(admin, 'active', 'no-such-shop')).status, 404);
  assert.equal((await status(admin, 'suspended')).status, 200);
  assert.equal((await call('POST /reservations', { as: student, body: { id: randomUUID(), itemId: id } })).status, 403);
  assert.equal((await status(admin, 'active')).status, 200);
  assert.equal((await call('POST /reservations', { as: student, body: { id: randomUUID(), itemId: id } })).status, 201);
  assert.equal((await call('PUT /shops/{shopId}', { as: owner, params: { shopId: 'shop-a' }, body: { name: 'Stationery Corner', pickupWindow: 'Mon–Sat' } })).status, 200);
  assert.equal((await call('GET /me', { as: owner })).body.shops[0].name, 'Stationery Corner', 'the new name shows everywhere at once');
});

test('the activity log pages newest first and its cursor cannot reach another shop', async () => {
  const { call, addItem, advance } = await setup();
  for (let n = 0; n < 52; n++) {
    advance(1);
    await addItem(owner, { name: `Item ${String(n).padStart(2, '0')}` });
  }
  const page = (query) => call('GET /shops/{shopId}/audit', { as: owner, params: { shopId: 'shop-a' }, query });
  const first = (await page()).body;
  assert.equal(first.entries.length, 50);
  assert.equal(first.entries[0].detail.name, 'Item 51');
  const second = (await page({ cursor: first.next })).body;
  assert.deepEqual(second.entries.map(({ action }) => action), ['item-created', 'item-created', 'shop-created']);
  assert.equal(second.next, null);
  const foreign = Buffer.from(JSON.stringify({ pk: 'SHOP#shop-b', sk: 'AUDIT#9999' })).toString('base64url');
  assert.equal((await page({ cursor: foreign })).status, 400);
  assert.equal((await page({ cursor: 'not json' })).status, 400);
});

test('stats cover a window of days', async () => {
  const { call, addItem, advance } = await setup();
  const { id } = (await addItem()).body;
  await call('POST /reservations', { as: student, body: { id: randomUUID(), itemId: id } });
  advance(10 * 24 * 60);
  await call('POST /reservations', { as: { id: randomUUID() }, body: { id: randomUUID(), itemId: id } });
  const stats = (query) => call('GET /shops/{shopId}/stats', { as: owner, params: { shopId: 'shop-a' }, query });
  assert.equal((await stats()).body.reservations, 2);
  assert.equal((await stats({ days: '7' })).body.reservations, 1);
  assert.equal((await stats({ days: '0' })).status, 400);
  assert.equal((await stats({ days: 'all' })).status, 400);
});

test('/me tells the console which sections to show', async () => {
  const { call } = await setup();
  const moderator = { id: randomUUID(), moderator: true };
  assert.deepEqual((await call('GET /me', { as: moderator })).body, { id: moderator.id, platformAdmin: false, moderator: true, shops: [] });
  assert.equal((await call('GET /me', { as: admin })).body.platformAdmin, true);
});
