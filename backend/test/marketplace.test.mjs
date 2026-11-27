import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { memoryLimiter, memoryMarketplace } from '../marketplace-local.mjs';
import { gatewayActor, makeMarketplace } from '../src/marketplace.mjs';
import { handler as signup } from '../src/marketplace-signup.mjs';

const owner = { id: 'seller' };
const buyer = { id: 'buyer' };
const stranger = { id: 'stranger' };
const mod = { id: 'mod', moderator: true };
const input = (overrides = {}) => ({
  id: randomUUID(), kind: 'item', title: 'Mini drafter', description: 'Used for one semester.',
  meetup: 'Library courtyard', pricePaise: 5000, ...overrides,
});
const route = (method, path) => `${method} /marketplace/${path}`;
const setup = ({ store = memoryMarketplace(), limiter = async () => 0, now, seedProfile = true } = {}) => {
  const run = makeMarketplace(store, limiter, { actorFrom: (event) => event.actor, now });
  const ready = seedProfile ? run({
    routeKey: route('PUT', 'profile'), actor: owner, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Seller', about: '', programme: '' }),
  }) : Promise.resolve();
  return async (key, { actor, id, commentId, query, body, rawBody, header = 'application/json', ip = '192.0.2.1' } = {}) => {
    await ready;
    const result = await run({
      routeKey: key, actor, pathParameters: { id, commentId }, queryStringParameters: query,
      headers: { 'content-type': header }, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      requestContext: { http: { sourceIp: ip } },
    });
    return { status: result.statusCode, body: JSON.parse(result.body), headers: result.headers };
  };
};
const publish = (call, body) => call(route('POST', 'listings'), { actor: owner, body });
const browse = (call, query) => call(route('GET', 'listings'), { query });

test('validates venue, price, HTML-as-text, payload size, identifiers, auth and methods', async () => {
  const call = setup();
  const path = route('POST', 'listings');
  assert.equal((await call(path, { body: input() })).status, 401);
  for (const change of [
    { id: 'garbage' }, { kind: 'other' }, { title: '   ' }, { title: '\u0000Pass' }, { meetup: 'x' },
    { title: 'ﷺ'.repeat(80) }, { title: 'Book \ud800' }, { title: '​​​' }, { description: '‍'.repeat(6) },
    { pricePaise: 1.25 }, { pricePaise: -1 }, { pricePaise: 10_000_001 }, { description: 'x'.repeat(1201) },
  ]) assert.equal((await publish(call, input(change))).status, 400);
  assert.equal((await call(path, { actor: owner, rawBody: '{' })).status, 400);
  assert.equal((await call(path, { actor: owner, rawBody: '[]' })).status, 400);
  assert.equal((await call(path, { actor: owner, rawBody: 'x'.repeat(8193) })).status, 413);
  assert.equal((await call(path, { actor: owner, body: input(), header: 'text/plain' })).status, 415);
  assert.equal((await call(route('DELETE', 'listings'), { actor: owner })).status, 404);
  assert.equal((await call(route('PUT', 'listings/{id}'), { id: '%E0%A4%A', actor: owner, body: {} })).status, 400);
  const listing = input({ description: '<img src=x onerror=alert(1)>' });
  assert.equal((await publish(call, listing)).body.description, listing.description);
  assert.equal((await publish(call, input({ kind: 'favor', pricePaise: 0 }))).status, 201);
  assert.equal((await publish(call, input({ title: 'क्‍ष lab manual' }))).status, 201, 'zero-width joiners inside real text stay allowed');
  assert.equal((await browse(call, { kind: 'bad' })).status, 400);
  assert.equal((await browse(call, { q: 'ﷺ'.repeat(80) })).status, 400);
});

