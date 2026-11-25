import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHandler } from '../src/app.mjs';

// In-memory stand-in for DynamoDB that understands only the expressions app.mjs uses.
// It also models three real behaviours: reads without ConsistentRead miss fresh writes,
// scans come back in pages of `pageSize`, and `db.failNext` cancels the next transaction.
function fakeDb(items, { pageSize = Infinity } = {}) {
  const tables = { items: new Map(items.map((i) => [i.id, { ...i }])), reservations: new Map() };
  const holds = (row, expr, names = {}, values = {}) => {
    if (!expr) return true;
    if (expr === 'attribute_not_exists(id)') return !row;
    if (expr === 'attribute_exists(id)') return !!row;
    const [lhs, op, rhs] = expr.split(' ');
    const a = row?.[names[lhs] ?? lhs];
    return a !== undefined && (op === '>=' ? a >= values[rhs] : a === values[rhs]);
  };
  const keyOf = (op) => (op.Item ?? op.Key).id;
  const check = (op) =>
    holds(tables[op.TableName].get(keyOf(op)), op.ConditionExpression, op.ExpressionAttributeNames, op.ExpressionAttributeValues);
  const apply = (op) => {
    const table = tables[op.TableName];
    if (op.Item) return table.set(op.Item.id, { ...op.Item });
    const row = table.get(op.Key.id) ?? { id: op.Key.id };
    const names = op.ExpressionAttributeNames ?? {};
    const values = op.ExpressionAttributeValues;
    for (const part of op.UpdateExpression.replace(/^SET /, '').split(', ')) {
      const [lhs, rhs] = part.split(' = ');
      const [x, sign, y] = rhs.split(' ');
      row[names[lhs] ?? lhs] = sign ? row[names[x] ?? x] + (sign === '+' ? 1 : -1) * values[y] : values[x];
    }
    table.set(row.id, row);
  };
  const fail = (name, extra) => Object.assign(new Error(name), { name, ...extra });

  const db = {
    tables,
    failNext: null,
    async send(cmd) {
      const i = cmd.input;
      switch (cmd.constructor.name) {
        case 'ScanCommand': {
          const rows = [...tables[i.TableName].values()];
          const start = i.ExclusiveStartKey ? rows.findIndex((r) => r.id === i.ExclusiveStartKey.id) + 1 : 0;
          const page = rows.slice(start, start + pageSize);
          const more = start + pageSize < rows.length;
          return {
            Items: page.filter((row) => holds(row, i.FilterExpression, i.ExpressionAttributeNames, i.ExpressionAttributeValues))
              .map((r) => ({ ...r })),
            LastEvaluatedKey: more ? { id: page.at(-1).id } : undefined,
          };
        }
        case 'GetCommand': {
          const row = i.ConsistentRead ? tables[i.TableName].get(i.Key.id) : undefined;
          return { Item: row && { ...row } };
        }
        case 'UpdateCommand':
          if (!check(i)) {
            const row = tables[i.TableName].get(i.Key.id);
            throw fail('ConditionalCheckFailedException', i.ReturnValuesOnConditionCheckFailure && row ? { Item: row } : {});
          }
          apply(i);
          return {};
        case 'TransactWriteCommand': {
          const ops = i.TransactItems.map((t) => t.Update ?? t.Put);
          const injected = db.failNext;
          db.failNext = null;
          const reasons = ops.map((op, n) =>
            ({ Code: injected && n === 0 ? injected : check(op) ? 'None' : 'ConditionalCheckFailed' }));
          if (reasons.some((r) => r.Code !== 'None')) throw fail('TransactionCanceledException', { CancellationReasons: reasons });
          ops.forEach(apply);
          return {};
        }
        default:
          throw new Error(`fake db: unhandled ${cmd.constructor.name}`);
      }
    },
  };
  return db;
}

const SHOP = 'test-shop-key';
function setup(stock = 1, options) {
  const db = fakeDb([{ id: 'item-1', name: 'Mini drafter', stock }], options);
  const handler = makeHandler(db, { itemsTable: 'items', reservationsTable: 'reservations', shopKey: SHOP });
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
  return { call, stockLeft, db };
}

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
