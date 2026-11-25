import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHandler } from '../src/app.mjs';

// In-memory stand-in for DynamoDB that understands only the expressions app.mjs uses.
function fakeDb(items) {
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

  return {
    tables,
    async send(cmd) {
      const i = cmd.input;
      switch (cmd.constructor.name) {
        case 'ScanCommand':
          return { Items: [...tables[i.TableName].values()].filter((row) =>
            holds(row, i.FilterExpression, i.ExpressionAttributeNames, i.ExpressionAttributeValues)).map((r) => ({ ...r })) };
        case 'GetCommand': {
          const row = tables[i.TableName].get(i.Key.id);
          return { Item: row && { ...row } };
        }
        case 'UpdateCommand':
          if (!check(i)) throw fail('ConditionalCheckFailedException');
          apply(i);
          return {};
        case 'TransactWriteCommand': {
          const ops = i.TransactItems.map((t) => t.Update ?? t.Put);
          const reasons = ops.map((op) => ({ Code: check(op) ? 'None' : 'ConditionalCheckFailed' }));
          if (reasons.some((r) => r.Code !== 'None')) throw fail('TransactionCanceledException', { CancellationReasons: reasons });
          ops.forEach(apply);
          return {};
        }
        default:
          throw new Error(`fake db: unhandled ${cmd.constructor.name}`);
      }
    },
  };
}

const SHOP = 'test-shop-key';
function setup(stock = 1) {
  const db = fakeDb([{ id: 'item-1', name: 'Mini drafter', stock }]);
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
  return { call, stockLeft };
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
  assert.equal((await call('PUT /shop/items/{id}', { params: { id: 'item-1' }, body: { stock: 7 }, shop: true })).status, 200);
  assert.equal(stockLeft(), 7);
  assert.equal((await call('PUT /shop/items/{id}', { params: { id: 'nope' }, body: { stock: 1 }, shop: true })).status, 404);
  assert.equal((await call('PUT /shop/items/{id}', { params: { id: 'item-1' }, body: { stock: -1 }, shop: true })).status, 400);
});
