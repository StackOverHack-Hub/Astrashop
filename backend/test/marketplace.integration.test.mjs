import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Redis from 'ioredis';
import { makeMarketplace } from '../src/marketplace.mjs';
import { dynamoMarketplace } from '../src/marketplace-store.mjs';
import { tokenBucket } from '../src/marketplace-limit.mjs';

const dynamoEndpoint = process.env.MARKETPLACE_DYNAMO_ENDPOINT;
const redisUrl = process.env.MARKETPLACE_REDIS_URL;

test('DynamoDB transactions and key ranges preserve browse, ownership and thread invariants', {
  skip: !dynamoEndpoint, timeout: 35_000,
}, async (context) => {
  const client = new DynamoDBClient({
    endpoint: dynamoEndpoint, region: 'us-east-1', credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' },
  });
  const name = `marketplace-${randomUUID()}`;
  const table = { TableName: name };
  await client.send(new CreateTableCommand({
    ...table, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
  }));
  context.after(async () => {
    try { await client.send(new DeleteTableCommand(table)); }
    finally { client.destroy(); }
  });
  const store = dynamoMarketplace(DynamoDBDocumentClient.from(client), name);
  const handler = makeMarketplace(store, async () => 0, {
    actorFrom: (event) => event.actor ? { id: event.actor, moderator: event.actor === 'moderator' } : undefined,
    now: () => new Date('2026-11-26T12:34:56.000Z'),
  });
  const call = async (route, { actor, id, commentId, body, query } = {}) => {
    const result = await handler({
      routeKey: route, actor, pathParameters: { id, commentId }, queryStringParameters: query,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  const item = {
    id: randomUUID(), kind: 'item', title: 'Mini drafter', description: 'Excellent condition.',
    meetup: 'Library courtyard', pricePaise: 6500,
  };
  assert.equal((await call('PUT /marketplace/profile', { actor: 'owner', body: { name: 'Seller' } })).status, 201);
  const publish = () => call('POST /marketplace/listings', { actor: 'owner', body: item });
  const submissions = await Promise.all(Array.from({ length: 16 }, publish));
  assert.equal(submissions.filter(({ status }) => status === 201).length, 1);
  assert.ok(submissions.every(({ status }) => [200, 201, 503].includes(status)));
  assert.equal((await publish()).status, 200);
  for (let index = 0; index < 24; index++) {
    const entry = { ...item, id: randomUUID(), kind: index % 2 ? 'service' : 'favor', title: `Mini lesson ${index}` };
    assert.equal((await call('POST /marketplace/listings', { actor: 'owner', body: entry })).status, 201);
  }
  const list = (query) => call('GET /marketplace/listings', { query });
  for (const query of [{ q: 'mini' }, {}]) {
    const first = await list(query);
    const second = await list({ ...query, cursor: first.body.next });
    assert.equal(first.body.entries.length, 20);
    assert.equal(second.body.entries.length, 5);
    assert.equal(new Set([...first.body.entries, ...second.body.entries].map(({ id }) => id)).size, 25);
  }
  const mine = await call('GET /marketplace/mine', { actor: 'owner' });
  const more = await call('GET /marketplace/mine', { actor: 'owner', query: { cursor: mine.body.next } });
  assert.equal(more.body.entries.length, 5);
  const contact = { id: randomUUID(), text: 'Can we meet tomorrow?' };
  const opened = await call('POST /marketplace/listings/{id}/contact', { actor: 'buyer', id: item.id, body: contact });
  assert.equal(opened.status, 201);
  const replay = await call('POST /marketplace/listings/{id}/contact', { actor: 'buyer', id: item.id, body: contact });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, opened.body.id);
  const readThread = (actor) => call('GET /marketplace/threads/{id}', { actor, id: opened.body.id });
  assert.equal((await readThread('stranger')).status, 404);
  assert.equal((await readThread('owner')).body.entries.length, 1);
  assert.equal((await call('POST /marketplace/threads/{id}', {
    actor: 'owner', id: opened.body.id, body: { id: randomUUID(), text: 'Yes, after class.' },
  })).status, 201);
  assert.equal((await readThread('buyer')).body.entries.length, 2);
  const update = (status) => call('PUT /marketplace/listings/{id}', { actor: 'owner', id: item.id, body: { version: 1, status } });
  const edits = await Promise.all([update('closed'), update('active')]);
  assert.equal(edits.filter(({ status }) => status === 200).length, 1);
  assert.ok(edits.some(({ status }) => [409, 503].includes(status)));
  assert.equal((await call('PUT /marketplace/listings/{id}/moderate', {
    actor: 'moderator', id: item.id, body: { version: 2 },
  })).status, 200);
  assert.equal((await list({ kind: 'item', q: 'mini' })).body.entries.length, 0);

  const profile = async (actor, name) => {
    const previous = await call('GET /marketplace/profile', { actor });
    return call('PUT /marketplace/profile', { actor, body: { name, about: 'I share campus supplies.', version: previous.body.profile?.version } });
  };
  const seller = await profile('owner', 'Asha');
  const buyer = await profile('buyer', 'Ravi');
  assert.equal(seller.status, 200);
  assert.equal(buyer.status, 201);
  const available = { ...item, id: randomUUID(), condition: 'good' };
  assert.equal((await call('POST /marketplace/listings', { actor: 'owner', body: available })).status, 201);
  assert.equal((await list({ kind: 'item' })).body.entries[0].seller.name, 'Asha');
  const details = await call('GET /marketplace/listings/{id}', { id: available.id });
  assert.equal(details.body.condition, 'good');
  assert.equal(details.body.seller.id, seller.body.id);

  const edit = { ...available, version: 1, status: 'active', title: 'Updated mini drafter', requestId: randomUUID() };
  const save = () => call('PUT /marketplace/listings/{id}', { actor: 'owner', id: available.id, body: edit });
  const edited = await save();
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.version, 2);
  assert.equal((await save()).body.version, 2);
  const updated = await call('GET /marketplace/listings/{id}', { id: available.id });
  assert.equal(updated.body.title, edit.title);
  const offers = await call('GET /marketplace/sellers/{id}/listings', { id: seller.body.id });
  assert.equal(offers.status, 200);
  const moreOffers = await call('GET /marketplace/sellers/{id}/listings', { id: seller.body.id, query: { cursor: offers.body.next } });
  assert.equal([...offers.body.entries, ...moreOffers.body.entries].find(({ id }) => id === available.id).title, edit.title);

  const postComment = await call('POST /marketplace/listings/{id}/comments', {
    actor: 'buyer', id: available.id, body: { id: randomUUID(), text: 'Does it come with a case?' },
  });
  assert.equal(postComment.status, 201);
  assert.equal((await call('GET /marketplace/listings/{id}/comments', { id: available.id })).body.entries[0].author.name, 'Ravi');
  const removedComment = await call('PUT /marketplace/listings/{id}/comments/{commentId}', {
    actor: 'buyer', id: available.id, commentId: postComment.body.id, body: {},
  });
  assert.equal(removedComment.status, 200);

  assert.equal((await call('PUT /marketplace/saved/{id}', { actor: 'buyer', id: available.id, body: { saved: true } })).status, 200);
  const exchange = await call('POST /marketplace/listings/{id}/contact', {
    actor: 'buyer', id: available.id, body: { id: randomUUID(), text: 'Can we meet at the library?' },
  });
  const exchangeId = exchange.body.id;
  const confirm = (actor) => call('PUT /marketplace/threads/{id}/exchange', { actor, id: exchangeId, body: {} });
  assert.equal((await confirm('buyer')).body.completed, false);
  assert.equal((await confirm('owner')).body.completed, true);
  assert.equal((await call('GET /marketplace/saved', { actor: 'buyer' })).body.entries[0].status, 'closed');
  assert.equal((await list({ kind: 'item' })).body.entries.length, 0);
  const closedOffers = await call('GET /marketplace/sellers/{id}/listings', { id: seller.body.id });
  const moreClosedOffers = await call('GET /marketplace/sellers/{id}/listings', { id: seller.body.id, query: { cursor: closedOffers.body.next } });
  assert.equal(closedOffers.body.entries.length + moreClosedOffers.body.entries.length, 24);
  assert.ok([...closedOffers.body.entries, ...moreClosedOffers.body.entries].every(({ id }) => id !== available.id));
  const review = { rating: 5, text: 'Exactly as described and an easy pickup.' };
  const sendReview = () => call('POST /marketplace/threads/{id}/review', { actor: 'buyer', id: exchangeId, body: review });
  assert.equal((await sendReview()).status, 201);
  assert.equal((await sendReview()).status, 200);
  const sellerPage = await call('GET /marketplace/sellers/{id}', { id: seller.body.id });
  assert.equal(sellerPage.body.averageRating, 5);
  assert.equal(sellerPage.body.ratingCount, 1);
  const sellerReviews = await call('GET /marketplace/sellers/{id}/reviews', { id: seller.body.id });
  assert.equal(sellerReviews.body.entries[0].text, review.text);
});

test('Redis runs the production Lua bucket atomically across clients and expires idle keys', {
  skip: !redisUrl, timeout: 10_000,
}, async (context) => {
  const first = new Redis(redisUrl, { maxRetriesPerRequest: 0, retryStrategy: () => null });
  const second = new Redis(redisUrl, { maxRetriesPerRequest: 0, retryStrategy: () => null });
  const key = `astrashop:marketplace:test:${randomUUID()}`;
  const expiryKey = `${key}:expiry`;
  context.after(async () => {
    try { await first.del(key, expiryKey); }
    finally { first.disconnect(); second.disconnect(); }
  });
  const capacity = 12;
  const results = await Promise.all(Array.from({ length: 96 }, (_, index) =>
    (index % 2 ? first : second).eval(tokenBucket, 1, key, capacity, 60_000)));
  assert.equal(results.filter((delay) => delay === 0).length, capacity);
  assert.equal(results.filter((delay) => Number(delay) > 0).length, 96 - capacity);
  assert.ok(await first.pttl(key) > 0);
  assert.equal(await first.eval(tokenBucket, 1, expiryKey, 1, 100), 0);
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(await second.exists(expiryKey), 0);
});