test('64 simultaneous publish retries produce one listing and detect an identifier collision', async () => {
  const call = setup();
  const draft = input();
  const responses = await Promise.all(Array.from({ length: 64 }, () => publish(call, draft)));
  assert.equal(responses.filter((result) => result.status === 201).length, 1);
  assert.equal(responses.filter((result) => result.status === 200).length, 63);
  assert.equal((await publish(call, { ...draft, title: 'Changed payload' })).status, 409);
  assert.equal((await call(route('POST', 'listings'), { actor: buyer, body: draft })).status, 409);
  assert.equal((await browse(call)).body.entries.length, 1);
  const view = (await browse(call)).body.entries[0];
  assert.equal(view.owner, undefined);
  assert.equal(view.requestHash, undefined);
});

test('two racing edits have one winner and closed or removed entries leave public indexes atomically', async () => {
  const call = setup();
  const draft = input();
  await publish(call, draft);
  const edit = (body, actor = owner) => call(route('PUT', 'listings/{id}'), { actor, id: draft.id, body });
  assert.equal((await edit({ status: 'closed', version: 1 }, stranger)).status, 404);
  assert.equal((await edit({ status: 'active', version: 1, pricePaise: 1000 })).status, 400);
  const expected = ['closed', 'active'].map((status) => edit({ ...draft, title: 'Renamed', status, version: 1 }));
  assert.deepEqual((await Promise.all(expected)).map(({ status }) => status).sort(), [200, 409]);
  assert.equal((await browse(call, { q: 'Mini' })).body.entries.length, 0);
  const personal = await call(route('GET', 'mine'), { actor: owner });
  assert.equal(personal.body.entries[0].version, 2);
  const reopened = await edit({ status: 'active', version: 2 });
  assert.equal(reopened.status, 200);
  assert.equal((await browse(call, { q: 'RENAM' })).body.entries[0].id, draft.id);
  await edit({ status: 'closed', version: 3 });
  assert.equal((await browse(call)).body.entries.length, 0);
});

test('feed and prefix pagination merge categories without losing or repeating listings', async () => {
  const timestamp = new Date('2026-11-26T12:00:00.000Z');
  const call = setup({ now: () => timestamp });
  const expected = Array.from({ length: 55 }, (_, index) => input({
    kind: ['item', 'service', 'favor'][index % 3],
    title: index === 0 ? 'Ｍini Drafter' : `Mini listing ${String(index).padStart(2, '0')}`,
  }));
  await Promise.all(expected.map((entry) => publish(call, entry)));
  for (const query of [{}, { q: 'mini' }]) {
    const items = [];
    let cursor;
    do {
      const result = await browse(call, { ...query, cursor });
      assert.equal(result.status, 200);
      items.push(...result.body.entries);
      cursor = result.body.next ?? undefined;
    } while (cursor);
    assert.equal(items.length, expected.length);
    assert.equal(new Set(items.map(({ id }) => id)).size, expected.length);
  }
  const first = await browse(call, { q: 'mini' });
  assert.equal((await browse(call, { kind: 'favor', cursor: first.body.next })).status, 400);
  assert.equal((await browse(call, { cursor: 'nope' })).status, 400);
  const mine = await call(route('GET', 'mine'), { actor: owner });
  const more = await call(route('GET', 'mine'), { actor: owner, query: { cursor: mine.body.next } });
  assert.equal(new Set([...mine.body.entries, ...more.body.entries].map(({ id }) => id)).size, 40);
  assert.equal((await call(route('GET', 'mine'), { actor: buyer, query: { cursor: mine.body.next } })).status, 400);
});

