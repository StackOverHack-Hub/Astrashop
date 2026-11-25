import { randomInt, timingSafeEqual } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, ScanCommand, GetCommand, UpdateCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

export function makeHandler(db, { itemsTable, reservationsTable, shopKey }) {
  // shortcut: one shared shop key, move to Cognito if more than one shop joins
  const isShop = (headers = {}) => {
    const given = Buffer.from(headers['x-shop-key'] ?? '');
    const want = Buffer.from(shopKey ?? '');
    return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
  };
  const getReservation = async (id) =>
    (await db.send(new GetCommand({ TableName: reservationsTable, Key: { id } }))).Item;
  const setStatus = (id, to, extra = {}) => ({
    TableName: reservationsTable,
    Key: { id },
    UpdateExpression: `SET #s = :to${Object.keys(extra).map((k) => `, ${k} = :${k}`).join('')}`,
    ConditionExpression: '#s = :held',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':to': to, ':held': 'HELD',
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`:${k}`, v])),
    },
  });

  const routes = {
    'GET /items': async () =>
      json(200, (await db.send(new ScanCommand({ TableName: itemsTable }))).Items ?? []),

    // The client generates the reservation id once and reuses it on every retry,
    // so a retried request returns the same hold instead of taking a second unit.
    'POST /reservations': async ({ body }) => {
      const { id, itemId } = body;
      if (typeof id !== 'string' || !UUID.test(id) || typeof itemId !== 'string' || !itemId) {
        return json(400, { error: 'id (uuid) and itemId are required' });
      }
      const reservation = {
        id, itemId, code: String(randomInt(100000, 1000000)), status: 'HELD', createdAt: new Date().toISOString(),
      };
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: [
            { Update: {
              TableName: itemsTable, Key: { id: itemId },
              UpdateExpression: 'SET stock = stock - :one',
              ConditionExpression: 'stock >= :one',
              ExpressionAttributeValues: { ':one': 1 },
            } },
            { Put: { TableName: reservationsTable, Item: reservation, ConditionExpression: 'attribute_not_exists(id)' } },
          ],
        }));
        return json(201, reservation);
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        const existing = await getReservation(id);
        if (existing) {
          return existing.itemId === itemId ? json(200, existing) : json(409, { error: 'Reservation id already used' });
        }
        if (err.CancellationReasons?.some((r) => r.Code === 'TransactionConflict')) {
          return json(503, { error: 'Busy, retry with the same id' });
        }
        return json(409, { error: 'Out of stock' });
      }
    },

    'GET /reservations/{id}': async ({ params }) => {
      const r = await getReservation(params.id);
      return r ? json(200, r) : json(404, { error: 'Not found' });
    },

    // shortcut: Scan is fine for one pilot shop, add a status GSI past a few thousand reservations
    'GET /shop/reservations': async () => {
      const { Items = [] } = await db.send(new ScanCommand({
        TableName: reservationsTable,
        FilterExpression: '#s = :held',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':held': 'HELD' },
      }));
      return json(200, Items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    },

    // stock = units on the shelf, not counting units already set aside for a hold
    'PUT /shop/items/{id}': async ({ params, body }) => {
      if (!Number.isInteger(body.stock) || body.stock < 0) return json(400, { error: 'stock must be a whole number >= 0' });
      try {
        await db.send(new UpdateCommand({
          TableName: itemsTable, Key: { id: params.id },
          UpdateExpression: 'SET stock = :stock, confirmedAt = :now',
          ConditionExpression: 'attribute_exists(id)',
          ExpressionAttributeValues: { ':stock': body.stock, ':now': new Date().toISOString() },
        }));
        return json(200, { id: params.id, stock: body.stock });
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') return json(404, { error: 'Item not found' });
        throw err;
      }
    },

    'POST /shop/reservations/{id}/collect': async ({ params }) => {
      try {
        await db.send(new UpdateCommand(setStatus(params.id, 'COLLECTED', { collectedAt: new Date().toISOString() })));
        return json(200, { id: params.id, status: 'COLLECTED' });
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') return json(409, { error: 'Reservation is not on hold' });
        throw err;
      }
    },

    // Guarded on HELD so releasing twice cannot put the unit back on the shelf twice.
    'POST /shop/reservations/{id}/release': async ({ params }) => {
      const r = await getReservation(params.id);
      if (!r) return json(404, { error: 'Not found' });
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: [
            { Update: setStatus(r.id, 'RELEASED') },
            { Update: {
              TableName: itemsTable, Key: { id: r.itemId },
              UpdateExpression: 'SET stock = stock + :one',
              ExpressionAttributeValues: { ':one': 1 },
            } },
          ],
        }));
        return json(200, { id: r.id, status: 'RELEASED' });
      } catch (err) {
        if (err.name === 'TransactionCanceledException') return json(409, { error: 'Reservation is not on hold' });
        throw err;
      }
    },
  };

  return async (event) => {
    const route = routes[event.routeKey];
    if (!route) return json(404, { error: 'Not found' });
    if (event.routeKey.includes(' /shop/') && !isShop(event.headers)) return json(401, { error: 'Shop key required' });
    let body;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
      body = (raw ? JSON.parse(raw) : null) ?? {};
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }
    return route({ body, params: event.pathParameters ?? {} });
  };
}

export const handler = makeHandler(DynamoDBDocumentClient.from(new DynamoDBClient({})), {
  itemsTable: process.env.ITEMS_TABLE,
  reservationsTable: process.env.RESERVATIONS_TABLE,
  shopKey: process.env.SHOP_KEY,
});
