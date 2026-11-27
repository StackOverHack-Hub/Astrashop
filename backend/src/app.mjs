import { randomInt, timingSafeEqual } from 'node:crypto';
import { dependencyUnavailable } from './dependency-errors.mjs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, ScanCommand, GetCommand, UpdateCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ID = 128;
const MAX_STOCK = 100000;
// Errors worth retrying: the client resends the same request and gets a real answer.
const TRANSIENT = new Set([
  'TransactionConflictException', 'ProvisionedThroughputExceededException',
  'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError',
]);
const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const isItemId = (id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID;
const isStock = (n) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_STOCK;
const firstConditionFailed = (err) => err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
// Transaction cancellation reasons that clear up on their own; anything else needs a human.
const DEFERRABLE = new Set(['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError']);

export function makeHandler(db, { itemsTable, reservationsTable, shopKey, holdMinutes = 1440, now = () => new Date() }) {
  // shortcut: one shared shop key, move to Cognito if more than one shop joins
  const isShop = (headers = {}) => {
    const given = Buffer.from(headers['x-shop-key'] ?? '');
    const want = Buffer.from(shopKey ?? '');
    return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
  };
  // Strongly consistent: a retry right after a committed reserve must see that reservation.
  const getReservation = async (id) =>
    (await db.send(new GetCommand({ TableName: reservationsTable, Key: { id }, ConsistentRead: true }))).Item;
  // Scan returns at most 1 MB per page (before any filter), so follow every page.
  const scanAll = async (input) => {
    const rows = [];
    let ExclusiveStartKey;
    do {
      const page = await db.send(new ScanCommand({ ...input, ExclusiveStartKey }));
      rows.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return rows;
  };
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
  // Close a hold and put its unit back on the shelf in one transaction (release or expiry).
  const endHold = (r, to) => db.send(new TransactWriteCommand({
    TransactItems: [
      { Update: setStatus(r.id, to, { endedAt: now().toISOString() }) },
      { Update: {
        TableName: itemsTable, Key: { id: r.itemId },
        UpdateExpression: 'SET stock = stock + :one',
        ExpressionAttributeValues: { ':one': 1 },
      } },
    ],
  }));
  const heldReservations = () => scanAll({
    TableName: reservationsTable,
    FilterExpression: '#s = :held',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':held': 'HELD' },
  });

  // Holds made before expiry existed have no expiresAt: give them the same window from createdAt.
  const deadline = (r) => r.expiresAt ?? new Date(Date.parse(r.createdAt) + holdMinutes * 60_000).toISOString();

  // Runs on a schedule: holds past their deadline return to stock, so nobody can hoard units.
  // shortcut: scans every reservation; switch to a status/expiresAt GSI past a few thousand rows.
  const expireHolds = async () => {
    const cutoff = now().toISOString();
    const counts = { expired: 0, deferred: 0, failed: 0 };
    for (const r of await heldReservations()) {
      if (deadline(r) > cutoff) continue;
      try {
        await endHold(r, 'EXPIRED');
        counts.expired += 1;
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        const codes = err.CancellationReasons?.map((reason) => reason.Code) ?? [];
        if (codes[0] === 'ConditionalCheckFailed') continue; // collected or released since the scan
        if (codes.some((code) => DEFERRABLE.has(code))) {
          counts.deferred += 1; // the next run, 10 minutes later, retries it
          continue;
        }
        counts.failed += 1;
        console.error(JSON.stringify({ event: 'hold_expiry_failed', reservationId: r.id, itemId: r.itemId, reasons: codes }));
      }
    }
    console.info(JSON.stringify({ event: 'holds_expired', ...counts }));
    // Fail the run so FunctionErrorsAlarm fires; the failed holds stay HELD and are retried.
    if (counts.failed > 0) throw new Error(`${counts.failed} hold(s) could not expire; see hold_expiry_failed logs`);
    return counts;
  };

  const routes = {
    'GET /items': async () => json(200, await scanAll({ TableName: itemsTable })),

    // The client generates the reservation id once and reuses it on every retry,
    // so a retried request returns the same hold instead of taking a second unit.
    'POST /reservations': async ({ body }) => {
      const { id, itemId } = body;
      if (typeof id !== 'string' || !UUID.test(id) || !isItemId(itemId)) {
        return json(400, { error: 'id (uuid) and itemId are required' });
      }
      // shortcut: codes are random, not unique; two holds on the same item sharing a code are
      // interchangeable at the counter. Claim codes in the transaction if holds span many shops.
      const created = now();
      const reservation = {
        id, itemId, code: String(randomInt(100000, 1000000)), status: 'HELD',
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + holdMinutes * 60_000).toISOString(),
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
        if (firstConditionFailed(err)) return json(409, { error: 'Out of stock' });
        return json(503, { error: 'Busy, retry with the same id' });
      }
    },

    'GET /reservations/{id}': async ({ params }) => {
      const r = UUID.test(params.id ?? '') && await getReservation(params.id);
      return r ? json(200, r) : json(404, { error: 'Not found' });
    },

    // shortcut: Scan is fine for one pilot shop, add a status GSI past a few thousand reservations
    // Expired holds stay listed until the shopkeeper marks them returned: their unit is still in
    // the set-aside pile (however long the shop was closed) and must go back before a recount.
    'GET /shop/reservations': async () => {
      const rows = await scanAll({ TableName: reservationsTable, ConsistentRead: true });
      const listed = rows.filter((r) => r.status === 'HELD' || (r.status === 'EXPIRED' && !r.returnedAt));
      return json(200, listed.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    },

    // Record when the shop first confirms the unit is physically set aside.
    'POST /shop/reservations/{id}/set-aside': async ({ params }) => {
      if (!UUID.test(params.id ?? '')) return json(404, { error: 'Not found' });
      try {
        await db.send(new UpdateCommand({
          TableName: reservationsTable, Key: { id: params.id },
          UpdateExpression: 'SET setAsideAt = if_not_exists(setAsideAt, :now)',
          ConditionExpression: '#s = :held',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':now': now().toISOString(), ':held': 'HELD' },
        }));
        return json(200, { id: params.id, status: 'HELD' });
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') return json(409, { error: 'Reservation is not on hold' });
        throw err;
      }
    },

    // App activity from every reservation. The pilot separately tracks the student's start and deadline.
    'GET /shop/stats': async () => {
      const rows = await scanAll({ TableName: reservationsTable, ConsistentRead: true });
      const minutes = (from, to) => (Date.parse(to) - Date.parse(from)) / 60_000;
      const median = (values) => {
        if (values.length === 0) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = sorted.length >> 1;
        const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        return Math.round(value * 10) / 10;
      };
      const withStatus = (status) => rows.filter((r) => r.status === status).length;
      return json(200, {
        reservations: rows.length,
        waitingToSetAside: rows.filter((r) => r.status === 'HELD' && !r.setAsideAt).length,
        setAside: rows.filter((r) => r.setAsideAt).length,
        collected: withStatus('COLLECTED'),
        expired: withStatus('EXPIRED'),
        released: withStatus('RELEASED'),
        medianMinutesToSetAside: median(rows.filter((r) => r.setAsideAt).map((r) => minutes(r.createdAt, r.setAsideAt))),
        medianMinutesToCollect: median(rows.filter((r) => r.collectedAt).map((r) => minutes(r.createdAt, r.collectedAt))),
        since: rows.map((r) => r.createdAt).sort()[0] ?? null,
      });
    },

    // Expiry already restored the stock. This only clears the physical shelf reminder.
    'POST /shop/reservations/{id}/returned': async ({ params }) => {
      if (!UUID.test(params.id ?? '')) return json(404, { error: 'Not found' });
      try {
        await db.send(new UpdateCommand({
          TableName: reservationsTable, Key: { id: params.id },
          UpdateExpression: 'SET returnedAt = :now',
          ConditionExpression: '#s = :expired',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':now': now().toISOString(), ':expired': 'EXPIRED' },
        }));
        return json(200, { id: params.id, status: 'EXPIRED' });
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') return json(409, { error: 'Only expired holds can be marked returned' });
        throw err;
      }
    },

    // stock = units on the shelf, not counting units already set aside for a hold.
    // expectedStock is the value the shopkeeper saw: if a reservation or release landed
    // since, the recount is stale and would hand out a unit that is already set aside.
    'PUT /shop/items/{id}': async ({ params, body }) => {
      if (!isItemId(params.id)) return json(404, { error: 'Item not found' });
      if (!isStock(body.stock) || !isStock(body.expectedStock)) {
        return json(400, { error: `stock and expectedStock must be whole numbers from 0 to ${MAX_STOCK}` });
      }
      try {
        await db.send(new UpdateCommand({
          TableName: itemsTable, Key: { id: params.id },
          UpdateExpression: 'SET stock = :stock, confirmedAt = :now',
          ConditionExpression: 'stock = :expected',
          ExpressionAttributeValues: { ':stock': body.stock, ':expected': body.expectedStock, ':now': now().toISOString() },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }));
        return json(200, { id: params.id, stock: body.stock });
      } catch (err) {
        if (err.name !== 'ConditionalCheckFailedException') throw err;
        return err.Item
          ? json(409, { error: 'Stock changed since you loaded it. Refresh and recount.' })
          : json(404, { error: 'Item not found' });
      }
    },

    'POST /shop/reservations/{id}/collect': async ({ params }) => {
      if (!UUID.test(params.id ?? '')) return json(404, { error: 'Not found' });
      try {
        await db.send(new UpdateCommand(setStatus(params.id, 'COLLECTED', { collectedAt: now().toISOString() })));
        return json(200, { id: params.id, status: 'COLLECTED' });
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') return json(409, { error: 'Reservation is not on hold' });
        throw err;
      }
    },

    // Guarded on HELD so releasing twice cannot put the unit back on the shelf twice.
    'POST /shop/reservations/{id}/release': async ({ params }) => {
      const r = UUID.test(params.id ?? '') && await getReservation(params.id);
      if (!r) return json(404, { error: 'Not found' });
      try {
        await endHold(r, 'RELEASED');
        return json(200, { id: r.id, status: 'RELEASED' });
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        return firstConditionFailed(err)
          ? json(409, { error: 'Reservation is not on hold' })
          : json(503, { error: 'Busy, try again' });
      }
    },
  };

  return async (event) => {
    if (event.source === 'aws.events') return expireHolds();
    const route = routes[event.routeKey];
    if (!route) return json(404, { error: 'Not found' });
    if (event.routeKey.includes(' /shop/') && !isShop(event.headers)) {
      // Security event for CloudWatch; never log the key itself.
      console.warn(JSON.stringify({ event: 'shop_key_rejected', route: event.routeKey, ip: event.requestContext?.http?.sourceIp }));
      return json(401, { error: 'Shop key required' });
    }
    let body;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
      body = (raw ? JSON.parse(raw) : null) ?? {};
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }
    try {
      return await route({ body, params: event.pathParameters ?? {} });
    } catch (err) {
      if (TRANSIENT.has(err.name) || dependencyUnavailable(err)) return { ...json(503, { error: 'Busy, try again' }), headers: { 'content-type': 'application/json', 'retry-after': '2' } };
      console.error(err);
      return json(500, { error: 'Something went wrong' });
    }
  };
}

export const handler = makeHandler(DynamoDBDocumentClient.from(new DynamoDBClient({})), {
  itemsTable: process.env.ITEMS_TABLE,
  reservationsTable: process.env.RESERVATIONS_TABLE,
  shopKey: process.env.SHOP_KEY,
  holdMinutes: Number(process.env.HOLD_MINUTES) || 1440,
});
