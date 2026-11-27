import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHandler } from '../src/app.mjs';
import { fakeDb } from '../fake-db.mjs';
import { memoryPhotos } from '../src/photo-store.mjs';

const admin = { id: randomUUID(), platformAdmin: true };
const owner = { id: randomUUID() };
const student = { id: randomUUID() };
const jpeg = (size = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 7)]);

async function setup({ photos = memoryPhotos('https://photos.example') } = {}) {
  const db = fakeDb([{ id: 'item-01', shopId: 'campus-shop', name: 'Mini drafter', price: 450, stock: 5, pickupWindow: 'Mon–Sat' }]);
  let clock = Date.parse('2026-11-27T10:00:00Z');
  const handler = makeHandler(db, {
    itemsTable: 'items', reservationsTable: 'reservations', tenancyTable: 'tenancy', defaultShopId: 'campus-shop',
    now: () => new Date(clock), actorFrom: (event) => event.actor, photos,
  });
  const call = async (routeKey, { as, params, body } = {}) => {
    const res = await handler({ routeKey, actor: as, pathParameters: params, body: body && JSON.stringify(body), headers: {} });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  for (const [id, name] of [['campus-shop', 'Campus stationery shop'], ['annex', 'Annex store'], ['closed', 'Closed shop']]) {
    assert.equal((await call('POST /admin/shops', { as: admin, body: { id, name, ownerId: owner.id } })).status, 201);
  }
  await call('PUT /admin/shops/{shopId}', { as: admin, params: { shopId: 'closed' }, body: { status: 'suspended' } });
  const upload = (data, as = owner, id = 'item-01', shopId = 'campus-shop') =>
    call('PUT /shops/{shopId}/items/{id}/photo', { as, params: { shopId, id }, body: { data } });
  return { db, call, upload, photos, advance: (minutes) => { clock += minutes * 60_000; } };
}

test('students see the shops they can reserve from, the default shop first', async () => {
  const { call } = await setup();
  assert.deepEqual((await call('GET /shops')).body, [
    { id: 'campus-shop', name: 'Campus stationery shop', pickupWindow: '', default: true },
    { id: 'annex', name: 'Annex store', pickupWindow: '', default: false },
  ]);
});

test('a student’s passes follow their account to any device', async () => {
  const { call, advance } = await setup();
  assert.equal((await call('GET /me/reservations')).status, 401);
  const first = (await call('POST /reservations', { as: student, body: { id: randomUUID(), itemId: 'item-01' } })).body;
  advance(5);
  const second = (await call('POST /reservations', { as: student, body: { id: randomUUID(), itemId: 'item-01' } })).body;
  await call('POST /reservations', { as: { id: randomUUID() }, body: { id: randomUUID(), itemId: 'item-01' } });
  const passes = (await call('GET /me/reservations', { as: student })).body;
  assert.deepEqual(passes.map(({ id }) => id), [second.id, first.id], 'newest first, and only this student’s');
  assert.deepEqual([passes[0].itemName, passes[0].pickupWindow, passes[0].code], ['Mini drafter', 'Mon–Sat', second.code]);
  assert.equal(passes[0].studentId, undefined);
});

test('owners add a photo; students see it; only real images under 600 KB are kept', async () => {
  const { call, upload, photos } = await setup();
  const uploaded = await upload(jpeg().toString('base64'));
  assert.equal(uploaded.status, 200);
  assert.match(uploaded.body.photoUrl, /^https:\/\/photos\.example\/items\/campus-shop\/[a-f0-9]{64}\.jpg$/);
  assert.equal(photos.files.size, 1);
  const publicItem = (await call('GET /items')).body.find(({ id }) => id === 'item-01');
  assert.equal(publicItem.photoUrl, uploaded.body.photoUrl);
  assert.equal((await upload(Buffer.from('<html><script>alert(1)</script></html>').toString('base64'))).status, 400, 'not an image');
  assert.equal((await upload(jpeg(600_001).toString('base64'))).status, 400, 'too big');
  assert.equal((await upload(42)).status, 400);
  assert.equal((await upload(jpeg().toString('base64'), student)).status, 404, 'students have no role at the shop');
  assert.equal((await upload(jpeg().toString('base64'), owner, 'item-01', 'annex')).status, 404, 'the item belongs to another shop');
  const removed = await upload(null);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.photoUrl, undefined);
  assert.equal((await call('GET /items')).body[0].photoUrl, undefined);
});

test('a server without photo storage says so instead of failing', async () => {
  const { upload } = await setup({ photos: null });
  assert.equal((await upload(jpeg().toString('base64'))).status, 501);
});
