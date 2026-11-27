import {
  uuid, rankId, pageSize, digest, rank, row, write, details, account, threadKey,
  requireInput, respond, text, cursorAnchor, page,
} from './marketplace-shared.mjs';

const profileId = (person) => digest('marketplace-profile', person);
const profileKey = (id) => [`SELLER#${id}`, 'PROFILE'];
const statsKey = (id) => [`SELLER#${id}`, 'STATS'];
const authorIdentity = (profile) => profile ? { id: profile.id, name: profile.name } : null;
const publicProfile = (profile, stats) => ({
  id: profile.id, name: profile.name, about: profile.about, programme: profile.programme,
  joinedAt: profile.joinedAt, ratingCount: stats?.count ?? 0,
  averageRating: stats?.count ? Math.round(stats.sum / stats.count * 10) / 10 : null,
});

const commentPartition = (id) => `COMMENT#${id}`;
const reviewPartition = (id) => `REVIEW#${id}`;
const reviewKey = (thread) => [`REVIEW-THREAD#${thread}`, 'DETAIL'];
const savedPartition = (person) => `SAVED#${person}`;

export const publicSellerRoutes = new Set([
  'GET /marketplace/listings/{id}', 'GET /marketplace/listings/{id}/comments',
  'GET /marketplace/sellers', 'GET /marketplace/sellers/{id}',
  'GET /marketplace/sellers/{id}/listings', 'GET /marketplace/sellers/{id}/reviews',
]);