test('concurrent contact and message retries converge while conversations stay private', async () => {
  const call = setup();
  const draft = input();
  await publish(call, draft);
  const contactId = randomUUID();
  const contact = (actor) => call(route('POST', 'listings/{id}/contact'), { actor, id: draft.id, body: { id: contactId, text: 'Still available?' } });
  assert.equal((await contact(owner)).status, 409);
  const opened = await Promise.all(Array.from({ length: 24 }, () => contact(buyer)));
  assert.equal(opened.filter(({ status }) => status === 201).length, 1);
  const { id } = opened[0].body;
  const thread = route('GET', 'threads/{id}');
  assert.equal((await call(thread, { actor: stranger, id })).status, 404);
  assert.equal((await call(thread, { id })).status, 401);
  assert.equal((await call(route('GET', 'inbox'), { actor: owner })).body.entries[0].asSeller, true);
  assert.equal((await call(route('GET', 'inbox'), { actor: stranger })).body.entries.length, 0);
  assert.equal((await call(thread, { actor: buyer, id })).body.entries.length, 1);
  const body = { id: randomUUID(), text: 'Yes. I can meet after class.' };
  const reply = () => call(route('POST', 'threads/{id}'), { actor: owner, id, body });
  const replies = await Promise.all(Array.from({ length: 24 }, reply));
  assert.equal(replies.filter(({ status }) => status === 201).length, 1);
  const received = (await call(thread, { actor: buyer, id })).body.entries.find((entry) => entry.id === replies[0].body.id);
  assert.deepEqual({ mine: received.mine, author: received.author, text: received.text }, { mine: false, author: undefined, text: body.text });
  assert.equal((await call(thread, { actor: buyer, id })).body.entries.length, 2);
  assert.equal((await call(route('POST', 'listings/{id}/contact'), {
    actor: buyer, id: draft.id, body: { id: randomUUID(), text: 'Can we meet tomorrow?' },
  })).status, 200);
  assert.equal((await call(thread, { actor: buyer, id })).body.entries.length, 3);
});

test('reports deduplicate, require a moderator to read, and removed listings cannot reopen', async () => {
  const call = setup();
  const draft = input();
  await publish(call, draft);
  const thread = (await call(route('POST', 'listings/{id}/contact'), {
    actor: buyer, id: draft.id, body: { id: randomUUID(), text: 'Is it free?' },
  })).body;
  const report = () => call(route('POST', 'listings/{id}/report'), { actor: buyer, id: draft.id, body: { reason: 'Incorrect information.' } });
  assert.deepEqual((await Promise.all([report(), report()])).map(({ status }) => status).sort(), [200, 201]);
  assert.equal((await call(route('GET', 'reports'), { actor: buyer })).status, 403);
  assert.equal((await call(route('PUT', 'listings/{id}/moderate'), { actor: buyer, id: draft.id, body: { version: 1 } })).status, 403);
  const reportPage = await call(route('GET', 'reports'), { actor: mod });
  assert.equal(reportPage.body.entries.length, 1);
  assert.equal(reportPage.body.entries[0].listingId, draft.id);
  assert.equal((await call(route('PUT', 'listings/{id}/moderate'), { actor: mod, id: draft.id, body: { version: 1 } })).status, 200);
  assert.equal((await browse(call)).body.entries.length, 0);
  assert.equal((await call(route('PUT', 'listings/{id}'), { actor: owner, id: draft.id, body: { status: 'active', version: 2 } })).status, 409);
  const reply = { id: randomUUID(), text: 'Do you still have it?' };
  assert.equal((await call(route('POST', 'threads/{id}'), { actor: buyer, id: thread.id, body: reply })).status, 409);
  assert.equal((await call(route('GET', 'threads/{id}'), { actor: buyer, id: thread.id })).status, 200);
});

test('a burst hits rate limits, refill restores access, and limiter outages fail closed', async () => {
  let clock = 0;
  const limited = setup({ limiter: memoryLimiter(() => clock) });
  const burst = await Promise.all(Array.from({ length: 610 }, () => browse(limited)));
  assert.equal(burst.filter(({ status }) => status === 200).length, 600);
  assert.equal(burst.filter(({ status }) => status === 429).length, 10);
  assert.equal(burst.find(({ status }) => status === 429).headers['retry-after'], '1');
  clock += 1000;
  assert.equal((await browse(limited)).status, 200);
  const publishes = await Promise.all(Array.from({ length: 9 }, () => publish(limited, input())));
  assert.equal(publishes.filter(({ status }) => status === 201).length, 6);
  assert.equal(publishes.filter(({ status }) => status === 429).length, 3);
  const unavailable = setup({ limiter: () => { throw new Error('Redis down'); } });
  assert.equal((await browse(unavailable)).status, 503);
  assert.equal((await publish(unavailable, input())).status, 503);
});

