import { marketplaceCommunity, profileId, publicSellerRoutes } from './marketplace-community.mjs';
import { dependencyUnavailable } from './dependency-errors.mjs';
import {
  uuid, hashId, rankId, pageSize, digest, rank, row, write, details, account, threadKey,
  RequestError, requireInput, respond, text, cursorAnchor, page, signedInUser,
} from './marketplace-shared.mjs';

export const kinds = ['item', 'service', 'favor'];
const marketTypes = new Set(kinds);
const listingConditions = new Set(['', 'new', 'like-new', 'good', 'fair']);
const fold = (title) => title.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ');
// The distinct words of a text, folded. A listing is found by any word of its title, or the start of one.
const words = (value) => [...new Set(fold(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sameKey = (a, b) => a.pk === b.pk && a.sk === b.sk;
const messagePartition = (id) => `MESSAGES#${id}`;

function searchable(value, label) {
  const normalized = fold(value);
  requireInput(Buffer.byteLength(normalized) <= 360, `${label} is too long after normalization.`);
  return normalized;
}

function form(body) {
  const kind = body.kind;
  requireInput(marketTypes.has(kind), 'Choose items, services, or favors.');
  const pricePaise = body.pricePaise;
  requireInput(Number.isSafeInteger(pricePaise) && pricePaise >= 0 && pricePaise <= 10_000_000,
    'Enter an amount from ₹0 to ₹100,000.');
  const title = text(body.title, 'Title', 3, 80);
  searchable(title, 'Title');
  const extras = {};
  if (body.condition !== undefined) {
    requireInput(listingConditions.has(body.condition) && (kind === 'item' || body.condition === ''), 'Choose a valid item condition.');
    extras.condition = body.condition;
  }
  if (body.scope !== undefined) {
    extras.scope = text(body.scope, 'What is included', 0, 500, true);
    requireInput(kind !== 'item' || !extras.scope, 'Item listings do not use a service scope.');
  }
  if (body.availability !== undefined) extras.availability = text(body.availability, 'Availability', 0, 100);
  return {
    kind, pricePaise,
    title,
    description: text(body.description, 'Description', 5, 1200, true),
    meetup: text(body.meetup, 'Campus meetup area', 2, 80),
    ...extras,
  };
}

function publicListing(listing) {
  const { id, kind, pricePaise, title, description, meetup, createdAt, updatedAt } = listing;
  return {
    id, kind, pricePaise, title, description, meetup, createdAt, updatedAt,
    condition: listing.condition ?? '', scope: listing.scope ?? '', availability: listing.availability ?? '',
    ...(listing.completedAt ? { completedAt: listing.completedAt } : {}),
  };
}
const ownedListing = (listing) => ({ ...publicListing(listing), status: listing.status, version: listing.version });

function projections(listing) {
  const sort = rank(listing.createdAt, listing.id);
  const owner = row(account(listing.owner), `LISTING#${sort}`, ownedListing(listing));
  if (listing.status !== 'active') return [owner];
  const publicRow = { ...publicListing(listing), sellerId: profileId(listing.owner) };
  return [
    owner,
    row(`FEED#${listing.kind}`, sort, publicRow),
    ...words(listing.title).map((word) => row(`WORD#${listing.kind}`, `${word}\u0001${listing.id}`, publicRow)),
    row(`SELLER-OFFERS#${profileId(listing.owner)}`, sort, publicRow),
  ];
}

function listingWrites(current, listing) {
  const next = projections(listing);
  const removed = projections(current).filter((old) => !next.some((value) => sameKey(old, value)));
  return [
    write('guard', listing, current.version),
    ...removed.map((value) => write('delete', value)),
    ...next.map((value) => write('put', value)),
  ];
}

function parseBody(event) {
  const header = event.headers?.['content-type'];
  const contentType = typeof header === 'string' ? header.split(';', 1)[0].trim().toLowerCase() : '';
  requireInput(contentType === 'application/json', 'Send application/json.', 415);
  const raw = event.body;
  requireInput(typeof raw === 'string', 'A JSON body is required.');
  requireInput(Buffer.byteLength(raw) <= (event.isBase64Encoded ? 11_000 : 8_192), 'Request is too large.', 413);
  const decoded = event.isBase64Encoded ? Buffer.from(raw, 'base64') : Buffer.from(raw);
  requireInput(decoded.length <= 8_192, 'Request is too large.', 413);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
  } catch {
    throw new RequestError(400, 'Invalid JSON.');
  }
  requireInput(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Send a JSON object.');
  return parsed;
}

const publicRead = { capacity: 600, windowMs: 60_000 };
const accountRead = { capacity: 120, windowMs: 60_000 };
const accountWrite = { capacity: 24, windowMs: 60_000 };
// A campus NAT can represent many students. Keep the account limit tighter
// than the network limit so one shared address does not serialize the campus.
const ipWrite = { capacity: 300, windowMs: 60_000 };
const publishing = { capacity: 6, windowMs: 60_000 };
const temporary = new Set([
  'TransactionConflictException', 'TransactionCanceledException', 'ProvisionedThroughputExceededException',
  'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError', 'TimeoutError',
]);

export function gatewayActor(event) {
  const user = signedInUser(event);
  return user && { id: user.id, moderator: user.groups.includes('MarketplaceModerators') };
}

// Moves listings saved before word search onto word rows. Safe to repeat; a listing that changes
// while it runs has already written its own word rows, so only its old title row is removed.
export async function backfillListingWords(store) {
  let moved = 0;
  for (const kind of kinds) {
    for (let rows; (rows = await store.query(`TITLE#${kind}`, { ascending: true, limit: 50 })).length;) {
      for (const old of rows) {
        const listing = await store.get(...details(old.sk.split('\u0001').at(-1)));
        const wordRows = listing?.status === 'active' ? projections(listing).filter(({ pk }) => pk.startsWith('WORD#')) : [];
        const done = await store.transact([
          ...(listing ? [write('check', listing, listing.version)] : []),
          write('delete', old), ...wordRows.map((value) => write('put', value)),
        ]);
        if (done) moved += 1;
        else await store.transact([write('delete', old)]);
      }
    }
  }
  return moved;
}

export function makeMarketplace(store, limit, { actorFrom = gatewayActor, now = () => new Date() } = {}) {
  const community = marketplaceCommunity(store, {
    now, listingView: publicListing,
    closeItem: (listing, when) => listingWrites(listing, {
      ...listing, status: 'closed', completedAt: when, updatedAt: when, version: listing.version + 1,
    }),
  });

  async function browse({ q, kind, cursor }) {
    requireInput(kind === undefined || marketTypes.has(kind), 'Unknown category.');
    const search = q === undefined ? '' : searchable(text(q, 'Search', 0, 80), 'Search');
    const context = JSON.stringify(['browse', kind ?? '', search]);
    const terms = words(search);
    // Walk the rows of the longest word typed, keeping listings whose title has every word typed.
    const term = terms.reduce((longest, value) => value.length > longest.length ? value : longest, '');
    const anchor = cursorAnchor(cursor, context, term
      ? (key) => key.startsWith(term) && uuid.test(key.split('\u0001').at(-1))
      : (key) => rankId.test(key));
    const hasEveryTerm = (entry) => {
      const titleWords = words(entry.title);
      return terms.every((value) => titleWords.some((word) => word.startsWith(value)));
    };
    const searchKind = async (value) => {
      const found = [];
      for (let lower = anchor ? `${anchor}\u0000` : term; ;) {
        const rows = await store.query(`WORD#${value}`, { lower, upper: `${term}\u{10ffff}`, ascending: true, limit: pageSize + 1 });
        found.push(...rows.filter(hasEveryTerm));
        if (found.length > pageSize || rows.length <= pageSize) return found;
        lower = `${rows.at(-1).sk}\u0000`;
      }
    };
    const sets = await Promise.all((kind ? [kind] : kinds).map((value) => term ? searchKind(value)
      : store.query(`FEED#${value}`, { upper: anchor, limit: pageSize + 1 })));
    // One listing can match through two of its words ("dra" finds "drafter" and "drawing"): show it once.
    const seen = new Set();
    const matches = sets.flat().sort((a, b) => compare(a.sk, b.sk) * (term ? 1 : -1))
      .filter((entry) => !seen.has(entry.id) && seen.add(entry.id));
    const results = page(matches, context, (entry) => entry);
    return respond(200, { ...results, entries: await community.enrich(results.entries) });
  }

  async function ownPage(actor, cursor, type, present) {
    const context = JSON.stringify([type, actor.id]);
    const prefix = `${type}#`;
    const anchor = cursorAnchor(cursor, context, (key) => key.startsWith(prefix) && rankId.test(key.slice(prefix.length)));
    const rows = await store.query(account(actor.id), { lower: prefix, upper: anchor ?? `${prefix}\u{10ffff}`, limit: pageSize + 2 });
    return respond(200, page(rows.filter((entry) => entry.sk !== anchor), context, present));
  }

  async function createListing(body, actor) {
    requireInput(typeof body.id === 'string' && uuid.test(body.id), 'Invalid listing identifier.');
    const payload = form(body);
    const requestHash = digest(payload);
    const existing = await store.get(...details(body.id));
    if (existing) {
      requireInput(existing.owner === actor.id && existing.requestHash === requestHash, 'Listing identifier already used.', 409);
      return respond(200, ownedListing(existing));
    }
    requireInput(await community.profileFor(actor.id), 'Create your marketplace profile first.', 409);
    const when = now().toISOString();
    const listing = row(...details(body.id), {
      ...payload, id: body.id, owner: actor.id, status: 'active', version: 1, requestHash, createdAt: when, updatedAt: when,
    });
    if (await store.transact([write('guard', listing), ...projections(listing).map((value) => write('put', value))])) {
      return respond(201, ownedListing(listing));
    }
    const replay = await store.get(...details(body.id));
    requireInput(replay?.owner === actor.id && replay.requestHash === requestHash, 'Listing identifier already used.', 409);
    return respond(200, ownedListing(replay));
  }

  async function updateListing(id, body, actor, moderate = false) {
    requireInput(body.requestId === undefined || typeof body.requestId === 'string' && uuid.test(body.requestId),
      'Invalid save identifier.');
    const operationKey = body.requestId ? [`LISTING-SAVE#${id}`, digest(actor.id, body.requestId)] : null;
    const fingerprint = digest(body);
    async function replaySave() {
      const operation = operationKey && await store.get(...operationKey);
      if (!operation) return;
      requireInput(operation.fingerprint === fingerprint, 'Save identifier already used.', 409);
      return respond(200, operation.result);
    }
    const previous = await replaySave();
    if (previous) return previous;
    const current = await store.get(...details(id));
    requireInput(current && (moderate || current.owner === actor.id), 'Listing not found.', 404);
    if (!moderate || body.version !== undefined) {
      requireInput(Number.isSafeInteger(body.version) && body.version > 0, 'Listing version is required.');
      // A duplicate of this save may have committed between the two reads above.
      if (current.version !== body.version) return (await replaySave()) ?? respond(409, { error: 'This listing changed. Refresh and try again.' });
    }
    requireInput(current.status !== 'removed', 'This listing has been removed.', 409);
    const status = moderate ? 'removed' : body.status;
    requireInput(['active', 'closed', 'removed'].includes(status) && (status !== 'removed' || moderate), 'Unknown listing status.');
    requireInput(status !== 'active' || !current.completedAt, 'This item already has a completed exchange.', 409);
    const changesContent = ['title', 'description', 'meetup', 'pricePaise', 'kind', 'condition', 'scope', 'availability']
      .some((field) => Object.hasOwn(body, field));
    if (!moderate && changesContent) requireInput(body.kind === undefined || body.kind === current.kind, 'The category cannot change.');
    const values = !moderate && changesContent ? form({ ...body, kind: current.kind }) : {};
    const listing = { ...current, ...values, status, version: current.version + 1, updatedAt: now().toISOString() };
    const writes = listingWrites(current, listing);
    if (operationKey) writes.push(write('guard', row(...operationKey, {
      fingerprint, result: ownedListing(listing),
      expires: Math.floor(now().getTime() / 1000) + 7 * 86_400,
    })));
    if (moderate) writes.push(write('guard', row(`AUDIT#${id}`, String(listing.version), {
      moderator: actor.id, action: 'remove', when: listing.updatedAt,
    })));
    if (!await store.transact(writes)) {
      const replay = await replaySave();
      if (replay) return replay;
      requireInput(false, 'This listing changed. Refresh and try again.', 409);
    }
    return respond(200, ownedListing(listing));
  }

  const threadView = ({ id, listingId, title, createdAt, seller }, actor) =>
    ({ id, listingId, title, createdAt, asSeller: seller === actor.id });
  const messageView = ({ id, text: message, createdAt, author }, actor) =>
    ({ id, text: message, createdAt, mine: author === actor.id });

  async function openThread(listingId, body, actor, attempt = 0) {
    requireInput(typeof body.id === 'string' && uuid.test(body.id), 'Invalid message identifier.');
    const message = text(body.text, 'Message', 1, 800, true);
    const id = digest(listingId, actor.id);
    const existing = await store.get(...threadKey(id));
    if (existing) {
      await sendMessage(existing, actor, body.id, message);
      return respond(200, threadView(existing, actor));
    }
    const listing = await store.get(...details(listingId));
    requireInput(listing?.status === 'active', 'This listing is no longer available.', 404);
    requireInput(listing.owner !== actor.id, 'You own this listing.', 409);
    const when = now().toISOString();
    const thread = row(...threadKey(id), {
      id, listingId, title: listing.title, buyer: actor.id, seller: listing.owner, createdAt: when,
    });
    const opened = await store.transact([
      write('check', listing, listing.version), write('guard', thread),
      ...[thread.buyer, thread.seller].map((person) => write('guard', row(account(person), `THREAD#${rank(when, id)}`, {
        id, listingId, title: thread.title, seller: thread.seller, createdAt: when,
      }))),
      ...messageWrites(id, actor, body.id, message, when),
    ]);
    if (opened) return respond(201, threadView(thread, actor));
    const replay = await store.get(...threadKey(id));
    if (!replay && attempt < 2) return openThread(listingId, body, actor, attempt + 1);
    requireInput(replay, 'This listing changed. Refresh and try again.', 409);
    await sendMessage(replay, actor, body.id, message);
    return respond(200, threadView(replay, actor));
  }

  function messageWrites(threadId, actor, requestId, message, when) {
    const id = digest(actor.id, requestId);
    const data = { id, text: message, createdAt: when, author: actor.id };
    return [
      write('guard', row(`MESSAGE-ID#${threadId}`, id, data)),
      write('guard', row(messagePartition(threadId), rank(when, id), data)),
    ];
  }

  async function sendMessage(thread, actor, requestId, message) {
    const writes = messageWrites(thread.id, actor, requestId, message, now().toISOString());
    const key = writes[0].row;
    const replay = (existing) => {
      requireInput(existing, 'This listing changed. Refresh and try again.', 409);
      requireInput(existing.text === message, 'Message identifier already used.', 409);
      return respond(200, messageView(existing, actor));
    };
    const existing = await store.get(key.pk, key.sk);
    if (existing) return replay(existing);
    // An unrelated seller edit bumps the listing version; re-read and retry rather than refuse.
    for (let attempt = 0; attempt < 3; attempt++) {
      const listing = await store.get(...details(thread.listingId));
      requireInput(listing && listing.status !== 'removed', 'This conversation is read only.', 409);
      if (await store.transact([write('check', listing, listing.version), ...writes])) return respond(201, messageView(key, actor));
      const sent = await store.get(key.pk, key.sk);
      if (sent) return replay(sent);
    }
    return replay(undefined);
  }

  async function threadMessages(id, actor, cursor, body) {
    const thread = await store.get(...threadKey(id));
    requireInput(thread && [thread.seller, thread.buyer].includes(actor.id), 'Conversation not found.', 404);
    if (!body) {
      const context = JSON.stringify(['messages', id, actor.id]);
      const anchor = cursorAnchor(cursor, context, (key) => rankId.test(key));
      const messages = await store.query(messagePartition(id), { upper: anchor, limit: pageSize + 1 });
      return respond(200, page(messages, context, (entry) => messageView(entry, actor)));
    }
    requireInput(typeof body.id === 'string' && uuid.test(body.id), 'Invalid message identifier.');
    return sendMessage(thread, actor, body.id, text(body.text, 'Message', 1, 800, true));
  }

  async function reportListing(id, body, actor, attempt = 0) {
    const reason = text(body.reason, 'Report reason', 5, 400, true);
    const listing = await store.get(...details(id));
    requireInput(listing?.status === 'active', 'Listing not found.', 404);
    requireInput(listing.owner !== actor.id, 'You own this listing.', 409);
    const nowDate = now();
    const when = nowDate.toISOString();
    const reportId = digest(id, actor.id);
    const key = [`REPORT-ID#${id}`, actor.id];
    const expires = Math.floor(nowDate.getTime() / 1000) + 90 * 86_400;
    if (await store.transact([
      write('check', listing, listing.version),
      write('guard', row(...key, { expires })),
      write('guard', row('REPORTS', rank(when, reportId), {
        id: reportId, listingId: id, title: listing.title, listingVersion: listing.version, reason, when, expires,
      })),
    ])) return respond(201, { reported: true });
    const reported = await store.get(...key);
    if (!reported && attempt < 2) return reportListing(id, body, actor, attempt + 1);
    requireInput(reported, 'This listing changed. Refresh and try again.', 409);
    return respond(200, { reported: true });
  }

  const routes = {
    ...community.routes,
    'GET /marketplace/listings': ({ query }) => browse(query),
    'POST /marketplace/listings': ({ body, actor }) => createListing(body, actor),
    'GET /marketplace/mine': ({ actor, query }) => ownPage(actor, query.cursor, 'LISTING', ownedListing),
    'PUT /marketplace/listings/{id}': ({ id, body, actor }) => updateListing(id, body, actor),
    'POST /marketplace/listings/{id}/contact': ({ id, body, actor }) => openThread(id, body, actor),
    'POST /marketplace/listings/{id}/report': ({ id, body, actor }) => reportListing(id, body, actor),
    'GET /marketplace/inbox': ({ actor, query }) => ownPage(actor, query.cursor, 'THREAD', (entry) => threadView(entry, actor)),
    'GET /marketplace/threads/{id}': ({ id, actor, query }) => threadMessages(id, actor, query.cursor),
    'POST /marketplace/threads/{id}': ({ id, body, actor }) => threadMessages(id, actor, undefined, body),
    'PUT /marketplace/listings/{id}/moderate': ({ id, body, actor }) => updateListing(id, body, actor, true),
    'GET /marketplace/reports': async ({ query }) => {
      const anchor = cursorAnchor(query.cursor, 'reports', (key) => rankId.test(key));
      const rows = await store.query('REPORTS', { upper: anchor, limit: pageSize + 1 });
      return respond(200, page(rows, 'reports', ({ id, listingId, title, listingVersion, reason, when }) =>
        ({ id, listingId, title, listingVersion, reason, when })));
    },
  };
  const readRoute = 'GET /marketplace/listings';
  return async (event) => {
    try {
      const route = event?.routeKey;
      if (!Object.hasOwn(routes, route)) return respond(404, { error: 'Route not found.' });
      const open = route === readRoute || publicSellerRoutes.has(route);
      const actor = open ? undefined : actorFrom(event);
      if (!open && !actor?.id) return respond(401, { error: 'Sign in to use the marketplace.' });
      if (route.endsWith('/moderate') || route.endsWith('/reports')) {
        requireInput(actor.moderator, 'Moderator access is required.', 403);
      }
      const mutates = !route.startsWith('GET ');
      const ip = event.requestContext?.http?.sourceIp ?? 'unknown';
      let delay;
      try {
        const keys = open ? [[`browse:${digest(ip)}`, publicRead]]
          : mutates
            ? [[`write-ip:${digest(ip)}`, ipWrite], [`write:${digest(actor.id)}`, accountWrite]]
            : [[`read:${digest(actor.id)}`, accountRead]];
        if (route === 'POST /marketplace/listings') keys.push([`publish:${digest(actor.id)}`, publishing]);
        for (const [key, policy] of keys) {
          delay = await limit(key, policy);
          if (!Number.isInteger(delay) || delay < 0) throw new Error('Invalid limiter result');
          // A rejected network request must not spend account or publish credit.
          if (delay) break;
        }
      } catch {
        console.error(JSON.stringify({ event: 'marketplace_limiter_unavailable', route }));
        return respond(503, { error: 'Marketplace is temporarily busy. Try again shortly.' }, { 'retry-after': '2' });
      }
      if (delay) return respond(429, { error: `Too many requests. Try again in ${delay}s.` }, { 'retry-after': String(delay) });
      const id = event.pathParameters?.id;
      const identifier = route.includes('/threads/') || route.includes('/sellers/') ? hashId : uuid;
      if (route.includes('{id}')) requireInput(typeof id === 'string' && identifier.test(id), 'Invalid identifier.');
      return await routes[route]({ query: event.queryStringParameters ?? {}, id, event, actor, body: mutates ? parseBody(event) : undefined });
    } catch (error) {
      if (error instanceof RequestError) return respond(error.status, { error: error.message });
      console.error(JSON.stringify({ event: 'marketplace_request_failed', route: event?.routeKey, error: error?.name }));
      if (temporary.has(error?.name) || dependencyUnavailable(error)) return respond(503, { error: 'Marketplace is temporarily busy. Try again.' }, { 'retry-after': '2' });
      return respond(500, { error: 'Could not complete the marketplace request.' });
    }
  };
}
