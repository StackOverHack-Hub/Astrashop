import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { dependencyUnavailable } from './dependency-errors.mjs';
import { signedInUser } from './marketplace-shared.mjs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, ScanCommand, QueryCommand, GetCommand, UpdateCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHOP_ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const MAX_ID = 128;
const MAX_STOCK = 100000;
const AUDIT_DAYS = 365;
// Errors worth retrying: the client resends the same request and gets a real answer.
const TRANSIENT = new Set([
  'TransactionConflictException', 'ProvisionedThroughputExceededException',
  'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError',
]);
const json = (statusCode, body, headers = {}) => ({
  statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const isItemId = (id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID;
const isStock = (n) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_STOCK;
const cancelled = (err) => err.CancellationReasons?.map((reason) => reason.Code) ?? [];
// Transaction cancellation reasons that clear up on their own; anything else needs a human.
const DEFERRABLE = new Set(['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError']);
// Internal index keys never leave the API.
const view = ({ queueShop, studentId, ...reservation }) => reservation;

// Shop routes as the people who use them: anyone, a signed-in student, the shop's staff or owner,
// or a platform admin. A route that is not listed here does not exist.
const access = {
  'GET /shops/{shopId}/items': 'public',
  'GET /reservations/{id}': 'public', // the id is a random secret only the student's phone knows
  'GET /me': 'signedIn',
  'POST /reservations': 'signedIn',
  'GET /shops/{shopId}/reservations': 'staff',
  'GET /shops/{shopId}/stats': 'staff',
  'PUT /shops/{shopId}/items/{id}': 'staff',
  'POST /shops/{shopId}/reservations/{id}/set-aside': 'staff',
  'POST /shops/{shopId}/reservations/{id}/collect': 'staff',
  'POST /shops/{shopId}/reservations/{id}/release': 'staff',
  'POST /shops/{shopId}/reservations/{id}/returned': 'staff',
  'PUT /shops/{shopId}/staff/{userId}': 'owner',
  'POST /admin/shops': 'platform',
};

export function shopActor(event) {
  const user = signedInUser(event);
  return user && { id: user.id, platformAdmin: user.groups.includes('PlatformAdmins') };
}

export function makeHandler(db, {
  itemsTable, reservationsTable, tenancyTable, shopKey, defaultShopId = 'campus-shop',
  holdMinutes = 1440, maxHolds = 3, actorFrom = shopActor, now = () => new Date(),
}) {
  // shortcut: the shared counter key from the single-shop pilot still opens that shop's counter.
  // Remove it (unset SHOP_KEY) once the pilot shop's staff sign in with accounts.
  const isShop = (headers = {}) => {
    const given = Buffer.from(headers['x-shop-key'] ?? '');
    const want = Buffer.from(shopKey ?? '');
    return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
  };
  // Rows written before shops existed belong to the pilot shop until the migration stamps them.
  const shopOf = (row) => row.shopId ?? defaultShopId;
  // Strongly consistent: a retry or a staff action right after a write must see it.
  const get = async (TableName, Key) => (await db.send(new GetCommand({ TableName, Key, ConsistentRead: true }))).Item;
  const getReservation = (id) => get(reservationsTable, { id });
  const shopRow = (shopId) => ({ pk: 'SHOP', sk: shopId });
  const staffRow = (shopId, userId) => ({ pk: `SHOP#${shopId}`, sk: `STAFF#${userId}` });
  const holdsRow = (studentId, shopId) => ({ pk: `STUDENT#${studentId}`, sk: `HOLDS#${shopId}` });
  // A Scan or Query returns at most 1 MB per page (before any filter), so follow every page.
  const readAll = async (Command, input) => {
    const rows = [];
    let ExclusiveStartKey;
    do {
      const page = await db.send(new Command({ ...input, ExclusiveStartKey }));
      rows.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return rows;
  };
  const audit = (shopId, actor, action, target, detail = {}) => {
    const at = now();
    return { Put: { TableName: tenancyTable, Item: {
      pk: `SHOP#${shopId}`, sk: `AUDIT#${at.toISOString()}#${randomUUID()}`, actor: actor.id, action, target, ...detail,
      at: at.toISOString(), expires: Math.floor(at.getTime() / 1000) + AUDIT_DAYS * 86_400,
    } } };
  };
  const one = { ':one': 1, ':zero': 0 };
  const restock = (itemId) => ({ Update: {
    TableName: itemsTable, Key: { id: itemId },
    UpdateExpression: 'SET stock = stock + :one, version = if_not_exists(version, :zero) + :one',
    ExpressionAttributeValues: one,
  } });

  // End a hold: status change first (cancellation reasons are read by position), then the shelf,
  // the student's hold count, and the audit entry, all in one transaction.
  const endHold = async (r, to, { actor, stamp = 'endedAt', counter = true } = {}) => {
    const when = now().toISOString();
    const expired = to === 'EXPIRED';
    const items = [
      { Update: {
        TableName: reservationsTable, Key: { id: r.id },
        // An expired hold stays in the counter queue until staff put the unit back on the shelf.
        UpdateExpression: `SET #s = :to, ${stamp} = :when${expired ? '' : ' REMOVE queueShop'}`,
        ConditionExpression: '#s = :held',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':to': to, ':held': 'HELD', ':when': when },
      } },
      ...(to === 'COLLECTED' ? [] : [restock(r.itemId)]),
      // Holds made before sign-in existed have no student and no count to give back.
      ...(counter && r.studentId ? [{ Update: {
        TableName: tenancyTable, Key: holdsRow(r.studentId, shopOf(r)),
        UpdateExpression: 'SET active = active - :one',
        ConditionExpression: 'active > :zero',
        ExpressionAttributeValues: one,
      } }] : []),
      ...(actor ? [audit(shopOf(r), actor, to.toLowerCase(), r.id)] : []),
    ];
    try {
      await db.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (err) {
      const codes = cancelled(err);
      const counterAt = to === 'COLLECTED' ? 1 : 2;
      // A lost or reset count must never stop a pickup: finish without it and leave a trail.
      if (counter && r.studentId && codes[0] === 'None' && codes[counterAt] === 'ConditionalCheckFailed') {
        console.error(JSON.stringify({ event: 'hold_count_mismatch', reservationId: r.id }));
        return endHold(r, to, { actor, stamp, counter: false });
      }
      throw err;
    }
  };

  // Runs on a schedule: holds past their deadline return to stock, so nobody can hoard units.
  const expireHolds = async () => {
    const cutoff = now().toISOString();
    const counts = { expired: 0, deferred: 0, failed: 0 };
    const shops = await readAll(QueryCommand, {
      TableName: tenancyTable, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'SHOP' },
    });
    for (const shopId of new Set([defaultShopId, ...shops.map((shop) => shop.sk)])) {
      const due = await readAll(QueryCommand, {
        TableName: reservationsTable, IndexName: 'Queue',
        KeyConditionExpression: 'queueShop = :shop AND expiresAt <= :cutoff',
        FilterExpression: '#s = :held',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':shop': shopId, ':cutoff': cutoff, ':held': 'HELD' },
      });
      for (const r of due) {
        try {
          await endHold(r, 'EXPIRED');
          counts.expired += 1;
        } catch (err) {
          if (err.name !== 'TransactionCanceledException') throw err;
          const codes = cancelled(err);
          if (codes[0] === 'ConditionalCheckFailed') continue; // collected or released since the query
          if (codes.some((code) => DEFERRABLE.has(code))) {
            counts.deferred += 1; // the next run, 10 minutes later, retries it
            continue;
          }
          counts.failed += 1;
          console.error(JSON.stringify({ event: 'hold_expiry_failed', reservationId: r.id, itemId: r.itemId, reasons: codes }));
        }
      }
    }
    console.info(JSON.stringify({ event: 'holds_expired', ...counts }));
    // Fail the run so FunctionErrorsAlarm fires; the failed holds stay HELD and are retried.
    if (counts.failed > 0) throw new Error(`${counts.failed} hold(s) could not expire; see hold_expiry_failed logs`);
    return counts;
  };

  // A reservation of this shop, or nothing: another shop's id looks exactly like an unknown one.
  const shopReservation = async (shopId, id) => {
    const r = UUID.test(id ?? '') && await getReservation(id);
    return r && shopOf(r) === shopId ? r : undefined;
  };
  const notFound = () => json(404, { error: 'Not found' });
  const notHeld = () => json(409, { error: 'Reservation is not on hold' });

  const routes = {
    'GET /shops/{shopId}/items': async ({ params }) => json(200, await readAll(QueryCommand, {
      TableName: itemsTable, IndexName: 'ByShop', KeyConditionExpression: 'shopId = :shop',
      ExpressionAttributeValues: { ':shop': params.shopId },
    })),

    'GET /me': async ({ actor }) => {
      const shops = await readAll(QueryCommand, {
        TableName: tenancyTable, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `USER#${actor.id}` },
      });
      return json(200, {
        id: actor.id, platformAdmin: Boolean(actor.platformAdmin),
        shops: shops.map(({ sk, name, role }) => ({ shopId: sk.slice('SHOP#'.length), name, role })),
      });
    },

    // The client generates the reservation id once and reuses it on every retry,
    // so a retried request returns the same hold instead of taking a second unit.
    'POST /reservations': async ({ body, actor }) => {
      const { id, itemId } = body;
      if (typeof id !== 'string' || !UUID.test(id) || !isItemId(itemId)) {
        return json(400, { error: 'id (uuid) and itemId are required' });
      }
      const returnExisting = async () => {
        const existing = await getReservation(id);
        if (!existing) return;
        return existing.itemId === itemId && existing.studentId === actor.id
          ? json(200, view(existing)) : json(409, { error: 'Reservation id already used' });
      };
      const item = await get(itemsTable, { id: itemId });
      if (!item) return await returnExisting() ?? json(404, { error: 'Item not found' });
      const shopId = shopOf(item);
      // shortcut: codes are random, not unique; two holds on the same item sharing a code are
      // interchangeable at the counter. Claim codes in the transaction if a shop sees code clashes.
      const created = now();
      const reservation = {
        id, itemId, shopId, studentId: actor.id, code: String(randomInt(100000, 1000000)), status: 'HELD',
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + holdMinutes * 60_000).toISOString(),
        queueShop: shopId,
      };
      try {
        await db.send(new TransactWriteCommand({
          TransactItems: [
            { Update: {
              TableName: itemsTable, Key: { id: itemId },
              UpdateExpression: 'SET stock = stock - :one, version = if_not_exists(version, :zero) + :one',
              ConditionExpression: 'stock >= :one',
              ExpressionAttributeValues: one,
            } },
            { Put: { TableName: reservationsTable, Item: reservation, ConditionExpression: 'attribute_not_exists(id)' } },
            { Update: {
              TableName: tenancyTable, Key: holdsRow(actor.id, shopId),
              UpdateExpression: 'SET active = if_not_exists(active, :zero) + :one',
              ConditionExpression: 'attribute_not_exists(active) OR active < :max',
              ExpressionAttributeValues: { ...one, ':max': maxHolds },
            } },
            // The pilot shop may have no row yet; any other shop must not be suspended.
            { ConditionCheck: {
              TableName: tenancyTable, Key: shopRow(shopId),
              ConditionExpression: 'attribute_not_exists(sk) OR #st <> :suspended',
              ExpressionAttributeNames: { '#st': 'status' },
              ExpressionAttributeValues: { ':suspended': 'suspended' },
            } },
          ],
        }));
        return json(201, view(reservation));
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        // A retry of a hold that already went through must get that hold back, even if it took
        // the last unit or the student's last free hold, so look for it before reading the reasons.
        const existing = await returnExisting();
        if (existing) return existing;
        const codes = cancelled(err);
        if (codes[0] === 'ConditionalCheckFailed') return json(409, { error: 'Out of stock' });
        if (codes[2] === 'ConditionalCheckFailed') {
          return json(409, { code: 'HOLD_LIMIT', error: `You already have ${maxHolds} items on hold at this shop. Collect one before reserving another.` });
        }
        if (codes[3] === 'ConditionalCheckFailed') return json(403, { error: 'This shop is not taking reservations right now.' });
        return json(503, { error: 'Busy, retry with the same id' });
      }
    },

    'GET /reservations/{id}': async ({ params }) => {
      const r = UUID.test(params.id ?? '') && await getReservation(params.id);
      return r ? json(200, view(r)) : notFound();
    },

    // Expired holds stay listed until the shopkeeper marks them returned: their unit is still in
    // the set-aside pile (however long the shop was closed) and must go back before a recount.
    'GET /shops/{shopId}/reservations': async ({ params }) => {
      const rows = await readAll(QueryCommand, {
        TableName: reservationsTable, IndexName: 'Queue', KeyConditionExpression: 'queueShop = :shop',
        ExpressionAttributeValues: { ':shop': params.shopId },
      });
      return json(200, rows.map(view).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    },

    // Record when the shop first confirms the unit is physically set aside.
    'POST /shops/{shopId}/reservations/{id}/set-aside': async ({ params, actor }) => {
      const r = await shopReservation(params.shopId, params.id);
      if (!r) return notFound();
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Update: {
            TableName: reservationsTable, Key: { id: r.id },
            UpdateExpression: 'SET setAsideAt = if_not_exists(setAsideAt, :now)',
            ConditionExpression: '#s = :held',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':now': now().toISOString(), ':held': 'HELD' },
          } },
          audit(params.shopId, actor, 'set-aside', r.id),
        ] }));
        return json(200, { id: r.id, status: 'HELD' });
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        return cancelled(err)[0] === 'ConditionalCheckFailed' ? notHeld() : json(503, { error: 'Busy, try again' });
      }
    },

    // App activity from every reservation. The pilot separately tracks the student's start and deadline.
    // shortcut: scans every shop's reservations; add a shopId + createdAt index with the Phase 2
    // activity screen (CloudFormation adds one index per table per deploy).
    'GET /shops/{shopId}/stats': async ({ params }) => {
      const rows = (await readAll(ScanCommand, { TableName: reservationsTable, ConsistentRead: true }))
        .filter((r) => shopOf(r) === params.shopId);
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
    'POST /shops/{shopId}/reservations/{id}/returned': async ({ params, actor }) => {
      const r = await shopReservation(params.shopId, params.id);
      if (!r) return notFound();
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Update: {
            TableName: reservationsTable, Key: { id: r.id },
            UpdateExpression: 'SET returnedAt = if_not_exists(returnedAt, :now) REMOVE queueShop',
            ConditionExpression: '#s = :expired',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':now': now().toISOString(), ':expired': 'EXPIRED' },
          } },
          audit(params.shopId, actor, 'returned', r.id),
        ] }));
        return json(200, { id: r.id, status: 'EXPIRED' });
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        return cancelled(err)[0] === 'ConditionalCheckFailed'
          ? json(409, { error: 'Only expired holds can be marked returned' }) : json(503, { error: 'Busy, try again' });
      }
    },

    // stock = units on the shelf, not counting units already set aside for a hold.
    // The shopkeeper sends the version they loaded (older screens send the stock they saw): if a
    // reservation, release or expiry landed since, the recount is stale and is refused.
    'PUT /shops/{shopId}/items/{id}': async ({ params, body, actor }) => {
      if (!isItemId(params.id)) return notFound();
      const byVersion = body.expectedVersion !== undefined;
      if (!isStock(body.stock) || !isStock(byVersion ? body.expectedVersion : body.expectedStock)) {
        return json(400, { error: `stock and expectedVersion (or expectedStock) must be whole numbers from 0 to ${MAX_STOCK}` });
      }
      const item = await get(itemsTable, { id: params.id });
      if (!item || shopOf(item) !== params.shopId) return json(404, { error: 'Item not found' });
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Update: {
            TableName: itemsTable, Key: { id: params.id },
            UpdateExpression: 'SET stock = :stock, confirmedAt = :now, version = if_not_exists(version, :zero) + :one',
            ConditionExpression: !byVersion ? 'stock = :expected'
              : body.expectedVersion === 0 ? 'attribute_not_exists(version) OR version = :expected' : 'version = :expected',
            ExpressionAttributeValues: {
              ...one, ':stock': body.stock, ':now': now().toISOString(),
              ':expected': byVersion ? body.expectedVersion : body.expectedStock,
            },
          } },
          audit(params.shopId, actor, 'recount', params.id, { before: item.stock, after: body.stock }),
        ] }));
        return json(200, { id: params.id, stock: body.stock, version: (item.version ?? 0) + 1 });
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        return cancelled(err)[0] === 'ConditionalCheckFailed'
          ? json(409, { error: 'Stock changed since you loaded it. Refresh and recount.' }) : json(503, { error: 'Busy, try again' });
      }
    },

    'POST /shops/{shopId}/reservations/{id}/collect': async ({ params, actor }) => {
      const r = await shopReservation(params.shopId, params.id);
      if (!r) return notFound();
      try {
        await endHold(r, 'COLLECTED', { actor, stamp: 'collectedAt' });
        return json(200, { id: r.id, status: 'COLLECTED' });
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        return cancelled(err)[0] === 'ConditionalCheckFailed' ? notHeld() : json(503, { error: 'Busy, try again' });
      }
    },

    // Guarded on HELD so releasing twice cannot put the unit back on the shelf twice.
    'POST /shops/{shopId}/reservations/{id}/release': async ({ params, actor }) => {
      const r = await shopReservation(params.shopId, params.id);
      if (!r) return notFound();
      try {
        await endHold(r, 'RELEASED', { actor });
        return json(200, { id: r.id, status: 'RELEASED' });
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        return cancelled(err)[0] === 'ConditionalCheckFailed' ? notHeld() : json(503, { error: 'Busy, try again' });
      }
    },

    // role: 'owner', 'staff', or null to remove. Staff are identified by their sign-in account id.
    'PUT /shops/{shopId}/staff/{userId}': async ({ params, body, actor }) => {
      const { userId, shopId } = params;
      const role = body.role ?? null;
      if (!UUID.test(userId ?? '') || ![null, 'owner', 'staff'].includes(role)) {
        return json(400, { error: 'userId must be an account id and role must be owner, staff, or null' });
      }
      // Changing your own access could leave the shop without an owner.
      if (userId === actor.id) return json(409, { error: 'Ask another owner or a platform admin to change your access.' });
      const shop = await get(tenancyTable, shopRow(shopId));
      if (!shop) return json(404, { error: 'Shop not found' });
      const memberRows = [staffRow(shopId, userId), { pk: `USER#${userId}`, sk: `SHOP#${shopId}` }];
      const at = now().toISOString();
      await db.send(new TransactWriteCommand({ TransactItems: [
        ...memberRows.map((Key) => role
          ? { Put: { TableName: tenancyTable, Item: { ...Key, role, name: shop.name, addedBy: actor.id, addedAt: at } } }
          : { Delete: { TableName: tenancyTable, Key } }),
        audit(shopId, actor, 'staff', userId, { role }),
      ] }));
      return json(200, { shopId, userId, role });
    },

    'POST /admin/shops': async ({ body, actor }) => {
      const { id, name, ownerId } = body;
      const pickupWindow = body.pickupWindow ?? '';
      if (typeof id !== 'string' || !SHOP_ID.test(id) || typeof name !== 'string' || name.trim().length < 2 || name.length > 80
        || !UUID.test(ownerId ?? '') || typeof pickupWindow !== 'string' || pickupWindow.length > 80) {
        return json(400, { error: 'id (3-40 lowercase letters, digits, dashes), name, and ownerId are required' });
      }
      const at = now().toISOString();
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Put: {
            TableName: tenancyTable, ConditionExpression: 'attribute_not_exists(sk)',
            Item: { ...shopRow(id), name: name.trim(), pickupWindow, status: 'trial', plan: 'trial', createdAt: at, createdBy: actor.id },
          } },
          ...[staffRow(id, ownerId), { pk: `USER#${ownerId}`, sk: `SHOP#${id}` }].map((Key) => ({ Put: {
            TableName: tenancyTable, Item: { ...Key, role: 'owner', name: name.trim(), addedBy: actor.id, addedAt: at },
          } })),
          audit(id, actor, 'shop-created', id, { ownerId }),
        ] }));
        return json(201, { id, name: name.trim(), status: 'trial', ownerId });
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        return cancelled(err)[0] === 'ConditionalCheckFailed' ? json(409, { error: 'That shop id is taken' }) : json(503, { error: 'Busy, try again' });
      }
    },
  };

  return async (event) => {
    if (event.source === 'aws.events') return expireHolds();
    let routeKey = event.routeKey ?? '';
    const params = { ...event.pathParameters };
    // The pilot's routes stay available for its single shop while it moves to accounts.
    const legacy = routeKey.includes(' /shop/');
    if (legacy) routeKey = routeKey.replace(' /shop/', ' /shops/{shopId}/');
    if (legacy || routeKey === 'GET /items') params.shopId = defaultShopId;
    if (routeKey === 'GET /items') routeKey = 'GET /shops/{shopId}/items';
    const need = access[routeKey];
    if (!need) return notFound();
    if (params.shopId !== undefined && !SHOP_ID.test(params.shopId)) return notFound();

    let actor;
    if (legacy) {
      if (!isShop(event.headers)) {
        // Security event for CloudWatch; never log the key itself.
        console.warn(JSON.stringify({ event: 'shop_key_rejected', route: event.routeKey, ip: event.requestContext?.http?.sourceIp }));
        return json(401, { error: 'Shop key required' });
      }
      actor = { id: 'shop-key' };
    } else if (need !== 'public') {
      actor = actorFrom(event);
      if (!actor?.id) return json(401, { error: 'Sign in to continue.' });
    }

    let body;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
      body = (raw ? JSON.parse(raw) : null) ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }
    try {
      if (need === 'platform' && !actor.platformAdmin) return json(403, { error: 'Platform admin access is required.' });
      if ((need === 'staff' || need === 'owner') && !legacy) {
        const role = (await get(tenancyTable, staffRow(params.shopId, actor.id)))?.role;
        const allowed = need === 'staff' ? Boolean(role) : role === 'owner' || actor.platformAdmin;
        // Someone with no role at this shop learns nothing about it, not even that it exists.
        if (!allowed) return role ? json(403, { error: 'Owner access is required.' }) : notFound();
      }
      return await routes[routeKey]({ body, params, actor });
    } catch (err) {
      if (TRANSIENT.has(err.name) || dependencyUnavailable(err)) return json(503, { error: 'Busy, try again' }, { 'retry-after': '2' });
      console.error(err);
      return json(500, { error: 'Something went wrong' });
    }
  };
}

export const handler = makeHandler(DynamoDBDocumentClient.from(new DynamoDBClient({})), {
  itemsTable: process.env.ITEMS_TABLE,
  reservationsTable: process.env.RESERVATIONS_TABLE,
  tenancyTable: process.env.TENANCY_TABLE,
  shopKey: process.env.SHOP_KEY,
  defaultShopId: process.env.DEFAULT_SHOP_ID || undefined,
  holdMinutes: Number(process.env.HOLD_MINUTES) || 1440,
});