test('authorizer claims reject ID tokens and the signup trigger gates the exact campus suffix', async (context) => {
  const sub = randomUUID();
  const event = (claims) => ({ requestContext: { authorizer: { jwt: { claims } } } });
  assert.deepEqual(gatewayActor(event({ sub, token_use: 'access', 'cognito:groups': '[MarketplaceModerators]' })), { id: sub, moderator: true });
  assert.equal(gatewayActor(event({ sub, token_use: 'id' })), undefined);
  assert.equal(gatewayActor({ headers: { authorization: 'Bearer demo-asha' } }), undefined);
  const previous = process.env.CAMPUS_EMAIL_DOMAIN;
  context.after(() => {
    if (previous === undefined) delete process.env.CAMPUS_EMAIL_DOMAIN;
    else process.env.CAMPUS_EMAIL_DOMAIN = previous;
  });
  process.env.CAMPUS_EMAIL_DOMAIN = 'adypu.edu.in';
  const request = (email) => ({ request: { userAttributes: { email } } });
  assert.deepEqual(await signup(request('Student@ADYPU.edu.in')), request('Student@ADYPU.edu.in'));
  for (const email of ['student@notadypu.edu.in', 'student@adypu.edu.in.evil.invalid', 'adypu.edu.in', 'a@b@adypu.edu.in']) {
    await assert.rejects(signup(request(email)));
    await assert.rejects(signup({ ...request(email), triggerSource: 'PreSignUp_SignUp' }));
  }
  const shopkeeper = { triggerSource: 'PreSignUp_AdminCreateUser', request: { userAttributes: { email: 'owner@stationery.example' } } };
  assert.deepEqual(await signup(shopkeeper), shopkeeper, 'admins can create shop staff accounts without a campus email');
});

const publicProfile = (call, actor, name, extra = {}) =>
  call(route('GET', 'profile'), { actor }).then(({ body }) => call(route('PUT', 'profile'), {
    actor, body: { name, about: 'I like sharing campus supplies.', programme: 'Design', version: body.profile?.version, ...extra },
  }));

test('public seller profiles follow display name changes and show their active listings without account identifiers', async () => {
  const store = memoryMarketplace();
  const call = setup({ store, seedProfile: false });
  const draft = input({ kind: 'service', scope: 'One 30-minute session.', availability: 'Monday afternoons' });
  assert.equal((await publish(call, draft)).status, 409);
  assert.equal((await call(route('GET', 'profile'), { actor: owner })).body.profile, null);
  const profile = await publicProfile(call, owner, 'Asha');
  assert.equal(profile.status, 201);
  await publish(call, draft);
  const [oldProjection] = await store.query('FEED#service', { limit: 1 });
  delete oldProjection.sellerId;
  await store.transact([{ kind: 'put', row: oldProjection }]);
  assert.equal((await publicProfile(call, undefined, 'Asha')).status, 401);
  const sellerId = profile.body.id;
  assert.notEqual(sellerId, owner.id);
  const publicProfilePage = await call(route('GET', 'sellers/{id}'), { id: sellerId });
  assert.equal(publicProfilePage.body.about, 'I like sharing campus supplies.');
  assert.equal(publicProfilePage.body.owner, undefined);
  assert.equal(publicProfilePage.body.version, undefined);
  assert.equal((await call(route('GET', 'sellers'))).body.entries[0].name, 'Asha');
  const newName = await publicProfile(call, owner, 'Asha S', { version: 1 });
  assert.equal(newName.body.version, 2);
  assert.equal((await publicProfile(call, owner, 'Stale name', { version: 1 })).status, 409);
  const feed = (await browse(call)).body.entries[0];
  assert.deepEqual(feed.seller, { id: sellerId, name: 'Asha S' });
  assert.equal(feed.sellerId, undefined);
  const resource = await call(route('GET', 'listings/{id}'), { id: draft.id });
  assert.equal(resource.body.scope, draft.scope);
  assert.equal(resource.body.availability, draft.availability);
  assert.equal(resource.body.description, draft.description);
  assert.equal((await call(route('GET', 'sellers/{id}/listings'), { id: sellerId })).body.entries[0].id, draft.id);
  await call(route('PUT', 'listings/{id}'), { actor: owner, id: draft.id, body: { status: 'closed', version: 1 } });
  assert.equal((await call(route('GET', 'sellers/{id}/listings'), { id: sellerId })).body.entries.length, 0);
  assert.equal((await call(route('GET', 'listings/{id}'), { id: draft.id })).body.status, 'closed');
  assert.equal((await publish(call, input({ condition: 'incorrect' }))).status, 400);
  assert.equal((await publish(call, input({ kind: 'favor', condition: 'good' }))).status, 400);
});