export function marketplaceCommunity(store, { now, listingView, closeItem }) {
  const profileFor = (person) => store.get(...profileKey(profileId(person)));
  const fetchProfiles = (ids) => store.getMany(ids.map(profileKey));

  async function enrich(listings) {
    // Legacy projections lack a seller ID. Read their canonical listings in one batch.
    const legacy = listings.filter((entry) => !entry.sellerId && !entry.owner);
    const originals = new Map((await store.getMany(legacy.map((entry) => details(entry.id))))
      .filter(Boolean).map((entry) => [entry.id, entry]));
    const sellerIds = listings.map((entry) => {
      if (entry.sellerId) return entry.sellerId;
      const owner = entry.owner ?? originals.get(entry.id)?.owner;
      return owner ? profileId(owner) : null;
    });
    const profiles = new Map((await fetchProfiles(sellerIds.filter(Boolean))).filter(Boolean).map((entry) => [entry.id, entry]));
    return listings.map((entry, index) => ({
      ...listingView(entry),
      seller: authorIdentity(profiles.get(sellerIds[index])),
    }));
  }

  async function listingById(id, { active = false } = {}) {
    const listing = await store.get(...details(id));
    requireInput(listing && listing.status !== 'removed' && (!active || listing.status === 'active'),
      active ? 'This listing is no longer available.' : 'Listing not found.', 404);
    return listing;
  }

  async function saveProfile(actor, body) {
    const name = text(body.name, 'Display name', 2, 48);
    const about = text(body.about ?? '', 'About me', 0, 800, true);
    const programme = text(body.programme ?? '', 'Programme', 0, 80);
    const id = profileId(actor.id);
    const [current, stats] = await store.getMany([profileKey(id), statsKey(id)]);
    requireInput(body.version === undefined || Number.isSafeInteger(body.version) && body.version > 0, 'Invalid profile version.');
    if (body.version !== current?.version) {
      if (current && current.name === name && current.about === about && current.programme === programme) {
        return respond(200, { ...publicProfile(current, stats), version: current.version });
      }
      requireInput(false, 'Your profile changed. Refresh and try again.', 409);
    }
    const joinedAt = current?.joinedAt ?? now().toISOString();
    const profile = row(...profileKey(id), { id, owner: actor.id, name, about, programme, joinedAt, version: (current?.version ?? 0) + 1 });
    const card = row('SELLERS', rank(joinedAt, id), { id, name, about, programme, joinedAt });
    const writes = [write('guard', profile, current?.version), write('put', card)];
    if (!current) {
      const history = await store.query(account(actor.id), { lower: 'LISTING#', upper: 'LISTING#\u{10ffff}', limit: 1 });
      if (!history.length) writes.push(write('put', row(`SELLER#${id}`, 'OFFERS-INDEX', { ready: true })));
    }
    if (!await store.transact(writes)) {
      const saved = await profileFor(actor.id);
      requireInput(saved && saved.name === name && saved.about === about && saved.programme === programme,
        'Your profile changed. Refresh and try again.', 409);
      return respond(200, { ...publicProfile(saved, stats), version: saved.version });
    }
    return respond(current ? 200 : 201, { ...publicProfile(profile, stats), version: profile.version });
  }

  async function directoryPage(pk, cursor, present) {
    const anchor = cursorAnchor(cursor, pk, (key) => rankId.test(key));
    const rows = await store.query(pk, { upper: anchor, limit: pageSize + 1 });
    const data = page(rows, pk, (entry) => entry);
    return respond(200, { ...data, entries: await present(data.entries) });
  }

  async function readSeller(id) {
    const [profile, stats] = await store.getMany([profileKey(id), statsKey(id)]);
    requireInput(profile, 'Seller profile not found.', 404);
    return publicProfile(profile, stats);
  }

  async function sellerOffers(profile, query) {
    const index = await store.get(`SELLER#${profile.id}`, 'OFFERS-INDEX');
    if (index?.ready) {
      return directoryPage(`SELLER-OFFERS#${profile.id}`, query.cursor, enrich);
    }
    // Older profiles retain paged access to their listing history. Bound the
    // work even when almost every historical listing is closed.
    const prefix = 'LISTING#';
    const context = `seller-listings:${profile.id}`;
    const anchor = cursorAnchor(query.cursor, context, (key) => key.startsWith(prefix) && rankId.test(key.slice(prefix.length)));
    const entries = [];
    let upper = anchor ?? `${prefix}\u{10ffff}`;
    let hasMore = false;
    let last;
    for (let read = 0; read < 4; read++) {
      const records = await store.query(account(profile.owner), { lower: prefix, upper, limit: pageSize + 2 });
      const rows = records.filter((entry) => entry.sk !== upper);
      hasMore = rows.length > pageSize;
      for (const entry of rows.slice(0, pageSize)) {
        last = entry.sk;
        if (entry.status === 'active') entries.push({ ...listingView(entry), seller: authorIdentity(profile) });
        if (entries.length === pageSize) {
          hasMore = hasMore || entry !== rows.at(-1);
          break;
        }
      }
      if (!hasMore || entries.length === pageSize) break;
      upper = last;
    }
    return respond(200, {
      entries, next: hasMore && last ? Buffer.from(JSON.stringify([context, last])).toString('base64url') : null,
    });
  }

  const commentView = (entry, author) => ({
    id: entry.sk, text: entry.text, createdAt: entry.createdAt, author: authorIdentity(author),
    sellerReply: Boolean(entry.sellerReply),
  });

  async function addComment(id, actor, body) {
    requireInput(typeof body.id === 'string' && uuid.test(body.id), 'Invalid comment identifier.');
    const message = text(body.text, 'Comment', 1, 600, true);
    const [listing, author] = await Promise.all([listingById(id, { active: true }), profileFor(actor.id)]);
    requireInput(author, 'Create your marketplace profile first.', 409);
    const stableId = digest(actor.id, body.id);
    const referenceKey = [`COMMENT-ID#${id}`, stableId];
    const previous = await store.get(...referenceKey);
    const replay = async (reference) => {
      requireInput(reference?.hash === digest(message), 'Comment identifier already used.', 409);
      const existing = await store.get(commentPartition(id), reference.commentId);
      requireInput(existing, 'This comment was removed.', 409);
      return respond(200, commentView(existing, author));
    };
    if (previous) return replay(previous);
    const when = now().toISOString();
    const comment = row(commentPartition(id), rank(when, stableId), {
      author: actor.id, authorId: author.id, text: message, createdAt: when, sellerReply: actor.id === listing.owner, version: 1,
    });
    // An unrelated seller edit bumps the listing version; re-read and retry rather than refuse.
    for (let attempt = 0, current = listing; attempt < 3; attempt++, current = await listingById(id, { active: true })) {
      if (await store.transact([
        write('check', current, current.version),
        write('guard', row(...referenceKey, { commentId: comment.sk, hash: digest(message) })),
        write('guard', comment),
      ])) return respond(201, commentView(comment, author));
      const existing = await store.get(...referenceKey);
      if (existing) return replay(existing);
    }
    requireInput(false, 'This listing changed. Refresh and try again.', 409);
  }

  async function removeComment(id, commentId, actor) {
    requireInput(typeof commentId === 'string' && rankId.test(commentId), 'Invalid comment identifier.');
    const comment = await store.get(commentPartition(id), commentId);
    requireInput(comment && (comment.author === actor.id || actor.moderator), 'Comment not found.', 404);
    requireInput(await store.transact([write('guardDelete', comment, comment.version)]), 'Comment not found.', 404);
    return respond(200, { removed: true });
  }

  async function participant(id, actor) {
    const thread = await store.get(...threadKey(id));
    requireInput(thread && (thread.buyer === actor.id || thread.seller === actor.id), 'Conversation not found.', 404);
    return thread;
  }

  async function exchangeView(thread, actor, knownListing) {
    const asSeller = thread.seller === actor.id;
    const listing = knownListing ?? await store.get(...details(thread.listingId));
    const completed = Boolean(thread.buyerConfirmedAt && thread.sellerConfirmedAt);
    const reviewed = Boolean(completed && !asSeller && await store.get(...reviewKey(thread.id)));
    const available = Boolean(listing && listing.status !== 'removed' && (!listing.completedAt || completed));
    return {
      confirmedByYou: Boolean(asSeller ? thread.sellerConfirmedAt : thread.buyerConfirmedAt),
      confirmedByOther: Boolean(asSeller ? thread.buyerConfirmedAt : thread.sellerConfirmedAt),
      completed, reviewed, available, canReview: available && completed && !asSeller && !reviewed,
      seller: profileId(thread.seller),
    };
  }

  async function confirm(id, actor) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const thread = await participant(id, actor);
      const key = thread.seller === actor.id ? 'sellerConfirmedAt' : 'buyerConfirmedAt';
      if (thread[key]) return respond(200, await exchangeView(thread, actor));
      const listing = await listingById(thread.listingId);
      requireInput(!listing.completedAt, 'This item already has a completed exchange.', 409);
      const version = thread.version ?? 0;
      const when = now().toISOString();
      const updated = { ...thread, [key]: when, version: version + 1 };
      const itemCompleted = listing.kind === 'item' && updated.buyerConfirmedAt && updated.sellerConfirmedAt;
      const writes = [write('guard', updated, version)];
      if (itemCompleted) writes.push(...closeItem(listing, when));
      else writes.push(write('check', listing, listing.version));
      if (await store.transact(writes)) {
        return respond(200, await exchangeView(updated, actor, listing));
      }
    }
    requireInput(false, 'This exchange changed. Refresh and try again.', 409);
  }

  async function review(id, actor, body) {
    const thread = await participant(id, actor);
    requireInput(thread.buyer === actor.id, 'Only the buyer can review this exchange.', 403);
    requireInput(thread.buyerConfirmedAt && thread.sellerConfirmedAt, 'Both participants must confirm the exchange first.', 409);
    requireInput(Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5, 'Choose a rating from 1 to 5.');
    const message = text(body.text, 'Review', 5, 800, true);
    const [listing, author] = await Promise.all([listingById(thread.listingId), profileFor(actor.id)]);
    requireInput(author, 'Create your marketplace profile first.', 409);
    const seller = profileId(thread.seller);
    const when = now().toISOString();
    const publicId = digest('marketplace-review', id);
    const data = { id: publicId, authorId: author.id, listingTitle: thread.title, rating: body.rating, text: message, createdAt: when };
    // An unrelated seller edit bumps the listing version; re-read and retry rather than refuse.
    for (let attempt = 0, current = listing; attempt < 3; attempt++, current = await listingById(thread.listingId)) {
      if (await store.transact([
        write('check', current, current.version),
        write('guard', row(...reviewKey(id), data)),
        write('guard', row(reviewPartition(seller), rank(when, publicId), data)),
        write('rating', row(...statsKey(seller), { rating: body.rating })),
      ])) return respond(201, { reviewed: true });
      const previous = await store.get(...reviewKey(id));
      if (previous?.rating === body.rating && previous.text === message) return respond(200, { reviewed: true });
      requireInput(!previous, 'You already reviewed this exchange.', 409);
    }
    requireInput(false, 'This listing changed. Refresh and try again.', 409);
  }

  async function savedPage(actor, cursor) {
    return directoryPage(savedPartition(actor.id), cursor, async (records) => {
      const rows = await store.getMany(records.map((entry) => details(entry.id)));
      const visible = await enrich(rows.filter((listing) => listing && listing.status !== 'removed'));
      const listings = new Map(visible.map((entry) => [entry.id, entry]));
      return records.map(({ id }, index) => listings.has(id)
        ? { ...listings.get(id), status: rows[index].status }
        : { id, unavailable: true });
    });
  }

  async function saveListing(actor, id, value) {
    requireInput(typeof value === 'boolean', 'Choose whether to save this listing.');
    // An unrelated seller edit bumps the listing version; re-read and retry rather than refuse.
    for (let attempt = 0; attempt < 3; attempt++) {
      const listing = await store.get(...details(id));
      requireInput(listing && (!value || listing.status === 'active'), 'This listing is no longer available.', 404);
      const marker = row(savedPartition(actor.id), rank(listing.createdAt, id), { id });
      const writes = value ? [write('check', listing, listing.version), write('put', marker)] : [write('delete', marker)];
      if (await store.transact(writes)) return respond(200, { saved: value });
    }
    requireInput(false, 'This listing changed. Refresh and try again.', 409);
  }

  const routes = {
    'GET /marketplace/listings/{id}': async ({ id }) => {
      const listing = await listingById(id);
      return respond(200, { ...(await enrich([listing]))[0], status: listing.status });
    },
    'GET /marketplace/listings/{id}/comments': async ({ id, query }) => {
      await listingById(id);
      return directoryPage(commentPartition(id), query.cursor, async (entries) => {
        const profiles = await fetchProfiles(entries.map((entry) => entry.authorId));
        return entries.map((entry, index) => commentView(entry, profiles[index]));
      });
    },
    'POST /marketplace/listings/{id}/comments': ({ id, actor, body }) => addComment(id, actor, body),
    'PUT /marketplace/listings/{id}/comments/{commentId}': ({ id, event, actor }) =>
      removeComment(id, event.pathParameters?.commentId, actor),
    'GET /marketplace/sellers': ({ query }) => directoryPage('SELLERS', query.cursor, async (entries) => {
      const stats = await store.getMany(entries.map((entry) => statsKey(entry.id)));
      return entries.map((entry, index) => publicProfile(entry, stats[index]));
    }),
    'GET /marketplace/sellers/{id}': async ({ id }) => respond(200, await readSeller(id)),
    'GET /marketplace/sellers/{id}/listings': async ({ id, query }) => {
      const profile = await store.get(...profileKey(id));
      requireInput(profile, 'Seller profile not found.', 404);
      return sellerOffers(profile, query);
    },
    'GET /marketplace/sellers/{id}/reviews': async ({ id, query }) => {
      await readSeller(id);
      return directoryPage(reviewPartition(id), query.cursor, async (entries) => {
        const profiles = await fetchProfiles(entries.map((entry) => entry.authorId));
        return entries.map(({ id: reviewId, listingTitle, rating, text: message, createdAt }, index) =>
          ({ id: reviewId, listingTitle, rating, text: message, createdAt, author: authorIdentity(profiles[index]) }));
      });
    },
    'GET /marketplace/profile': async ({ actor }) => {
      const id = profileId(actor.id);
      const [profile, stats] = await store.getMany([profileKey(id), statsKey(id)]);
      return respond(200, { profile: profile ? { ...publicProfile(profile, stats), version: profile.version } : null });
    },
    'PUT /marketplace/profile': ({ actor, body }) => saveProfile(actor, body),
    'GET /marketplace/saved': ({ actor, query }) => savedPage(actor, query.cursor),
    'GET /marketplace/saved/{id}': async ({ actor, id }) => {
      const listing = await listingById(id);
      return respond(200, { saved: Boolean(await store.get(savedPartition(actor.id), rank(listing.createdAt, id))) });
    },
    'PUT /marketplace/saved/{id}': ({ actor, id, body }) => saveListing(actor, id, body.saved),
    'GET /marketplace/threads/{id}/exchange': async ({ id, actor }) => respond(200, await exchangeView(await participant(id, actor), actor)),
    'PUT /marketplace/threads/{id}/exchange': ({ id, actor }) => confirm(id, actor),
    'POST /marketplace/threads/{id}/review': ({ id, actor, body }) => review(id, actor, body),
  };

  return { routes, enrich, profileFor };
}

export { profileId };
