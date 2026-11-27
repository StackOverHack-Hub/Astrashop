import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.STRESS_URL ?? 'http://127.0.0.1:18080';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) throw new Error('Stress tests are restricted to loopback');
const pairs = Number(process.env.STRESS_PAIRS ?? 12);
assert.ok(Number.isInteger(pairs) && pairs >= 1 && pairs <= 30);
const run = randomUUID().slice(0, 8);
const stats = { run, users: pairs * 2, flows: 0, requests: 0, statuses: {}, latencies: [], failures: [] };
const start = performance.now();
async function call(path, { actor, method = 'GET', body, raw, expected = [200], retry = true, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    const at = performance.now();
    const response = await fetch(`${base}/api${path}`, {
      method, headers: { ...(actor !== undefined ? { authorization: `Bearer demo-stress-${actor}` } : {}),
        ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(12_000),
    });
    stats.requests++;
    stats.statuses[response.status] = (stats.statuses[response.status] ?? 0) + 1;
    stats.latencies.push(performance.now() - at);
    const data = await response.json();
    if ([429, 503].includes(response.status) && retry && attempt < 120) {
      const wait = Math.min(10, Math.max(1, Number(response.headers.get('retry-after')) || 2));
      await delay(wait * 1000 + Math.floor(Math.random() * 250));
      continue;
    }
    assert.ok(expected.includes(response.status), `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
    return { status: response.status, body: data };
  }
}

async function flow(index) {
  const seller = index * 2;
  const buyer = seller + 1;
  for (const [actor, role] of [[seller, 'Seller'], [buyer, 'Buyer']]) {
    await call('/marketplace/profile', { actor, method: 'PUT', body: { name: `${role} ${run} ${index}`, programme: 'Local stress test' }, expected: [200, 201] });
  }
  const listing = { id: randomUUID(), kind: ['item', 'service', 'favor'][index % 3], title: `Stress ${run} ${index}`,
    description: 'Local concurrent exchange test. No real transaction.', meetup: 'Library courtyard', pricePaise: index % 3 ? 0 : 25000 };
  // Two nearly simultaneous submits model fast repeated clicks.
  const publish = () => call('/marketplace/listings', { actor: seller, method: 'POST', body: listing, expected: [200, 201] });
  const published = await Promise.all([publish(), publish()]);
  assert.equal(published.filter(({ status }) => status === 201).length, 1);
  assert.equal((await call(`/marketplace/listings/${listing.id}`)).body.title, listing.title);
  const edit = { ...listing, title: `${listing.title} updated`, version: 1, status: 'active', requestId: randomUUID() };
  const save = () => call(`/marketplace/listings/${listing.id}`, { actor: seller, method: 'PUT', body: edit });
  const edits = await Promise.all([save(), save()]);
  assert.ok(edits.every(({ body }) => body.version === 2));
  await call(`/marketplace/listings/${listing.id}`, { actor: buyer, method: 'PUT', body: edit, expected: [404] });
  const contact = { id: randomUUID(), text: 'Can we arrange pickup after class?' };
  const open = () => call(`/marketplace/listings/${listing.id}/contact`, { actor: buyer, method: 'POST', body: contact, expected: [200, 201] });
  const threads = await Promise.all([open(), open()]);
  assert.equal(threads[0].body.id, threads[1].body.id);
  const thread = threads[0].body.id;
  await call(`/marketplace/threads/${thread}`, { actor: 62, expected: [404] });
  const reply = { id: randomUUID(), text: 'Yes, meet at the library courtyard.' };
  const send = () => call(`/marketplace/threads/${thread}`, { actor: seller, method: 'POST', body: reply, expected: [200, 201] });
  await Promise.all([send(), send()]);
  assert.equal((await call(`/marketplace/threads/${thread}`, { actor: buyer })).body.entries.length, 2);
  const comment = { id: randomUUID(), text: 'Is this still available?' };
  await call(`/marketplace/listings/${listing.id}/comments`, { actor: buyer, method: 'POST', body: comment, expected: [201] });
  await call(`/marketplace/saved/${listing.id}`, { actor: buyer, method: 'PUT', body: { saved: true } });
  await call(`/marketplace/threads/${thread}/review`, { actor: buyer, method: 'POST', body: { rating: 5, text: 'Too early' }, expected: [409] });
  await Promise.all([seller, buyer].map((actor) => call(`/marketplace/threads/${thread}/exchange`, { actor, method: 'PUT', body: {} })));
  const exchange = (await call(`/marketplace/threads/${thread}/exchange`, { actor: buyer })).body;
  assert.equal(exchange.completed, true);
  const review = { rating: 5, text: 'A successful local test exchange.' };
  const rate = () => call(`/marketplace/threads/${thread}/review`, { actor: buyer, method: 'POST', body: review, expected: [200, 201] });
  await Promise.all([rate(), rate()]);
  const profile = (await call('/marketplace/profile', { actor: seller })).body.profile;
  assert.equal(profile.ratingCount, 1);
  assert.equal(profile.averageRating, 5);
  const details = (await call(`/marketplace/listings/${listing.id}`)).body;
  assert.equal(details.status, listing.kind === 'item' ? 'closed' : 'active');
  if (listing.kind !== 'item') {
    const close = { version: 2, status: 'closed', requestId: randomUUID() };
    await call(`/marketplace/listings/${listing.id}`, { actor: seller, method: 'PUT', body: close });
  }
  const offers = (await call(`/marketplace/sellers/${profile.id}/listings`)).body;
  assert.equal(offers.entries.length, 0);
  stats.flows++;
  console.log(`Completed buyer/seller flow ${index + 1}/${pairs}`);
}

async function shopFlow() {
  const headers = { 'x-shop-key': process.env.STRESS_SHOP_KEY ?? 'local-shop-key' };
  // Reserving needs a signed-in student: 16 students race for the last unit.
  const racers = Array.from({ length: 16 }, (_, n) => attacker(n));
  const results = await Promise.all(racers.map((actor) => call('/reservations', {
    actor, method: 'POST', body: { id: randomUUID(), itemId: 'item-08' }, expected: [201, 409],
  })));
  const winners = results.filter(({ status }) => status === 201);
  assert.equal(winners.length, 1);
  const hold = winners[0].body;
  const winner = racers[results.indexOf(winners[0])];
  await call('/reservations', { method: 'POST', body: { id: randomUUID(), itemId: 'item-08' }, expected: [401] });
  await Promise.all(Array.from({ length: 4 }, () => call('/reservations', {
    actor: winner, method: 'POST', body: { id: hold.id, itemId: hold.itemId }, expected: [200],
  })));
  assert.match(hold.code, /^\d{6}$/);
  assert.equal((await call('/items')).body.find(({ id }) => id === 'item-08').stock, 0);
  await call('/shop/reservations', { expected: [401] });
  await call('/shop/items/item-08', { method: 'PUT', headers, body: { stock: 1, expectedStock: 1 }, expected: [409] });
  await call('/shop/items/item-08', { method: 'PUT', headers, body: { stock: -1, expectedStock: 0 }, expected: [400] });
  await Promise.all(Array.from({ length: 2 }, () => call(`/shop/reservations/${hold.id}/set-aside`, { method: 'POST', headers })));
  assert.ok((await call(`/reservations/${hold.id}`)).body.setAsideAt);
  await call(`/shop/reservations/${hold.id}/collect`, { method: 'POST', headers });
  await call(`/shop/reservations/${hold.id}/release`, { method: 'POST', headers, expected: [409] });
  const releaseId = randomUUID();
  const before = (await call('/items')).body.find(({ id }) => id === 'item-01').stock;
  await call('/reservations', { actor: 60, method: 'POST', body: { id: releaseId, itemId: 'item-01' }, expected: [201] });
  await Promise.all(Array.from({ length: 3 }, () => call(`/shop/reservations/${releaseId}/release`, {
    method: 'POST', headers, expected: [200, 409],
  })));
  assert.equal((await call('/items')).body.find(({ id }) => id === 'item-01').stock, before);
  const dashboard = (await call('/shop/stats', { headers })).body;
  assert.equal(dashboard.collected, 1);
  assert.equal(dashboard.released, 1);
  console.log('Completed shop last-unit, pickup, collection and duplicate-release flow');
}

async function contestedItem() {
  const listing = { id: randomUUID(), kind: 'item', title: `Contested ${run}`, description: 'One item with several local test buyers.', meetup: 'Library courtyard', pricePaise: 10000 };
  await call('/marketplace/listings', { actor: 0, method: 'POST', body: listing, expected: [201] });
  const buyers = Array.from({ length: Math.min(6, pairs) }, (_, i) => i * 2 + 1);
  const threads = await Promise.all(buyers.map(async (actor) => {
    const thread = (await call(`/marketplace/listings/${listing.id}/contact`, { actor, method: 'POST', body: { id: randomUUID(), text: 'I would like this item.' }, expected: [201] })).body;
    await call(`/marketplace/threads/${thread.id}/exchange`, { actor, method: 'PUT', body: {} });
    return thread;
  }));
  const completions = await Promise.all(threads.map((thread) => call(`/marketplace/threads/${thread.id}/exchange`, {
    actor: 0, method: 'PUT', body: {}, expected: [200, 409],
  })));
  assert.equal(completions.filter(({ status }) => status === 200).length, 1);
  assert.equal((await call(`/marketplace/listings/${listing.id}`)).body.status, 'closed');
  console.log('Completed competing buyers test with exactly one item handover');
}

// ---- Attack phases: fast-click bursts, conflicting tabs, and invalid input. ----
const attacker = (n) => 64 + n; // identities 64-127 never overlap the buyer/seller pairs
const burst = (n, make) => Promise.all(Array.from({ length: n }, (_, i) => make(i)));
const count = (results, status) => results.filter((r) => r.status === status).length;
const clientErrors = [400, 401, 403, 404, 405, 409, 413, 414, 415];

async function member(actor, name = `Attack ${run} ${actor}`) {
  await call('/marketplace/profile', { actor, method: 'PUT', body: { name, programme: 'Stress attack' }, expected: [200, 201] });
}
async function listed(actor, kind = 'item') {
  const listing = { id: randomUUID(), kind, title: `Attack ${run} ${actor}`, description: 'Concurrency attack listing.', meetup: 'Library courtyard', pricePaise: 5000 };
  await call('/marketplace/listings', { actor, method: 'POST', body: listing, expected: [201] });
  return listing;
}
async function threadFor(listing, buyer) {
  return (await call(`/marketplace/listings/${listing.id}/contact`, { actor: buyer, method: 'POST', body: { id: randomUUID(), text: 'Still available?' }, expected: [201] })).body.id;
}

// Ten identical requests at once model a student hammering one button.
async function tenClicks() {
  const [seller, buyer] = [attacker(0), attacker(1)];
  await Promise.all([member(seller), member(buyer)]);
  const listing = { id: randomUUID(), kind: 'item', title: `Hammered ${run}`, description: 'Ten clicks on every button.', meetup: 'Library courtyard', pricePaise: 9000 };
  const posts = await burst(10, () => call('/marketplace/listings', { actor: seller, method: 'POST', body: listing, expected: [200, 201] }));
  assert.equal(count(posts, 201), 1, 'publish x10 created more than one listing');
  const edit = { ...listing, title: `Hammered ${run} edited`, version: 1, status: 'active', requestId: randomUUID() };
  const saves = await burst(10, () => call(`/marketplace/listings/${listing.id}`, { actor: seller, method: 'PUT', body: edit, expected: [200, 409] }));
  assert.equal(count(saves, 409), 0, `save x10 with one requestId must replay, got ${count(saves, 409)} conflicts`);
  assert.ok(saves.every(({ body }) => body.version === 2));
  const contact = { id: randomUUID(), text: 'Ten clicks on contact.' };
  const opens = await burst(10, () => call(`/marketplace/listings/${listing.id}/contact`, { actor: buyer, method: 'POST', body: contact, expected: [200, 201] }));
  assert.equal(new Set(opens.map(({ body }) => body.id)).size, 1);
  const thread = opens[0].body.id;
  const reply = { id: randomUUID(), text: 'Ten clicks on reply.' };
  await burst(10, () => call(`/marketplace/threads/${thread}`, { actor: seller, method: 'POST', body: reply, expected: [200, 201] }));
  assert.equal((await call(`/marketplace/threads/${thread}`, { actor: buyer })).body.entries.length, 2);
  const comment = { id: randomUUID(), text: 'Ten clicks on comment.' };
  await burst(10, () => call(`/marketplace/listings/${listing.id}/comments`, { actor: buyer, method: 'POST', body: comment, expected: [200, 201] }));
  assert.equal((await call(`/marketplace/listings/${listing.id}/comments`)).body.entries.length, 1);
  await burst(10, () => call(`/marketplace/saved/${listing.id}`, { actor: buyer, method: 'PUT', body: { saved: true } }));
  assert.equal((await call('/marketplace/saved', { actor: buyer })).body.entries.filter(({ id }) => id === listing.id).length, 1);
  // Both sides hammer "Confirm completed exchange" at once.
  const confirms = await burst(10, (i) => call(`/marketplace/threads/${thread}/exchange`, { actor: i % 2 ? buyer : seller, method: 'PUT', body: {}, expected: [200, 409] }));
  assert.equal(count(confirms, 409), 0, `confirm x10 returned ${count(confirms, 409)} conflicts`);
  assert.equal((await call(`/marketplace/threads/${thread}/exchange`, { actor: buyer })).body.completed, true);
  assert.equal((await call(`/marketplace/listings/${listing.id}`)).body.status, 'closed');
  const review = { rating: 4, text: 'Ten clicks on review.' };
  await burst(10, () => call(`/marketplace/threads/${thread}/review`, { actor: buyer, method: 'POST', body: review, expected: [200, 201] }));
  const profile = (await call('/marketplace/profile', { actor: seller })).body.profile;
  assert.equal(profile.ratingCount, 1, 'review x10 counted more than once');
  console.log('Attack: ten-click bursts on every buyer and seller action');
}

// Two tabs (or two different requests) racing for the same thing must not both win.
async function conflictingTabs() {
  const [seller, buyer, profileRace] = [attacker(2), attacker(3), attacker(4)];
  await Promise.all([member(seller), member(buyer)]);
  const listing = await listed(seller);
  const saves = await burst(6, (i) => call(`/marketplace/listings/${listing.id}`, {
    actor: seller, method: 'PUT', body: { ...listing, title: `Tab ${i} ${run}`, version: 1, status: 'active', requestId: randomUUID() }, expected: [200, 409],
  }));
  assert.equal(count(saves, 200), 1, 'two different edits of version 1 both saved');
  const winner = saves.find(({ status }) => status === 200).body;
  assert.equal((await call(`/marketplace/listings/${listing.id}`)).body.title, winner.title);
  // Reviews with different ratings: exactly one lands and the rating counts once.
  const thread = await threadFor(listing, buyer);
  await Promise.all([seller, buyer].map((actor) => call(`/marketplace/threads/${thread}/exchange`, { actor, method: 'PUT', body: {} })));
  const reviews = await burst(5, (i) => call(`/marketplace/threads/${thread}/review`, { actor: buyer, method: 'POST', body: { rating: i + 1, text: `Rating ${i + 1} from a racing tab.` }, expected: [201, 409] }));
  assert.equal(count(reviews, 201), 1);
  const stats = (await call('/marketplace/profile', { actor: seller })).body.profile;
  assert.equal(stats.ratingCount, 1);
  // A new member saving five different names at once ends with one consistent profile.
  const names = await burst(5, (i) => call('/marketplace/profile', { actor: profileRace, method: 'PUT', body: { name: `Racer ${i}` }, expected: [200, 201, 409] }));
  assert.equal(count(names, 201), 1);
  const kept = names.find(({ status }) => status === 201).body.name;
  assert.equal((await call('/marketplace/profile', { actor: profileRace })).body.profile.name, kept);
  console.log('Attack: conflicting edits, reviews and profile saves have one winner');
}

// The seller closes a service while eight buyers contact and comment on it.
async function closeWhileBuying() {
  const seller = attacker(5);
  const buyers = Array.from({ length: 8 }, (_, i) => attacker(6 + i));
  await Promise.all([seller, ...buyers].map((actor) => member(actor)));
  const listing = await listed(seller, 'service');
  const results = await Promise.all([
    ...buyers.flatMap((actor) => [
      call(`/marketplace/listings/${listing.id}/contact`, { actor, method: 'POST', body: { id: randomUUID(), text: 'Can you help this week?' }, expected: [200, 201, 404, 409] }),
      call(`/marketplace/listings/${listing.id}/comments`, { actor, method: 'POST', body: { id: randomUUID(), text: 'Interested.' }, expected: [200, 201, 404, 409] }),
      call(`/marketplace/saved/${listing.id}`, { actor, method: 'PUT', body: { saved: true }, expected: [200, 404, 409] }),
    ]),
    delay(30).then(() => call(`/marketplace/listings/${listing.id}`, { actor: seller, method: 'PUT', body: { version: 1, status: 'closed', requestId: randomUUID() }, expected: [200, 409] })),
  ]);
  assert.ok(results.every(({ status }) => status < 500));
  // Closing can lose to a concurrent write that bumped nothing; retry once like the UI does.
  if ((await call(`/marketplace/listings/${listing.id}`)).body.status !== 'closed') {
    await call(`/marketplace/listings/${listing.id}`, { actor: seller, method: 'PUT', body: { version: 1, status: 'closed', requestId: randomUUID() } });
  }
  await call(`/marketplace/listings/${listing.id}/contact`, { actor: attacker(14), method: 'POST', body: { id: randomUUID(), text: 'Too late?' }, expected: [404] });
  console.log('Attack: closing a listing during a burst of buyer activity');
}

// Save/unsave toggled twenty times at once, then a definite final choice.
async function toggleStorm() {
  const [seller, buyer] = [attacker(15), attacker(16)];
  await Promise.all([member(seller), member(buyer)]);
  const listing = await listed(seller);
  await burst(20, (i) => call(`/marketplace/saved/${listing.id}`, { actor: buyer, method: 'PUT', body: { saved: i % 2 === 0 } }));
  await call(`/marketplace/saved/${listing.id}`, { actor: buyer, method: 'PUT', body: { saved: true } });
  assert.equal((await call(`/marketplace/saved/${listing.id}`, { actor: buyer })).body.saved, true);
  assert.equal((await call('/marketplace/saved', { actor: buyer })).body.entries.filter(({ id }) => id === listing.id).length, 1);
  console.log('Attack: save toggle storm ends in one consistent saved entry');
}

// Seller edits the listing at the same moment both sides confirm the handover.
async function editDuringHandover() {
  const [seller, buyer] = [attacker(17), attacker(18)];
  await Promise.all([member(seller), member(buyer)]);
  const listing = await listed(seller);
  const thread = await threadFor(listing, buyer);
  await call(`/marketplace/threads/${thread}/exchange`, { actor: buyer, method: 'PUT', body: {} });
  const [edit, confirm] = await Promise.all([
    call(`/marketplace/listings/${listing.id}`, { actor: seller, method: 'PUT', body: { ...listing, title: `Edited mid-handover ${run}`, version: 1, status: 'active', requestId: randomUUID() }, expected: [200, 409] }),
    call(`/marketplace/threads/${thread}/exchange`, { actor: seller, method: 'PUT', body: {}, expected: [200, 409] }),
  ]);
  assert.equal(confirm.status, 200, 'a concurrent edit must not block the handover');
  assert.ok([200, 409].includes(edit.status));
  const final = (await call(`/marketplace/listings/${listing.id}`)).body;
  assert.equal(final.status, 'closed');
  assert.ok(final.completedAt);
  // A buyer messaging and commenting while the seller keeps editing must not be refused.
  const busy = await listed(seller, 'service');
  const chat = await threadFor(busy, buyer);
  let version = 1;
  const writes = await Promise.all([
    (async () => {
      for (let i = 0; i < 4; i++) {
        const saved = await call(`/marketplace/listings/${busy.id}`, { actor: seller, method: 'PUT', body: { ...busy, title: `Busy seller edit ${i} ${run}`, version, status: 'active', requestId: randomUUID() } });
        version = saved.body.version;
      }
      return { status: 200 };
    })(),
    ...Array.from({ length: 4 }, (_, i) => call(`/marketplace/threads/${chat}`, { actor: buyer, method: 'POST', body: { id: randomUUID(), text: `Message ${i} during edits` }, expected: [201, 409] })),
    ...Array.from({ length: 4 }, (_, i) => call(`/marketplace/listings/${busy.id}/comments`, { actor: buyer, method: 'POST', body: { id: randomUUID(), text: `Comment ${i} during edits` }, expected: [201, 409] })),
  ]);
  assert.equal(count(writes, 409), 0, `${count(writes, 409)} messages or comments were refused because the seller edited the listing`);
  console.log('Attack: listing edit racing the handover, messages and comments');
}

// Counter staff hammering Set aside / Collected / Release.
async function counterClicks() {
  const headers = { 'x-shop-key': process.env.STRESS_SHOP_KEY ?? 'local-shop-key' };
  const stock = async (id) => (await call('/items')).body.find((item) => item.id === id).stock;
  const before = await stock('item-06');
  const hold = { id: randomUUID(), itemId: 'item-06' };
  const reserves = await burst(10, () => call('/reservations', { actor: 61, method: 'POST', body: hold, expected: [200, 201] }));
  assert.equal(count(reserves, 201), 1);
  assert.equal(await stock('item-06'), before - 1, 'reserve x10 took more than one unit');
  await burst(10, () => call(`/shop/reservations/${hold.id}/set-aside`, { method: 'POST', headers }));
  const collects = await burst(10, () => call(`/shop/reservations/${hold.id}/collect`, { method: 'POST', headers, expected: [200, 409] }));
  assert.equal(count(collects, 200), 1);
  // Collected and Release pressed together: exactly one wins and stock agrees.
  const second = { id: randomUUID(), itemId: 'item-06' };
  await call('/reservations', { actor: 63, method: 'POST', body: second, expected: [201] });
  const mixed = await burst(10, (i) => call(`/shop/reservations/${second.id}/${i % 2 ? 'collect' : 'release'}`, { method: 'POST', headers, expected: [200, 409] }));
  assert.equal(count(mixed, 200), 1, 'collect and release both succeeded');
  const released = (await call(`/reservations/${second.id}`)).body.status === 'RELEASED';
  assert.equal(await stock('item-06'), before - 1 - (released ? 0 : 1));
  // Two staff recount the same shelf from the same starting number.
  const now = await stock('item-06');
  const recounts = await burst(2, (i) => call('/shop/items/item-06', { method: 'PUT', headers, body: { stock: now + 3 + i, expectedStock: now }, expected: [200, 409] }));
  assert.equal(count(recounts, 200), 1);
  console.log('Attack: counter staff fast clicks and racing recounts');
}

async function fuzz() {
  let next = 20;
  const actor = () => attacker(next++ % 44 + 20); // spread writes over identities 84-127
  const valid = () => ({ id: randomUUID(), kind: 'item', title: 'Fuzz listing', description: 'Valid base for fuzzing.', meetup: 'Library', pricePaise: 100 });
  const bad = (body) => call('/marketplace/listings', { actor: actor(), method: 'POST', body: { ...valid(), ...body }, expected: [400] });
  await Promise.all(Array.from({ length: 44 }, (_, i) => member(attacker(20 + i))));
  const badFields = [
    { title: 123 }, { title: null }, { title: '' }, { title: 'ab' }, { title: 'x'.repeat(81) }, { title: '   ' },
    { title: 'a\u0000b' }, { title: 'line\nbreak' }, { title: '‮evil' }, { title: '​​​' },
    { kind: 'ITEM' }, { kind: 'other' }, { kind: ['item'] }, { kind: {} },
    { pricePaise: '100' }, { pricePaise: 1.5 }, { pricePaise: -1 }, { pricePaise: 10_000_001 }, { pricePaise: 1e21 }, { pricePaise: null }, { pricePaise: true },
    { description: 'abcd' }, { description: 'x'.repeat(1201) }, { meetup: 'a' }, { meetup: 'x'.repeat(81) },
    { condition: 'mint' }, { kind: 'service', condition: 'good' }, { scope: 'Item with a scope' }, { availability: 'x'.repeat(101) },
    { id: undefined }, { id: 'not-a-uuid' }, { id: randomUUID().toUpperCase() }, { id: ` ${randomUUID()}` },
  ];
  for (const fields of badFields) await bad(fields);
  // Mass assignment: ownership, status and version in the body are ignored.
  const sneaky = { ...valid(), owner: 'someone-else', status: 'removed', version: 99, completedAt: '2020-01-01T00:00:00.000Z' };
  const sneakyActor = actor();
  await call('/marketplace/listings', { actor: sneakyActor, method: 'POST', raw: `{"__proto__":{"status":"removed"},${JSON.stringify(sneaky).slice(1)}`, expected: [201] });
  const shown = (await call(`/marketplace/listings/${sneaky.id}`)).body;
  assert.equal(shown.status, 'active');
  assert.equal(shown.completedAt, undefined);
  assert.equal((await call('/marketplace/mine', { actor: sneakyActor })).body.entries[0].version, 1);
  const owner = actor();
  const mine = await listed(owner);
  for (const body of [{ version: '1' }, { version: 0 }, { version: 1.5 }, { status: 'removed' }, { status: 'open' }, { requestId: 'x' }, { kind: 'favor' }, { pricePaise: -5 }]) {
    await call(`/marketplace/listings/${mine.id}`, { actor: owner, method: 'PUT', body: { version: 1, status: 'active', ...body }, expected: [400] });
  }
  for (const body of [{ name: 'a' }, { name: 'x'.repeat(49) }, { name: 'Ok', about: 'x'.repeat(801) }, { name: 'Ok', programme: 'x'.repeat(81) }, { name: 'Okay', version: 'x' }, { name: 'Okay', version: 0 }]) {
    await call('/marketplace/profile', { actor: actor(), method: 'PUT', body, expected: [400, 409] });
  }
  for (const body of [{ saved: 'true' }, { saved: 1 }, { saved: null }, {}]) {
    await call(`/marketplace/saved/${mine.id}`, { actor: actor(), method: 'PUT', body, expected: [400] });
  }
  for (const body of [{ id: randomUUID(), text: '' }, { id: randomUUID(), text: 'x'.repeat(601) }, { id: 'x', text: 'Hello' }]) {
    await call(`/marketplace/listings/${mine.id}/comments`, { actor: actor(), method: 'POST', body, expected: [400] });
  }
  for (const body of [{ id: randomUUID(), text: '' }, { id: randomUUID(), text: 'x'.repeat(801) }, { text: 'No id' }]) {
    await call(`/marketplace/listings/${mine.id}/contact`, { actor: actor(), method: 'POST', body, expected: [400] });
  }
  await call(`/marketplace/listings/${mine.id}/report`, { actor: actor(), method: 'POST', body: { reason: 'abcd' }, expected: [400] });
  await call(`/marketplace/listings/${mine.id}/moderate`, { actor: actor(), method: 'PUT', body: {}, expected: [403] });
  const reviewThread = await threadFor(mine, actor());
  for (const body of [{ rating: 0, text: 'Valid text' }, { rating: 6, text: 'Valid text' }, { rating: 4.5, text: 'Valid text' }, { rating: '5', text: 'Valid text' }]) {
    await call(`/marketplace/threads/${reviewThread}/review`, { actor: owner, method: 'POST', body, expected: [403, 409] });
  }
  // Paths, queries, headers, methods and tokens.
  for (const path of ['/marketplace/listings/NOT-A-UUID', `/marketplace/listings/${randomUUID().toUpperCase()}`, `/marketplace/listings/${randomUUID()}%0a`,
    '/marketplace/listings/%2e%2e%2fmine', '/marketplace/listings/%E0%A4%A', `/marketplace/sellers/${'f'.repeat(63)}`, '/marketplace/threads/..%2f..%2fprofile/exchange']) {
    await call(path, { actor: actor(), expected: [400, 404] });
  }
  await call(`/marketplace/listings/${'a'.repeat(3000)}`, { expected: [414] });
  for (const query of [`q=${'x'.repeat(81)}`, 'q=%00', 'q=%E2%80%AE', 'kind=ITEM', 'cursor=not!a!cursor', `cursor=${Buffer.from(JSON.stringify(['other', 'x'])).toString('base64url')}`]) {
    await call(`/marketplace/listings?${query}`, { expected: [400] });
  }
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    await call('/marketplace/profile', { actor: actor(), method: 'PUT', raw: '{"name":"Ok name"}', headers: { 'content-type': contentType }, expected: [415] });
  }
  for (const raw of ['{"name":', '['.repeat(4000), '{"name":"\\ud800"}', '{"name":"Ok name","name":"x"}']) {
    await call('/marketplace/profile', { actor: actor(), method: 'PUT', raw, expected: [400] });
  }
  for (const token of ['Bearer', 'Basic Zm9vOmJhcg==', 'Bearer demo-stress-999', 'Bearer ' + 'x'.repeat(9000)]) {
    await call('/marketplace/mine', { headers: { authorization: token }, expected: [401] });
  }
  for (const method of ['PATCH', 'DELETE']) await call(`/marketplace/listings/${mine.id}`, { method, expected: [405] });
  // Shop inputs.
  const headers = { 'x-shop-key': process.env.STRESS_SHOP_KEY ?? 'local-shop-key' };
  for (const body of [{ id: randomUUID(), itemId: 123 }, { id: randomUUID(), itemId: 'x'.repeat(200) }, { itemId: 'item-02' }, { id: 'nope', itemId: 'item-02' }]) {
    await call('/reservations', { actor: 63, method: 'POST', body, expected: [400] });
  }
  for (const body of [{ stock: '5', expectedStock: 5 }, { stock: 5.5, expectedStock: 5 }, { stock: 100001, expectedStock: 5 }, { stock: 5 }]) {
    await call('/shop/items/item-02', { method: 'PUT', headers, body, expected: [400] });
  }
  for (const key of ['wrong-key', 'local-shop-key ', 'ключ']) {
    await call('/shop/reservations', { headers: { 'x-shop-key': encodeURIComponent(key) }, expected: [401] });
  }
  await call('/reservations/not-a-uuid', { expected: [404] });
  await call(`/shop/reservations/not-a-uuid/collect`, { method: 'POST', headers, expected: [404] });
  // A header bigger than the server allows is refused at the HTTP layer, not by the app.
  const huge = await fetch(`${base}/api/items`, { headers: { 'x-filler': 'x'.repeat(20_000) } });
  assert.equal(huge.status, 431);
  console.log(`Fuzz: ${badFields.length} bad listing fields plus edits, profiles, paths, queries, headers, tokens and shop inputs`);
}

// Clients that send headers and then stall the body must not lock everyone else out.
async function stalledUploads() {
  const { connect } = await import('node:net');
  const { hostname, port } = new URL(base);
  const sockets = await Promise.all(Array.from({ length: 160 }, () => new Promise((resolve, reject) => {
    const socket = connect(Number(port) || 80, hostname, () => {
      socket.write('POST /api/reservations HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"id":');
      resolve(socket);
    });
    socket.on('error', () => {});
    socket.once('error', reject);
  })));
  await delay(300);
  const at = performance.now();
  const response = await fetch(`${base}/api/items`, { signal: AbortSignal.timeout(5_000) });
  const waited = Math.round(performance.now() - at);
  sockets.forEach((socket) => socket.destroy());
  assert.equal(response.status, 200, `160 stalled uploads blocked a normal read (status ${response.status})`);
  console.log(`Attack: 160 stalled uploads, a normal read still answered in ${waited} ms`);
}

try {
  // Transport and validation checks precede load. No malformed request may yield 500.
  for (const raw of ['{', 'null', '[]', '"text"', '42']) {
    await call('/marketplace/profile', { actor: 62, method: 'PUT', raw, expected: [400] });
    await call('/reservations', { actor: 63, method: 'POST', raw, expected: [400] });
  }
  await call('/marketplace/listings', { actor: 62, method: 'POST', body: { id: randomUUID(), kind: 'item', title: 'Invalid', description: 'Invalid amount', meetup: 'Library', pricePaise: -1 }, expected: [400] });
  await call('/marketplace/profile', { actor: 62, method: 'PUT', raw: 'x'.repeat(8193), expected: [413] });
  await call('/marketplace/listings', { method: 'DELETE', expected: [405] });
  await call('/marketplace/listings/not-a-uuid', { expected: [400] });
  await call('/marketplace/listings?cursor=not-a-cursor', { expected: [400] });
  await call('/marketplace/mine', { expected: [401] });
  await fuzz();
  await shopFlow();
  // Attacks run alongside the buyer/seller pairs so every race happens under load.
  const attacks = { tenClicks, conflictingTabs, closeWhileBuying, toggleStorm, editDuringHandover, counterClicks };
  const outcomes = await Promise.allSettled([
    ...Array.from({ length: pairs }, (_, index) => flow(index)),
    ...Object.values(attacks).map((attack) => attack()),
  ]);
  const names = [...Array.from({ length: pairs }, (_, index) => `flow ${index}`), ...Object.keys(attacks)];
  stats.failures = outcomes.flatMap((result, index) => result.status === 'rejected' ? [{ phase: names[index], error: result.reason.message }] : []);
  assert.equal(stats.failures.length, 0, JSON.stringify(stats.failures));
  await contestedItem();
  await stalledUploads();
  // A large read burst must produce controlled throttling and leave liveness intact.
  let read = 0;
  await Promise.all(Array.from({ length: 96 }, async () => {
    while (read++ < 720) await call('/marketplace/listings', { retry: false, expected: [200, 429, 503] });
  }));
  assert.ok(stats.statuses[429] > 0);
  await call('/health/live');
  assert.equal(stats.statuses[500] ?? 0, 0, 'a request returned 500');
} catch (error) {
  stats.failures.push({ error: error.message });
  process.exitCode = 1;
} finally {
  const sorted = stats.latencies.sort((a, b) => a - b);
  const report = { ...stats, latencies: undefined, durationSeconds: Math.round((performance.now() - start) / 100) / 10,
    latencyMs: { p50: Math.round(sorted[Math.floor(sorted.length * .5)] ?? 0), p95: Math.round(sorted[Math.floor(sorted.length * .95)] ?? 0), max: Math.round(sorted.at(-1) ?? 0) } };
  const reportPath = process.env.STRESS_REPORT_PATH ?? fileURLToPath(new URL('../artifacts/stress-report.json', import.meta.url));
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