test('public comments are deduplicated, identify seller replies, and restrict removal', async () => {
  const call = setup();
  const draft = input();
  await publish(call, draft);
  const body = { id: randomUUID(), text: 'Is a case included?' };
  const comments = (method, actor, input) => call(route(method, 'listings/{id}/comments'), { actor, id: draft.id, body: input });
  assert.equal((await comments('POST', buyer, body)).status, 409);
  await publicProfile(call, buyer, 'Ravi');
  const results = await Promise.all(Array.from({ length: 12 }, () => comments('POST', buyer, body)));
  assert.equal(results.filter(({ status }) => status === 201).length, 1);
  assert.equal(results.filter(({ status }) => status === 200).length, 11);
  const commentId = results[0].body.id;
  const remove = (actor, key) => call(route('PUT', 'listings/{id}/comments/{commentId}'), {
    actor, commentId: key, id: draft.id, body: {},
  });
  assert.equal((await comments('POST', buyer, { ...body, text: 'A different question' })).status, 409);
  assert.equal((await remove(stranger, commentId)).status, 404);
  await publicProfile(call, owner, 'Asha');
  const reply = await comments('POST', owner, { id: randomUUID(), text: 'Yes, a hard case is included.' });
  assert.equal(reply.body.sellerReply, true);
  const publicPage = await comments('GET');
  assert.equal(publicPage.body.entries.length, 2);
  assert.deepEqual(publicPage.body.entries.find(({ id }) => id === commentId).author.name, 'Ravi');
  assert.equal(publicPage.body.entries[0].authorId, undefined);
  assert.equal((await remove(buyer, commentId)).status, 200);
  assert.equal((await remove(mod, reply.body.id)).status, 200);
  assert.equal((await comments('GET')).body.entries.length, 0);
});

