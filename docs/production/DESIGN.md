# Astrashop production design

Status: Phases 1 and 2 built, 27 Nov 2026 (see [Phase 1 as built](#13-phase-1-as-built) and [Phase 2 as built](#14-phase-2-as-built)). It builds on the [gap analysis](GAP-ANALYSIS.md).

**Decisions taken**
- Sell to campus shops: a monthly fee per shop, with a per-reservation fee as an option.
- Extend the notebook design rather than replace it.
- Students sign in to reserve.

## 1. Requirements

### Who uses it

| Role | Signs in with | Can do |
|---|---|---|
| Visitor | nothing | Browse shops, items and marketplace listings, and search |
| Student | Campus Cognito account (email domain checked at sign-up) | Reserve (at most 3 active holds per shop), see own passes, use the marketplace |
| Shop staff | The same Cognito pool, plus a staff record for that shop | Pickup queue, set aside, collect, release, shelf counts |
| Shop owner | The same, with the `owner` role on that shop | Everything staff can do, plus catalog and photos, staff invites, hours, stats, plan status |
| Moderator | Cognito group `MarketplaceModerators` (exists) | Report queue, remove or restore listings and comments |
| Platform admin | Cognito group `PlatformAdmins` | Onboard shops, assign owners, set plan and status, suspend a shop |

### Functional
- Many shops on one deployment. Each shop belongs to a campus. Students see the shops on their campus.
- Every staff action is recorded: who, what, when, and which reservation or item.
- Owners manage their own catalog, with one photo per item. Nobody edits the database by hand or runs `seed.mjs` against production.
- Word search across a shop's catalog and the campus marketplace.
- A suspended shop drops out of search, and its staff screens become read-only.

### Non-functional

| | Target |
|---|---|
| Availability | 99.9% during shop hours |
| API latency | p95 under 300 ms at the API |
| Tenant isolation | No route returns or changes another shop's data. Enforced in the database write condition and covered by tests. |
| Abuse | No single student, IP or shop can exhaust stock or capacity for others |
| Cost | Fixed monthly infrastructure cost covered by about two paying shops. Variable cost per shop well under its fee. |

### Load estimate (year one)

These are assumptions to check during the pilot.

- 50 shops and 10,000 students per campus. In the first week of term, 30% of students reserve about 3 items each, which gives about 9,000 reservations per shop per week.
- The busiest hour holds about 10% of a day's reservations: roughly 130 reservations per hour per shop, or about 2 writes per second across 50 shops. Reads at 20 times that come to about 40 requests per second.
- **The current API Gateway throttle of 25 requests per second for the whole shop API would reject this peak.** Raise it to 200 rps with a 400 burst, and put the fairness limits in Redis per tenant (section 5).
- DynamoDB on-demand and Lambda handle this without tuning. The design only stops being trivial at hundreds of shops.

## 2. High-level design

```
 Student / staff browser ── HTTPS ──▶ CloudFront ──▶ S3 (SPA build, item photos)
        │
        └── HTTPS + Cognito access token ──▶ API Gateway HTTP API (global throttle)
                                                │
                                                ▼
                                    Lambda: one API (Node 22)
                     ┌─────────── authorize(route, actor, shopId) ───────────┐
                     │  default deny · role table · tenant in write condition │
                     └────────────────────────────────────────────────────────┘
                │            │              │              │             │
                ▼            ▼              ▼              ▼             ▼
          Tenancy      Items (+GSI)   Reservations    Marketplace    Redis (Valkey)
          shops, staff, by shop       (+GSIs) by       single table   token buckets:
          hold counters, audit,       shop/status,     + TOKEN# rows  student, IP,
          invites, campus domains     by student                      shop, failed auth
                ▲
   EventBridge (10 min) ─▶ sweep: per shop, query due holds and expire them
   Cognito: one pool · pre-sign-up looks up the campus by email domain
   CloudWatch: JSON logs + metrics per shop · alarms · later: payment webhooks ─▶ SQS ─▶ Lambda
```

Main structural changes:

1. **One identity model.** Use the existing marketplace Cognito pool for everyone. The shared shop key becomes a legacy fallback for the pilot shop only, behind a flag, and is removed after migration.
2. **One API and one stack.** Today there are two SAM stacks and two Lambdas, while the container already serves both handlers. Merge them, keeping the handlers as separate modules.
3. **Tenancy without rekeying.** Item and reservation IDs are already unique across their tables, so they keep their table keys. Reservations are UUIDs. Pilot items are `item-NN`, so items created in Phase 2 get UUIDs.
   - Each row gains a `shopId`, which never changes.
   - Staff routes read the row with a strongly consistent read and refuse it unless its `shopId` matches the shop in the path. A row from another shop gets the same `404` as an unknown one. Because `shopId` never changes, that read has the same effect as repeating the check in the write condition.
   - Queue and catalog reads go through indexes keyed by shop.
   - This avoids moving existing data to new keys.

## 3. Data model

### Items (existing table, key `id`)

Add:
- `shopId`
- `photoKey`
- `active`: soft delete, so past reservations keep their item
- `version`: a number incremented on every stock change; fixes the recount problem from the hardening review

| Index | Partition | Sort | Serves |
|---|---|---|---|
| `ByShop` | `shopId` | `nameFolded` | Catalog page and catalog search |

### Reservations (existing table, key `id`)

Add:
- `shopId` and `studentId`.
- Two attributes that exist only while a hold needs attention, so the indexes on them stay small. An index keyed by plain `status` would grow with every expired row forever, which is the unbounded-history problem from the hardening review.
  - `heldShop`: set to `shopId` while the hold is `HELD`, removed when it ends.
  - `returnShop`: set at expiry, removed when staff mark the unit back on the shelf.

| Index | Partition | Sort | Serves |
|---|---|---|---|
| `Held` | `heldShop` (present only while held) | `expiresAt` | The staff pickup queue, and the expiry sweep (`expiresAt < now`) |
| `AwaitingReturn` | `returnShop` (present only until returned) | `endedAt` | The "Expired pickups" list |
| `ByShopCreated` | `shopId` | `createdAt` | Stats and history over a date window |
| `ByStudent` | `studentId` | `createdAt` | "My passes" |

Together, `Held` and `AwaitingReturn` replace the two scans flagged as shortcuts in `app.mjs`. Stats read a bounded window from `ByShopCreated` instead of the whole table.

### Tenancy (new single table, `pk`/`sk`, TTL on `expires`)

| pk | sk | Attributes | Purpose |
|---|---|---|---|
| `SHOP` | `{shopId}` | name, pickupWindow, plan, status (`trial`, `active`, `suspended`), createdAt | Shop profile and billing state. One partition, so the sweep can list every shop. |
| `SHOP#{shopId}` | `STAFF#{sub}` | role (`owner`, `staff`), addedBy, addedAt | Membership |
| `USER#{sub}` | `SHOP#{shopId}` | role, shop name | The reverse lookup behind `GET /me`. Written in the same transaction as the staff row. |
| `CAMPUS#{campusId}` | `SHOP#{shopId}` | name | Shops on a campus |
| `DOMAIN#{emailDomain}` | `CAMPUS` | campusId | Pre-sign-up check. Replaces the single `CAMPUS_EMAIL_DOMAIN` setting. |
| `STUDENT#{sub}` | `HOLDS#{shopId}` | active | Hold cap counter |
| `SHOP#{shopId}` | `AUDIT#{iso}#{id}` | actor, action, target, before, after, expires (1 year) | Staff action log |
| `INVITE#{token}` | `INVITE` | shopId, role, email, expires (7 days) | Staff invite links |

**Reserve is one transaction across tables.** It extends the existing all-or-nothing write:

1. Item: `stock >= 1`, then `stock -1` and `version +1`. The shop comes from a consistent read of the item just before. Soft delete (`active`) arrives with Phase 2's catalog editing.
2. Hold counter: `attribute_not_exists(active) OR active < 3`, then `active +1`.
3. Reservation: `attribute_not_exists(id)`. This is the retry guard.
4. Shop meta: a condition check that `status <> suspended`.

Collect, release and expire decrement the counter in the same transaction that ends the hold, with the condition `active > 0`. A missed path therefore can't push the count negative or lock a student out. Holds made before sign-in existed have no `studentId`, so their endings skip the counter. Two phones racing for the fourth hold get one success and one `409 HOLD_LIMIT`, the same way the last unit works today.

**Safe retries must survive the new conditions.** Today a retry after a lost response returns `200` with the original hold. In the new transaction, the retry also re-checks stock and the cap. If the first attempt took the last unit or the third hold, the retry would fail with out-of-stock or `HOLD_LIMIT` before the existing-reservation guard is reached. The rule on any cancelled reserve:

1. Read the reservation by `id`. If it exists and belongs to this student, return `200` with it. If it belongs to someone else, return `404`.
2. Only then map the cancellation reasons, in operation order: item condition → `409 Out of stock`, counter → `409 HOLD_LIMIT`, shop → `403 Shop unavailable`. Throttling and validation errors stay `503`, which the hardening review also asked for.
3. Test: response lost on the student's third hold, then a retry, returns the original hold.

### Marketplace (existing)

- **Word search.** Add a `TOKEN#{kind}#{word}` row (sort key `rank#id`) for each distinct folded word of a title, written in the same transaction as the listing (at most about 12 words, well under DynamoDB's 100-item transaction limit).
- **Query.** Look up the longest search word, with a prefix match on the last word for type-ahead. Then filter the remaining words against the folded title stored on the row.
- **Later, for many campuses:** listings gain `campusId`, and feed and token keys gain a `#{campusId}` segment.

### Shop catalog search

A shop's catalog is small (hundreds of items). Query `ByShop` and match words in the Lambda. A per-shop catalog never needs an index of its own.

## 4. API

Rules for every route:
- Every route is declared in one table with the role it requires, and anything not listed is denied.
- `shopId` comes from the path and is checked against the actor's membership.
- Writes repeat the check as a condition expression.

| Role | Routes |
|---|---|
| Public | `GET /campuses/{campusId}/shops` · `GET /shops/{shopId}` · `GET /shops/{shopId}/items?q=` · `GET /shops/{shopId}/items/{itemId}` · existing marketplace reads |
| Signed in | `GET /me` returns the account id, the platform-admin flag, and shop roles, and drives the UI · `POST /reservations` (adds `401` and `409 HOLD_LIMIT`) · `GET /me/reservations` (Phase 3) |
| Anyone with the id | `GET /reservations/{id}`. The id is a random secret that only the student's phone knows, so it works like a private link. That keeps pickup passes from before sign-in working. It also suits the AWS authorizer, which cannot make sign-in optional for one route. |
| Staff | `GET /shops/{shopId}/reservations?status=` · `POST /shops/{shopId}/reservations/{id}/{set-aside,collect,release,returned}` · `PUT /shops/{shopId}/items/{id}/stock {stock, expectedVersion}` · `GET /shops/{shopId}/stats` |
| Owner | `PUT /shops/{shopId}/staff/{userId}` with `{ role }` (`null` removes; built) · Phase 2: `POST /shops/{shopId}/items` · `PUT /shops/{shopId}/items/{id}` · `POST /shops/{shopId}/items/{id}/photo` · `PUT /shops/{shopId}` · `GET /shops/{shopId}/staff` · `GET /shops/{shopId}/audit` |
| Moderator | Existing `GET /marketplace/reports` and `PUT /marketplace/listings/{id}/moderate` |
| Platform admin | `GET/POST /admin/shops` · `PUT /admin/shops/{shopId}` (status, plan, owner) |

The photo route returns an S3 presigned POST that allows only JPEG, PNG or WebP up to 2 MB. Photos are served through CloudFront. In the Docker setup, the same route writes to a local volume, so the app still runs without AWS.

During migration, the old `/items` and `/shop/*` routes map to the pilot shop. They are removed once the pilot shop's staff sign in with accounts.

## 5. Rate limits and abuse

The design reuses the existing Redis `tokenBucket` and `redisLimiter`, and adds no new components. The marketplace policies stay as they are.

| Key | Policy (starting values) | Stops |
|---|---|---|
| `reserve:student` | 10 per 10 min | Rapid reserve and release cycling |
| `reserve:ip` | 30 per 10 min | Many accounts from one network |
| Hold cap (DynamoDB, not Redis) | 3 active per student per shop | Hoarding: exact and atomic |
| `authfail:ip` | 10 per 15 min, then `429` and a log event | Token and legacy-key guessing |
| `staff:user` | 120 per min | Runaway scripts on staff accounts |
| `shop:tenant` | 50 rps | One shop's flood starving other shops |
| `public:ip` | 120 per min | Scraping the catalog |

**When Redis is down, writes fail closed:** they get `503` with `retry-after`, as the marketplace does today. Public reads skip the limiter during an outage, so browsing survives it. This changes the marketplace, which today also returns `503` for browse when Redis is down (`marketplace.mjs:368-370`). Log each skipped check so a long outage still raises an alarm.

**Built in Phase 1:**
- The hold cap.
- `reserve:student` at 20 attempts per 10 minutes, in the container.
- The container's existing per-IP shop limits: 60 writes and 600 reads per minute.

**Not built:**
- `authfail:ip`. Tokens are verified cryptographically, and a random counter key of 16 or more characters can't be guessed at 60 tries a minute.
- `staff:user`, `shop:tenant` and `public:ip`. These wait until real traffic shows a need.

The shop Lambda has no Redis, so on that path the hold cap and the API Gateway throttle are the limits.

## 6. Admin console

The console lives at `/admin`, as a separately loaded part of the app, so students never download it. Its sections are filtered by `GET /me`.

| Section | Visible to | Built from |
|---|---|---|
| Counter: pickups, expired pickups, shelf counts | Staff | The existing `Shop.tsx`, moved here |
| Catalog: create, edit, photo, hide | Owner | New |
| Staff: invite by email link, change role, remove | Owner | New |
| Activity: audit log, stats, reservation funnel | Owner | Existing `/shop/stats`, plus the audit log |
| Moderation: reports, remove or restore | Moderator | Existing routes, new screen |
| Shops: onboard, assign owner, plan, suspend | Platform admin | New |

## 7. Customer experience (extending the notebook design)

The ruled sheet, ink blue and margin red stay, along with "colour only for meaning". The additions:

- **Path routes** replace hash tabs, so every item, listing and seller has a shareable URL. Amplify needs one SPA rewrite rule. `http-server.mjs` falls back to `index.html` for any GET without a file extension.
- **Search-first home.** One search box returns two groups: "At [shop name]" (reserve now) and "From students" (marketplace). There is a shop picker for campuses with several shops, plus popular course items.
- **Item page.** Photo, large price, stock dot, shop hours, and a reserve button that stays pinned to the bottom on phones. After reserving, the pickup pass opens.
- **Photos everywhere.** 4:3 cards that load lazily. Without a photo, the card falls back to the item's category drawn in the notebook style.
- **Loading and empty states.** Placeholder cards that match the final layout while loading. Empty results suggest marketplace matches, or a nearby spelling.
- **Navigation.** Shop · Marketplace · My passes · account. "Counter" or "Admin" appears only for users who have a role.
- **Sign-in at the moment of intent.** Tapping Reserve while signed out opens Cognito sign-in and returns to the same item, with the reservation ready to confirm.

A later revenue feature, kept out of the phases below: **course kits** let an owner bundle items, and a student reserves the whole kit in one transaction.

## 8. Reliability, observability, security

- **Metrics per shop** (CloudWatch embedded metric format): `reservation_created`, `collected`, `expired`, `hold_limit_hit`, `rate_limited`, `authfail`.
- **Alarms:** 5xx rate, limiter unavailable, sweep failures, and a missing sweep heartbeat (from the hardening review).
- **Logs:** each line carries `requestId`, `shopId`, `route`, `status` and `ms`. No emails or tokens in logs.
- **Tenant isolation tests.** For every staff and owner route, a user from shop A calls it with shop B's IDs and must get `404`, never `403`, so that IDs from other shops are not confirmed to exist.
- **Secrets:** no shared secret remains after migration. The legacy shop key lives in SSM until it is removed.
- **Migration** is idempotent and resumable:
  1. Create the pilot shop.
  2. Backfill `shopId` on items and reservations, and set `version = 0`.
  3. Build the indexes.
  4. Deploy the code that reads `shopId`.
  5. Invite the pilot shopkeeper as owner.
  6. Turn off the legacy key.

  Anonymous holds already made stay collectable by pickup code until they expire.

## 9. Money (Phase 4)

1. **Start manually.** The platform admin sets `plan` and `status`, and invoices go out of band. `shortcut: manual billing, replace once there are more than about 10 paying shops.`
2. **Then automate with Razorpay Subscriptions.** Webhook → SQS → Lambda verifies the signature and updates `status`. Payment state lives in the provider. Astrashop stores only the plan, the status, and a ledger of events that is only ever appended to.
3. **Per-reservation usage** comes from the existing `collected` count per shop per month.

## 10. Trade-offs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Where staff roles live | DynamoDB rows, read on every staff request (no cache yet) | Custom claims in the Cognito token (pre-token-generation trigger) | Works on every Cognito plan. Removing someone takes effect at once instead of at token expiry (up to 1 h). Costs one strongly consistent read per staff request. Add a short cache if that read ever shows up in latency. |
| Tenancy keys | `shopId` attribute plus a write condition | Rekey every row as `SHOP#id#...` | No data rewrite. Isolation is still enforced by the database. Slightly less natural to query, which the `ByShop` index covers. |
| Search | Word rows in DynamoDB | Hosted search service | No fixed cost and no extra component. Gives up typo tolerance and ranking. Revisit around 50,000 listings. |
| Hold cap | Counter in the reserve transaction | Count with a query, or Redis | Exact under races. Redis and queries can both overshoot. |
| Limiter outage | Fail closed on writes, open on reads | Fail open everywhere | Hoarding during an outage is worse than a short retry for the student. |
| Stacks | Merge into one | Keep two | One deploy, one identity, one search. The container already runs both handlers. |
| Redis | ElastiCache Serverless, Valkey engine | Redis OSS engine, or a fixed node | Valkey's minimum monthly charge is far lower than Redis OSS Serverless. Check current pricing before switching. |

## 11. Phases

Each phase ships on its own and keeps CI green.

| Phase | Scope | Depends on |
|---|---|---|
| **1. Identity and tenancy** | Tenancy table, `shopId` backfill, indexes (removes the scans), `GET /me`, the `authorize()` role table, staff and owner sign-in with the legacy key behind a flag, sign-in to reserve plus the hold cap, Redis limits on shop routes, audit log, cross-tenant tests.<br>**Local parity**, so the README's "no AWS account needed" stays true and the Docker CI keeps passing: `fake-db.mjs` gains `QueryCommand` on indexes (today it supports Scan, Get, Update and transactions only), `container-bootstrap.mjs` creates the indexes and the Tenancy table, and demo identities gain staff, owner and platform-admin accounts. This is the largest phase, and nothing in it is visible to customers. | Nothing |
| **2. Admin console** (built) | `/admin` with counter, catalog, staff invites, activity, moderation queue, shop onboarding | Phase 1 |
| **3. Customer experience** | Item photos (upload in the catalog, S3 + CDN, display on cards), path routes, search-first home, word search, item page, My passes, shop picker, loading and empty states | Phase 1 for My passes and sign-in. The routing, home and cards can start alongside Phase 1 on a separate branch. Expect a small merge in `Student.tsx` and `api.ts`, where Phase 1 adds sign-in to reserve. |
| **4. Money and operations** | Plan and status enforcement, Razorpay webhooks, usage metering, metrics and alarms per shop, stack merge | Phases 1 and 2 |

## 12. What to revisit as it grows

| Trigger | Change |
|---|---|
| About 50,000 listings, or a need for typo tolerance | Hosted search service, fed from DynamoDB Streams |
| More than 1,000 shops | Per-shop sweep as a fan-out (Step Functions Map, or SQS per shop) instead of one loop |
| Many campuses in the marketplace | `campusId` segments on feed and token keys |
| Staff-removal delay too long for an enterprise customer | Shorter cache, or a revocation list in Redis |
| Online payment at reservation time | Separate payments service and ledger; holds become payment-backed |

## 13. Phase 1 as built

Built 27 Nov 2026 on branch `production/phase-1-tenancy`.

**Verification**
- 62 backend unit tests and 8 client tests pass.
- The 3 service integration tests pass against DynamoDB Local and Redis in Docker. Without those services they are skipped.
- The shop integration test runs the shop flows against DynamoDB Local. That includes adding an index to a table from the old version in place.
- The Docker stress run had 0 failures, and all five outage and recovery checks passed.
- `cfn-lint` passes on both templates.
- No AWS deploy was run.

**Changes from the sections above**

| Planned | Built | Why |
|---|---|---|
| `Held` and `AwaitingReturn` indexes | One `Queue` index on `queueShop` + `expiresAt`. `queueShop` is set while a hold is held or expired-but-not-returned, and removed on collect, release or return. | One index serves both the counter queue and the sweep, and it stays as small as the to-do list. |
| `ByShopCreated` and `ByStudent` indexes | Deferred. Stats scan and filter by shop (marked `shortcut:` in `app.mjs`). Reservations store `studentId` already. | CloudFormation adds one index per table per deploy. The `Queue` index used this deploy's slot. |
| `GET /reservations/{id}` owner-only | Open to anyone with the id, which works like a private link | See §4 |
| `DELETE /shops/{shopId}/staff` | `PUT` with `role: null` | No CORS or route changes for a new method |
| Staff role cache | No cache | Removal takes effect at once; see §10 |
| Write conditions on `shopId` | A consistent read and shop check before the write | `shopId` never changes; see §2 |
| `authfail:ip` and other limits | Not built | See §5 |

**Migration** (`backend/migrate-tenancy.mjs`, also run on every local container start):
- Stamps `shopId` and `version` on pilot items.
- Stamps `shopId`, `expiresAt` and `queueShop` on pilot reservations.
- Creates the default shop and, optionally, its owner.
- Skips rows that change while it runs, and is safe to run again.

Until it runs after an AWS upgrade, the pilot shop's catalog and counter queue look empty, while reserving, stats and the counter key keep working.

**Accounts for shop staff:** self sign-up stays limited to the campus email domain. An administrator creates accounts for shopkeepers who have no campus email (`admin-create-user`); the pre-sign-up trigger lets those through.

**Known limits:**
- Pickup passes are stored per device, not per account. If two accounts share a phone, the second can't retry the first one's pending hold: it gets "Reservation id already used". Phase 3's My passes fixes this.
- The student item list shows only the default shop. The API supports many shops, and the counter shows the items of whichever shop it opened. The shop picker arrives in Phase 3.

**Not in Phase 1:** campus and email-domain rows, staff invites, the `/admin` screens, item create and edit, and enforcement of a suspended shop's read-only staff. Reserving at a suspended shop is already refused.

## 14. Phase 2 as built

Built 27 Nov 2026 on branch `production/phase-2-admin`.

**What it adds:**
- The shop admin at `#admin`, loaded as its own chunk of about 33 kB. Sections follow `GET /me`, which now also returns `moderator` and each shop's `status` and `pickupWindow`.
- Catalog editing with a client-made uuid per new item and version-checked edits. "Off sale" (`active: false`) hides an item from the public catalog and refuses new reservations (`409 UNAVAILABLE`), but it stays in the counter's ledger.
- Staff invites as single-use links that expire after 7 days. Only a SHA-256 digest of the token is stored. Accepting a link deletes the invite and adds the membership in one transaction, so a link can't be used twice. Someone who is already on the staff gets `409`, and the link stays usable.
- The activity log, paged newest first. The cursor is checked to belong to the same shop, so it can't page another shop's log.
- Stats read the new `ByShopCreated` index over a window (`?days=`, 90 by default), which replaces the scan from Phase 1.
- Platform shop list, status changes (trial, active, suspended), and shops opened without an owner (an owner invite follows).
- The moderation queue on the existing report and moderate routes.

**Verification**
- 70 backend unit tests and 8 client tests pass.
- The integration tests pass three runs in a row against DynamoDB Local. They cover the invite transaction, the filtered catalog query, the reverse-ordered activity page and the stats index.
- The browser check covered the owner adding and hiding items, the invite created and accepted by another account, the staff counter, the activity log, moderator removal, and platform shop creation and suspension.

**Changes from the plan**

| Planned | Built | Why |
|---|---|---|
| Catalog with photos | Photos moved to Phase 3 | Photos need new storage (S3 + CDN, a CSP change, a local stand-in). Students can't see them until Phase 3's cards, so upload and display ship together. |
| Staff added by account id | Invite links; the id route stays for role changes | Owners don't know Cognito account ids |
| `GET /me/reservations` and the `ByStudent` index | Still Phase 3 | Nothing in the console needs them |

**Upgrade path:** the pilot stack upgrades in two deploys, Phase 1 then Phase 2. Each adds one index to the reservations table, and CloudFormation allows one per table per deploy. Stats show an error until `ByShopCreated` finishes building.

**Reading after writing on AWS:**
- Tenancy base-table queries (`/me`, staff, activity, the shop list) use `ConsistentRead`, so a person who has just joined sees their shop at once.
- Index queries (catalog, queue, stats) can lag a write by a moment. The catalog screen updates its list from the saved item instead of reloading, so it never shows a stale version or misses a new item.
- Neither DynamoDB Local nor the in-memory database models index lag, so this has not been exercised.

**Known limits:**
- An owner created by migration, by `ownerId`, or before Phase 2 has no display name, so the console shows the end of the account id.
- Pending invites can't be listed or revoked. They expire after 7 days.
- Reports stay listed after their listing is removed; the console marks them.
