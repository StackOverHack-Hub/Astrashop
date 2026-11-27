import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { dependencyUnavailable } from './dependency-errors.mjs';
import { digest, signedInUser } from './marketplace-shared.mjs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, QueryCommand, GetCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHOP_ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const MAX_ID = 128;
const MAX_STOCK = 100000;
const AUDIT_DAYS = 365;
const INVITE_DAYS = 7;
const MAX_PRICE = 100000;
const INVITE_TOKEN = /^[A-Za-z0-9_-]{32}$/;
const SHOP_STATUSES = ['trial', 'active', 'suspended'];
const ROLES = ['owner', 'staff'];
// Plain text a person typed: trimmed length within bounds and no control characters.
const isText = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.length <= max
  && !/[\u0000-\u001f\u007f]/.test(value);
const isPrice = (n) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_PRICE;
// The catalog fields an owner edits. Returns the cleaned values, or undefined when any is invalid.
const itemFields = (body) => {
  const { name, course = '', price, pickupWindow = '' } = body;
  if (!isText(name, 2, 80) || !isText(course, 0, 40) || !isPrice(price) || !isText(pickupWindow, 0, 80)) return;
  return { name: name.trim(), course: course.trim(), price, pickupWindow: pickupWindow.trim() };
};
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
  'POST /invites/accept': 'signedIn',
  'GET /shops/{shopId}/catalog': 'staff',
  'POST /shops/{shopId}/items': 'owner',
  'PUT /shops/{shopId}/items/{id}/details': 'owner',
  'PUT /shops/{shopId}': 'owner',
  'GET /shops/{shopId}/staff': 'owner',
  'POST /shops/{shopId}/invites': 'owner',
  'GET /shops/{shopId}/audit': 'owner',
  'GET /admin/shops': 'platform',
  'PUT /admin/shops/{shopId}': 'platform',
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
  return user && {
    id: user.id, platformAdmin: user.groups.includes('PlatformAdmins'), moderator: user.groups.includes('MarketplaceModerators'),
  };
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
      TableName: tenancyTable, ConsistentRead: true, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'SHOP' },
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
    // Items the owner has taken off sale stay in the counter's catalog but not in the public one.
    'GET /shops/{shopId}/items': async ({ params }) => json(200, await readAll(QueryCommand, {
      TableName: itemsTable, IndexName: 'ByShop', KeyConditionExpression: 'shopId = :shop',
      FilterExpression: 'attribute_not_exists(active) OR active = :yes',
      ExpressionAttributeValues: { ':shop': params.shopId, ':yes': true },
    })),

    'GET /shops/{shopId}/catalog': async ({ params }) => json(200, await readAll(QueryCommand, {
      TableName: itemsTable, IndexName: 'ByShop', KeyConditionExpression: 'shopId = :shop',
      ExpressionAttributeValues: { ':shop': params.shopId },
    })),

    'GET /me': async ({ actor }) => {
      const memberships = await readAll(QueryCommand, {
        TableName: tenancyTable, ConsistentRead: true, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `USER#${actor.id}` },
      });
      // Names and status come from the shop row, so a renamed or suspended shop shows up at once.
      const shops = await Promise.all(memberships.map(async ({ sk, role }) => {
        const shopId = sk.slice('SHOP#'.length);
        const shop = await get(tenancyTable, shopRow(shopId));
        return shop && { shopId, name: shop.name, role, status: shop.status ?? 'active', pickupWindow: shop.pickupWindow ?? '' };
      }));
      return json(200, {
        id: actor.id, platformAdmin: Boolean(actor.platformAdmin), moderator: Boolean(actor.moderator),
        shops: shops.filter(Boolean),
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
      if (item.active === false) return await returnExisting() ?? json(409, { code: 'UNAVAILABLE', error: 'This item is no longer on sale.' });
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

    // Reservation activity over the last `days` days (90 by default). The pilot separately tracks the
    // student's start and deadline.
    'GET /shops/{shopId}/stats': async ({ params, query }) => {
      const days = query.days === undefined ? 90 : Number(query.days);
      if (!Number.isSafeInteger(days) || days < 1 || days > 3650) return json(400, { error: 'days must be a whole number from 1 to 3650' });
      const rows = await readAll(QueryCommand, {
        TableName: reservationsTable, IndexName: 'ByShopCreated',
        KeyConditionExpression: 'shopId = :shop AND createdAt >= :since',
        ExpressionAttributeValues: { ':shop': params.shopId, ':since': new Date(now().getTime() - days * 86_400_000).toISOString() },
      });
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
        days,
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
      // A role change keeps the name the person gave when they joined.
      await db.send(new TransactWriteCommand({ TransactItems: [
        ...memberRows.map((Key) => role
          ? { Update: {
            TableName: tenancyTable, Key,
            UpdateExpression: 'SET #r = :role, addedBy = if_not_exists(addedBy, :by), addedAt = if_not_exists(addedAt, :at)',
            ExpressionAttributeNames: { '#r': 'role' }, ExpressionAttributeValues: { ':role': role, ':by': actor.id, ':at': at },
          } }
          : { Delete: { TableName: tenancyTable, Key } }),
        audit(shopId, actor, 'staff', userId, { role }),
      ] }));
      return json(200, { shopId, userId, role });
    },

    // The client makes the item id once, so a retried create returns the same item.
    'POST /shops/{shopId}/items': async ({ params, body, actor }) => {
      const fields = itemFields(body);
      if (!UUID.test(body.id ?? '') || !fields || !isStock(body.stock)) {
        return json(400, { error: `id (uuid), name (2-80 characters), price (0-${MAX_PRICE}) and stock (0-${MAX_STOCK}) are required` });
      }
      const shop = await get(tenancyTable, shopRow(params.shopId));
      const at = now().toISOString();
      const item = {
        id: body.id, shopId: params.shopId, ...fields, pickupWindow: fields.pickupWindow || shop?.pickupWindow || '',
        stock: body.stock, version: 0, active: true, confirmedAt: at,
      };
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: itemsTable, Item: item, ConditionExpression: 'attribute_not_exists(id)' } },
          audit(params.shopId, actor, 'item-created', item.id, { name: item.name }),
        ] }));
        return json(201, item);
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        if (cancelled(err)[0] !== 'ConditionalCheckFailed') return json(503, { error: 'Busy, try again' });
        const existing = await get(itemsTable, { id: item.id });
        return existing?.shopId === params.shopId && existing.name === item.name ? json(200, existing) : json(409, { error: 'Item id already used' });
      }
    },

    // Name, course, price, hours, and whether it is on sale. Stock has its own recount route.
    'PUT /shops/{shopId}/items/{id}/details': async ({ params, body, actor }) => {
      const fields = itemFields(body);
      if (!fields || typeof body.active !== 'boolean' || !isStock(body.expectedVersion)) {
        return json(400, { error: 'name, price, active (true or false) and expectedVersion are required' });
      }
      const item = isItemId(params.id) && await get(itemsTable, { id: params.id });
      if (!item || shopOf(item) !== params.shopId) return json(404, { error: 'Item not found' });
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Update: {
            TableName: itemsTable, Key: { id: item.id },
            UpdateExpression: 'SET #n = :name, course = :course, price = :price, pickupWindow = :pickupWindow, active = :active, version = if_not_exists(version, :zero) + :one',
            ConditionExpression: body.expectedVersion === 0 ? 'attribute_not_exists(version) OR version = :expected' : 'version = :expected',
            ExpressionAttributeNames: { '#n': 'name' },
            ExpressionAttributeValues: {
              ...one, ':name': fields.name, ':course': fields.course, ':price': fields.price, ':pickupWindow': fields.pickupWindow,
              ':active': body.active, ':expected': body.expectedVersion,
            },
          } },
          audit(params.shopId, actor, 'item-updated', item.id, {
            before: { name: item.name, price: item.price, active: item.active !== false },
            after: { name: fields.name, price: fields.price, active: body.active },
          }),
        ] }));
        return json(200, { ...item, ...fields, active: body.active, version: (item.version ?? 0) + 1 });
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        return cancelled(err)[0] === 'ConditionalCheckFailed'
          ? json(409, { error: 'This item changed since you opened it. Refresh and try again.' }) : json(503, { error: 'Busy, try again' });
      }
    },

    'PUT /shops/{shopId}': async ({ params, body, actor }) => {
      const pickupWindow = body.pickupWindow ?? '';
      if (!isText(body.name, 2, 80) || !isText(pickupWindow, 0, 80)) return json(400, { error: 'name (2-80 characters) is required' });
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Update: {
            TableName: tenancyTable, Key: shopRow(params.shopId),
            UpdateExpression: 'SET #n = :name, pickupWindow = :pickupWindow', ConditionExpression: 'attribute_exists(sk)',
            ExpressionAttributeNames: { '#n': 'name' }, ExpressionAttributeValues: { ':name': body.name.trim(), ':pickupWindow': pickupWindow.trim() },
          } },
          audit(params.shopId, actor, 'shop-updated', params.shopId, { name: body.name.trim() }),
        ] }));
        return json(200, { id: params.shopId, name: body.name.trim(), pickupWindow: pickupWindow.trim() });
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        return cancelled(err)[0] === 'ConditionalCheckFailed' ? json(404, { error: 'Shop not found' }) : json(503, { error: 'Busy, try again' });
      }
    },

    'GET /shops/{shopId}/staff': async ({ params }) => {
      const rows = await readAll(QueryCommand, {
        TableName: tenancyTable, ConsistentRead: true, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :staff)',
        ExpressionAttributeValues: { ':pk': `SHOP#${params.shopId}`, ':staff': 'STAFF#' },
      });
      return json(200, rows.map(({ sk, role, name = '', addedAt }) => ({ userId: sk.slice('STAFF#'.length), role, name, addedAt })));
    },

    // A single-use link the owner sends however they like. Only a digest of the token is stored.
    'POST /shops/{shopId}/invites': async ({ params, body, actor }) => {
      if (!ROLES.includes(body.role)) return json(400, { error: 'role must be owner or staff' });
      const token = randomBytes(24).toString('base64url');
      const at = now();
      const expiresAt = new Date(at.getTime() + INVITE_DAYS * 86_400_000).toISOString();
      await db.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: tenancyTable, Item: {
          pk: `INVITE#${digest(token)}`, sk: 'INVITE', shopId: params.shopId, role: body.role, createdBy: actor.id,
          expiresAt, expires: Math.floor(Date.parse(expiresAt) / 1000),
        } } },
        audit(params.shopId, actor, 'invite', body.role),
      ] }));
      return json(201, { token, role: body.role, expiresAt });
    },

    'POST /invites/accept': async ({ body, actor }) => {
      const name = body.name ?? '';
      if (typeof body.token !== 'string' || !INVITE_TOKEN.test(body.token) || !isText(name, 0, 60)) {
        return json(400, { error: 'A valid invite token is required, and a name of up to 60 characters' });
      }
      const key = { pk: `INVITE#${digest(body.token)}`, sk: 'INVITE' };
      const at = now().toISOString();
      const invite = await get(tenancyTable, key);
      const gone = () => json(404, { error: 'This invite link has expired or was already used. Ask the shop for a new one.' });
      if (!invite || invite.expiresAt <= at) return gone();
      const shop = await get(tenancyTable, shopRow(invite.shopId));
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Delete: {
            TableName: tenancyTable, Key: key, ConditionExpression: 'attribute_exists(pk) AND expiresAt > :now',
            ExpressionAttributeValues: { ':now': at },
          } },
          { Put: {
            TableName: tenancyTable, ConditionExpression: 'attribute_not_exists(sk)',
            Item: { ...staffRow(invite.shopId, actor.id), role: invite.role, name: name.trim(), addedBy: invite.createdBy, addedAt: at },
          } },
          { Put: { TableName: tenancyTable, Item: { pk: `USER#${actor.id}`, sk: `SHOP#${invite.shopId}`, role: invite.role, addedAt: at } } },
          audit(invite.shopId, actor, 'joined', actor.id, { role: invite.role }),
        ] }));
        return json(200, { shopId: invite.shopId, name: shop?.name ?? invite.shopId, role: invite.role });
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        const codes = cancelled(err);
        if (codes[0] === 'ConditionalCheckFailed') return gone();
        if (codes[1] === 'ConditionalCheckFailed') return json(409, { error: 'You’re already on this shop’s staff.' });
        return json(503, { error: 'Busy, try again' });
      }
    },

    // Newest first, 50 at a time. The cursor is checked so it can only page through this shop's log.
    'GET /shops/{shopId}/audit': async ({ params, query }) => {
      const pk = `SHOP#${params.shopId}`;
      let ExclusiveStartKey;
      if (query.cursor !== undefined) {
        try {
          const key = JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString());
          if (key?.pk !== pk || typeof key.sk !== 'string' || !key.sk.startsWith('AUDIT#') || Object.keys(key).length !== 2) throw new Error('bad cursor');
          ExclusiveStartKey = key;
        } catch {
          return json(400, { error: 'Invalid cursor' });
        }
      }
      const page = await db.send(new QueryCommand({
        TableName: tenancyTable, ConsistentRead: true, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :audit)',
        ExpressionAttributeValues: { ':pk': pk, ':audit': 'AUDIT#' }, ScanIndexForward: false, Limit: 50, ExclusiveStartKey,
      }));
      return json(200, {
        entries: (page.Items ?? []).map(({ sk, actor, action, target, at, pk: _pk, expires, ...detail }) => ({ id: sk, at, actor, action, target, detail })),
        next: page.LastEvaluatedKey ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString('base64url') : null,
      });
    },

    'GET /admin/shops': async () => {
      const shops = await readAll(QueryCommand, {
        TableName: tenancyTable, ConsistentRead: true, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'SHOP' },
      });
      return json(200, shops.map(({ sk, name, pickupWindow = '', status = 'active', plan = '', createdAt }) =>
        ({ id: sk, name, pickupWindow, status, plan, createdAt })));
    },

    // Suspending a shop stops new reservations at once; staff keep their access.
    'PUT /admin/shops/{shopId}': async ({ params, body, actor }) => {
      if (!SHOP_STATUSES.includes(body.status)) return json(400, { error: `status must be one of ${SHOP_STATUSES.join(', ')}` });
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Update: {
            TableName: tenancyTable, Key: shopRow(params.shopId), UpdateExpression: 'SET #st = :status',
            ConditionExpression: 'attribute_exists(sk)', ExpressionAttributeNames: { '#st': 'status' },
            ExpressionAttributeValues: { ':status': body.status },
          } },
          audit(params.shopId, actor, 'shop-status', params.shopId, { status: body.status }),
        ] }));
        return json(200, { id: params.shopId, status: body.status });
      } catch (err) {
        if (err.name !== 'TransactionCanceledException') throw err;
        return cancelled(err)[0] === 'ConditionalCheckFailed' ? json(404, { error: 'Shop not found' }) : json(503, { error: 'Busy, try again' });
      }
    },

    // ownerId is optional: without it, send the owner an invite link (POST /shops/{shopId}/invites).
    'POST /admin/shops': async ({ body, actor }) => {
      const { id, name, ownerId } = body;
      const pickupWindow = body.pickupWindow ?? '';
      if (typeof id !== 'string' || !SHOP_ID.test(id) || !isText(name, 2, 80)
        || (ownerId !== undefined && !UUID.test(ownerId)) || !isText(pickupWindow, 0, 80)) {
        return json(400, { error: 'id (3-40 lowercase letters, digits, dashes) and name are required; ownerId must be an account id' });
      }
      const at = now().toISOString();
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Put: {
            TableName: tenancyTable, ConditionExpression: 'attribute_not_exists(sk)',
            Item: { ...shopRow(id), name: name.trim(), pickupWindow, status: 'trial', plan: 'trial', createdAt: at, createdBy: actor.id },
          } },
          ...(ownerId ? [staffRow(id, ownerId), { pk: `USER#${ownerId}`, sk: `SHOP#${id}` }] : []).map((Key) => ({ Put: {
            TableName: tenancyTable, Item: { ...Key, role: 'owner', addedBy: actor.id, addedAt: at },
          } })),
          audit(id, actor, 'shop-created', id, ownerId ? { ownerId } : {}), // DynamoDB rejects undefined values
        ] }));
        return json(201, { id, name: name.trim(), status: 'trial', ...(ownerId ? { ownerId } : {}) });
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
      return await routes[routeKey]({ body, params, actor, query: event.queryStringParameters ?? {} });
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