test('only the buyer can publish one review after both participants confirm and totals update atomically', async () => {
  const call = setup();
  const draft = input({ kind: 'service' });
  await publish(call, draft);
  const profile = await publicProfile(call, owner, 'Asha');
  await publicProfile(call, buyer, 'Ravi');
  await publicProfile(call, stranger, 'Neha');
  const contact = (actor) => call(route('POST', 'listings/{id}/contact'), {
    actor, id: draft.id, body: { id: randomUUID(), text: 'Can we arrange a campus exchange?' },
  });
  const { id } = (await contact(buyer)).body;
  const other = (await contact(stranger)).body.id;
  const confirm = (actor, thread = id) => call(route('PUT', 'threads/{id}/exchange'), { actor, id: thread, body: {} });
  const state = (actor) => call(route('GET', 'threads/{id}/exchange'), { actor, id });
  const text = 'Clear description and a smooth handover.';
  const review = (actor, rating, thread = id) => call(route('POST', 'threads/{id}/review'), { actor, id: thread, body: { rating, text } });
  assert.equal((await review(buyer, 5)).status, 409);
  assert.equal((await review(owner, 5)).status, 403);
  assert.equal((await state(stranger)).status, 404);
  assert.equal((await confirm(stranger)).status, 404);
  assert.equal((await confirm(buyer)).body.completed, false);
  assert.equal((await review(buyer, 5)).status, 409);
  assert.equal((await confirm(owner)).body.completed, true);
  assert.equal((await state(buyer)).body.canReview, true);
  assert.equal((await review(buyer, 8)).status, 400);
  const confirmationRace = await Promise.all([confirm(owner, other), confirm(stranger, other)]);
  assert.ok(confirmationRace.every(({ status }) => status === 200));
  const results = await Promise.all([...Array.from({ length: 16 }, () => review(buyer, 5)), review(stranger, 3, other)]);
  assert.equal(results.filter(({ status }) => status === 201).length, 2);
  assert.equal(results.filter(({ status }) => status === 200).length, 15);
  assert.equal((await review(buyer, 4)).status, 409);
  assert.equal((await state(buyer)).body.reviewed, true);
  const publicSeller = (await call(route('GET', 'sellers/{id}'), { id: profile.body.id })).body;
  assert.deepEqual({ count: publicSeller.ratingCount, average: publicSeller.averageRating }, { count: 2, average: 4 });
  const reviews = (await call(route('GET', 'sellers/{id}/reviews'), { id: profile.body.id })).body.entries;
  assert.equal(reviews.length, 2);
  assert.ok(reviews.every((entry) => entry.id !== id && entry.id !== other && entry.author.id !== buyer.id));
});

test('a single item can only have one completed exchange', async () => {
  const call = setup();
  const draft = input();
  await publish(call, draft);
  const threads = await Promise.all([buyer, stranger].map((actor) => call(route('POST', 'listings/{id}/contact'), {
    actor, id: draft.id, body: { id: randomUUID(), text: 'Is it still available?' },
  })));
  const ids = threads.map(({ body }) => body.id);
  const confirm = (actor, id) => call(route('PUT', 'threads/{id}/exchange'), { actor, id, body: {} });
  await Promise.all([confirm(buyer, ids[0]), confirm(stranger, ids[1])]);
  const results = await Promise.all(ids.map((id) => confirm(owner, id)));
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409]);
  assert.equal(results.find(({ status }) => status === 200).body.completed, true);
  assert.equal((await browse(call)).body.entries.length, 0);
  const listing = (await call(route('GET', 'listings/{id}'), { id: draft.id })).body;
  assert.equal(listing.status, 'closed');
  assert.ok(listing.completedAt);
  assert.equal((await call(route('PUT', 'listings/{id}'), {
    actor: owner, id: draft.id, body: { status: 'active', version: 2 },
  })).status, 409);
});

test('saved listings are private and reflect edits or moderation', async () => {
  const call = setup();
  const draft = input();
  await publish(call, draft);
  const save = (actor, saved) => call(route('PUT', 'saved/{id}'), { actor, id: draft.id, body: { saved } });
  const saved = (actor) => call(route('GET', 'saved'), { actor });
  assert.equal((await save(undefined, true)).status, 401);
  assert.equal((await save(buyer, 'true')).status, 400);
  assert.equal((await save(buyer, true)).status, 200);
  assert.equal((await save(buyer, true)).status, 200);
  assert.equal((await saved(buyer)).body.entries.length, 1);
  assert.equal((await saved(stranger)).body.entries.length, 0);
  await call(route('PUT', 'listings/{id}'), {
    actor: owner, id: draft.id, body: { ...draft, title: 'Updated listing', version: 1, status: 'active' },
  });
  assert.equal((await saved(buyer)).body.entries[0].title, 'Updated listing');
  await call(route('PUT', 'listings/{id}/moderate'), { actor: mod, id: draft.id, body: { version: 2 } });
  assert.deepEqual((await saved(buyer)).body.entries[0], { id: draft.id, unavailable: true });
  assert.equal((await call(route('GET', 'listings/{id}/comments'), { id: draft.id })).status, 404);
  assert.equal((await save(buyer, false)).status, 200);
  assert.equal((await saved(buyer)).body.entries.length, 0);
});

