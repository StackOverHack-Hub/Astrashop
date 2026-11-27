# Production readiness: gap analysis and options

Reviewed 27 Nov 2026 against `main` at `9ea6034`. This covers what exists, what is missing, and the one business decision that shapes the target design.

**Decided 27 Nov 2026:**
- Option B: sell to campus shops.
- Extend the current design.
- Students sign in to reserve.

The target architecture is in [DESIGN.md](DESIGN.md).

## Summary

The backend is in better shape than the product looks. It has all-or-nothing writes for the last unit, safe retries, conditional state changes, Cognito token checks, Redis rate limits, health checks, a strict CSP, and recorded stress tests. The gaps:

1. Admin, auth, limits and search are built for the **marketplace** only. The **shop** side, which is the paid product, has one shared key and no limits on reservations.
2. Several backend features have **no screen** (moderation) or **no API** (adding catalog items).
3. Two products share one tab bar. The staff tool sits in the customer navigation, and nothing has a photo.

## Where it stands

| Area | Status | Evidence | Gap |
|---|---|---|---|
| **Authentication** | Partial | Marketplace verifies Cognito access tokens (`backend/src/container-auth.mjs`). The shop counter compares one shared static key (`backend/src/app.mjs:25-30`). Student reservations are anonymous, keyed by an ID the phone generates. | Three separate auth models. No staff accounts. No record of who collected or released a unit. No key rotation. No student identity on a reservation. |
| **Admin** | Backend only | The moderator group check exists (`marketplace.mjs:116-118`, `:350-352`), along with `GET /marketplace/reports` and `PUT /marketplace/listings/{id}/moderate`. | No moderation screen. The `moderator` demo account has nothing to open. No way to add an item or change its name, price or course: items come only from `seed.mjs`, and `PUT /shop/items/{id}` sets stock only. No platform admin. |
| **Rate limiting** | Partial | Marketplace uses a Redis token bucket per IP, per account and per publish (`marketplace-limit.mjs`, `marketplace.mjs:353-371`). In the container, `server.mjs` also limits shop routes per IP (60 writes and 600 reads a minute). The shop Lambda has only one API Gateway throttle of 25 rps with a burst of 50 for the **whole** API (`template.yaml:51-52`). | **One anonymous client can hold every unit** through `POST /reservations` (a revenue and trust risk): 60 reserves a minute drains any shelf. *Corrected 27 Nov: the first version of this row missed the container's per-IP shop limits.* |
| **Search** | Weak | The shop catalog is a full `Scan` filtered in the browser. Marketplace search writes one `TITLE#` row per listing and matches a prefix of the whole title (`marketplace.mjs:67`, `:131-141`). | "sheet" does not find "A2 drawing sheet". No word matching, typo tolerance, price sort, or search across shop and marketplace. |
| **Structure** | Two products glued together | The shop reservation app uses `Items` and `Reservations` tables with its own SAM stack (`template.yaml`). The marketplace uses a single table and a second stack (`marketplace-template.yaml`). Hash tabs in `frontend/src/main.tsx` join them. | No shared identity, catalog or search. "Shop counter" is a staff tool listed beside customer tabs. No shareable URL for a shop item. |
| **Customer UX** | Plain by design | `docs/design/ui-references.md` chose restraint on purpose: a ruled sheet, and colour only where it carries meaning. | No photos anywhere. No home page and no shop item page. Text-only cards. Three tabs with equal weight and no main path. |
| **Reliability** | Strong | Transactions, idempotent IDs, conditional writes, `/health/ready`, Docker stress and recovery tests in CI. | Known shortcuts: reservations use scans (`app.mjs:79`, `:153`). The recount guard compares stock numbers, so it misses the case where stock changes and returns to the same number (see `docs/reviews/hardening-review.md`). |
| **Observability** | Partial | JSON logs, 5xx and error alarms. | No business funnel (search → reserve → set aside → collect), no tracing, no dashboard for a shop owner beyond `/shop/stats`. |
| **Payments** | None | Students pay at the counter. | Nothing to charge shops or students with yet. |

## The decision that shapes everything: who pays

Multi-tenancy changes the auth, admin, search and both table designs. A target architecture written before this answer would need rewriting.

| | A. One hardened shop | B. Software for campus shops, sold per shop (recommended) | C. Marketplace earns the money |
|---|---|---|---|
| **Revenue** | One contract or grant | Monthly fee per shop, optionally plus a small fee per collected reservation | Featured listings, or a fee on paid exchanges |
| **What changes** | Keep the current schema. Add staff accounts and the Phase 1 items. | A `shopId` on every key. Staff accounts with a role per shop. A platform admin who onboards shops. Search scoped to a campus. | Online payments (for example Razorpay), refunds, disputes, and much heavier moderation |
| **Cost to build** | Lowest | Medium: one data migration, one auth model | Highest: payment compliance and trust-and-safety work |
| **Scale limit** | One stack per shop works up to about 5 to 10 shops, then deploys and upgrades become the bottleneck | Hundreds of shops on one stack | Depends on how many students list and buy |
| **Main risk** | Selling a second shop costs as much as the first | Migration of existing shop data | Students may not pay fees for peer exchanges |

Recommendation: **B**, with the marketplace kept as the reason students return between purchases. Run one stack per shop as a stopgap until the tenant migration lands.

## Phase 1: needed under every option

None of these depend on the tenancy answer, and all of them are visible.

1. **Admin console** at its own route, off the customer navigation:
   - Moderation queue on the existing report and moderate routes.
   - Shop catalog create and edit: name, price, course, photo. This needs one new `POST /shop/items` and a wider `PUT`.
2. **Shop rate limits**, reusing the Redis `tokenBucket` that already runs in Compose:
   - `POST /reservations` per student, plus a cap on active holds per student.
   - (Dropped while building Phase 1: a failed-key limiter adds little against a random key of 16 or more characters, and the container already limits each IP.)
3. **Word search.** One `TOKEN#<word>` row per word of a title, with an intersection at query time. Shop catalog search moves to the server.
   - Revisit around 50,000 searchable listings, or when typo tolerance becomes a requirement. At that point, move to a hosted search service. A managed search cluster has a fixed monthly cost that a campus product's margins do not cover earlier.
4. **Student sign-in to reserve** (needs a product decision). The same Cognito pool as the marketplace allows a cap of N active holds per student. That is the real fix for hoarding; per-IP limits only slow it down. The cost is one extra step for the student.

## Customer UX direction

The current restraint is a deliberate choice, so it is not reskinned without agreement. The two ways forward:

- **Extend:** keep the notebook identity and add product photos, a shop item page, a search-first home that covers both products, and a richer listing card. Move staff tools to `/admin`.
- **Replace:** a new visual direction with a design pass from scratch.

## What to revisit as it grows

| Trigger | Change |
|---|---|
| A few thousand reservations per shop | Replace reservation scans with a `status` + `expiresAt` index. The code already marks these as shortcuts. |
| About 50,000 listings, or a need for typo tolerance or ranking | Hosted search service, fed from DynamoDB Streams |
| Many campuses or Redis memory pressure | Redis cluster mode (the limiter is already cluster-safe, one key per bucket) |
| Online payments | Separate payments service, webhooks into a queue, and a ledger table that is never updated in place |