test('save requests replay after a lost success response without overwriting a later edit', async () => {
  const call = setup();
  const draft = input();
  await publish(call, draft);
  const save = { ...draft, title: 'Updated drafter', version: 1, status: 'active', requestId: randomUUID() };
  const edit = (body, actor = owner) => call(route('PUT', 'listings/{id}'), { actor, id: draft.id, body });
  const races = await Promise.all(Array.from({ length: 24 }, () => edit(save)));
  assert.ok(races.every(({ status }) => status === 200));
  assert.ok(races.every(({ body }) => body.version === 2));
  const next = { ...save, title: 'Later edit', version: 2, requestId: randomUUID() };
  assert.equal((await edit(next)).body.version, 3);
  assert.equal((await edit(save)).body.version, 2);
  assert.equal((await call(route('GET', 'mine'), { actor: owner })).body.entries[0].title, 'Later edit');
  assert.equal((await edit({ ...save, title: 'Changed retry' })).status, 409);
  assert.equal((await edit(save, stranger)).status, 404);
});

test('a duplicate save that reads the listing just after its twin commits still replays', async () => {
  const store = memoryMarketplace();
  let detailReads = 0;
  let armed = false;
  // The second save's listing read lands after the first save commits, as on a slow network.
  const slow = { ...store, get: async (pk, sk) => {
    if (armed && sk === 'DETAIL' && pk.startsWith('LISTING#') && ++detailReads === 2) await new Promise((done) => setTimeout(done, 30));
    return store.get(pk, sk);
  } };
  const call = setup({ store: slow });
  const draft = input();
  await publish(call, draft);
  armed = true;
  const save = { ...draft, title: 'Double-clicked save', version: 1, status: 'active', requestId: randomUUID() };
  const both = await Promise.all([0, 1].map(() => call(route('PUT', 'listings/{id}'), { actor: owner, id: draft.id, body: save })));
  assert.deepEqual(both.map(({ status }) => status), [200, 200]);
  assert.ok(both.every(({ body }) => body.version === 2));
});

test('buyer writes are not refused while the seller keeps editing the listing', async () => {
  const call = setup();
  const service = input({ kind: 'service', pricePaise: 0 });
  await publish(call, service);
  const people = Array.from({ length: 10 }, (_, i) => ({ id: `buyer-${i}` }));
  for (const actor of [buyer, ...people]) {
    await call(route('PUT', 'profile'), { actor, body: { name: `Person ${actor.id}` } });
  }
  const thread = (await call(route('POST', 'listings/{id}/contact'), { actor: buyer, id: service.id, body: { id: randomUUID(), text: 'Hello' } })).body.id;
  await Promise.all([owner, buyer].map((actor) => call(route('PUT', 'threads/{id}/exchange'), { actor, id: thread, body: {} })));
  for (let round = 0; round < 10; round++) {
    const results = await Promise.all([
      call(route('PUT', 'listings/{id}'), { actor: owner, id: service.id, body: { ...service, title: `Edit ${round}`, version: round + 1, status: 'active', requestId: randomUUID() } }),
      call(route('POST', 'threads/{id}'), { actor: buyer, id: thread, body: { id: randomUUID(), text: `Message ${round}` } }),
      call(route('POST', 'listings/{id}/comments'), { actor: buyer, id: service.id, body: { id: randomUUID(), text: `Comment ${round}` } }),
      call(route('PUT', 'saved/{id}'), { actor: buyer, id: service.id, body: { saved: round % 2 === 0 } }),
      call(route('POST', 'listings/{id}/contact'), { actor: people[round], id: service.id, body: { id: randomUUID(), text: 'Interested' } }),
      call(route('POST', 'listings/{id}/report'), { actor: people[round], id: service.id, body: { reason: 'Testing reports during edits' } }),
      round === 0 ? call(route('POST', 'threads/{id}/review'), { actor: buyer, id: thread, body: { rating: 5, text: 'Great tutoring session.' } }) : null,
    ].filter(Boolean));
    assert.deepEqual(results.map(({ status }) => status < 300), results.map(() => true), `round ${round}: ${results.map(({ status }) => status)}`);
  }
});

test('simultaneous profile retries return the saved version once', async () => {
  const call = setup({ seedProfile: false });
  const body = { name: 'New seller', about: 'Campus workshops', programme: 'Design' };
  const results = await Promise.all(Array.from({ length: 16 }, () => call(route('PUT', 'profile'), { actor: owner, body })));
  assert.equal(results.filter(({ status }) => status === 201).length, 1);
  assert.equal(results.filter(({ status }) => status === 200).length, 15);
  assert.ok(results.every(({ body }) => body.version === 1));
});

test('active seller queries skip closed history and preserve older profiles', async () => {
  const store = memoryMarketplace();
  let tick = 0;
  const call = setup({ store, now: () => new Date(Date.UTC(2026, 10, 26, 0, 0, tick++)) });
  const seller = (await call(route('GET', 'profile'), { actor: owner })).body.profile;
  const first = input();
  await publish(call, first);
  for (let index = 0; index < 25; index++) {
    const draft = input();
    await publish(call, draft);
    await call(route('PUT', 'listings/{id}'), { actor: owner, id: draft.id, body: { status: 'closed', version: 1 } });
  }
  const query = () => call(route('GET', 'sellers/{id}/listings'), { id: seller.id });
  assert.deepEqual((await query()).body.entries.map(({ id }) => id), [first.id]);
  await store.transact([{ kind: 'delete', row: { pk: 'SELLER#' + seller.id, sk: 'OFFERS-INDEX' } }]);
  assert.deepEqual((await query()).body.entries.map(({ id }) => id), [first.id]);
});

test('long normalized Unicode search produces reusable bounded cursors', async () => {
  const call = setup();
  const query = '㍿'.repeat(25) + '"'.repeat(30);
  for (let index = 0; index < 23; index++) await publish(call, input({ title: query + index }));
  const first = await browse(call, { q: query });
  assert.equal(first.body.entries.length, 20);
  assert.ok(first.body.next.length > 1100);
  const next = await browse(call, { q: query, cursor: first.body.next });
  assert.equal(next.status, 200);
  assert.equal(next.body.entries.length, 3);
});

test('network throttling does not spend the account or publishing buckets', async () => {
  const calls = [];
  const call = setup({ seedProfile: false, limiter: async (key) => {
    calls.push(key);
    return key.startsWith('write-ip:') ? 5 : 0;
  } });
  const denied = await publish(call, input());
  assert.equal(denied.status, 429);
  assert.equal(denied.headers['retry-after'], '5');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^write-ip:/);
});

test('database socket failures return a retryable response without exposing details', async () => {
  const store = memoryMarketplace();
  store.getMany = async () => { throw Object.assign(new Error('private database address'), { code: 'ECONNREFUSED' }); };
  const call = setup({ store, seedProfile: false });
  const response = await call(route('GET', 'profile'), { actor: owner });
  assert.equal(response.status, 503);
  assert.equal(response.headers['retry-after'], '2');
  assert.ok(!JSON.stringify(response.body).includes('private database address'));
});
