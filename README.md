# Astrashop

Reserve the exact course item you need at your campus shop, and pick it up before your deadline.

**Live AWS pilot:** [Open Astrashop](https://main.d122punxfnd0ue.amplifyapp.com/). The catalog contains labeled sample stock. All application records are stored in Amazon DynamoDB in Sydney (`ap-southeast-2`). See the [deployment record](docs/production/DEPLOYMENT.md) for the release, services, and verified checks.

A student searches the shop's items, checks availability and hours, and reserves a unit with a six-digit pickup code. The shopkeeper confirms when the unit is set aside. The student can refresh their pickup pass to check whether it’s ready. At the counter, the shopkeeper checks the code and marks the unit collected. The student pays in person.

The shop counter has separate sections for pickups, shelf counts, and pilot numbers. The dashboard tracks reservation outcomes and the time from reservation to set-aside or collection. Use the [pilot measurement sheet](docs/pilot/measurement.md) to record the student’s start time, their deadline, and baseline attempts.

Built for Techfest IIT Bombay "Campus to Cloud", Round 1. Plan and research: [docs/astrashop-mvp](docs/astrashop-mvp/).

## Architecture

```
 Phone browser ──HTTPS──▶ Amplify Hosting (React + TypeScript + Vite, static)
       │
       └──HTTPS──▶ API Gateway HTTP API ──▶ Lambda (Node.js 22, one function)
                   (throttled, access logs)    │       ▲
                                               │       └── EventBridge, every 10 min: expire old holds
                                               ├─▶ DynamoDB  Items         (id, name, stock, confirmedAt, pickupWindow)
                                               └─▶ DynamoDB  Reservations  (id, itemId, code, status, createdAt, expiresAt)
                                   CloudWatch: JSON logs (30 days), 5xx and error alarms → optional email (SNS)
```

| AWS service | Why |
|---|---|
| Amplify Hosting | HTTPS URL for the static frontend, security headers, no server to run |
| API Gateway HTTP API | Cheapest API Gateway option; CORS, throttling and access logs built in |
| Lambda | Pay per request; the whole API is one small function |
| DynamoDB (on-demand) | Transactions make "last unit" reservations safe; point-in-time restore for the data |
| EventBridge (scheduled rule) | Runs hold expiry every 10 minutes so unclaimed units go back on the shelf |
| CloudWatch + SNS | Logs, two alarms, and an optional email when something breaks |
| SAM / CloudFormation | The whole backend is one template; deploy it once per environment |

### Why two students can't get the last unit
`POST /reservations` is one DynamoDB `TransactWriteItems` call:

1. decrement the item's `stock`, only if `stock >= 1`
2. create the reservation, only if that reservation `id` doesn't exist yet

Both happen or neither does. If two students race for the last unit, one transaction succeeds and the other gets `409 Out of stock`.

The phone generates the reservation `id` once and resends the same `id` on retry. A retry after a dropped response finds the reservation already there and gets it back (`200`) instead of taking a second unit.

Collect and release only work on a reservation that is still `HELD`, so pressing Release twice can't put a unit back on the shelf twice.

When the shopkeeper recounts the shelf, the app sends the version of the item they were looking at. Every reserve, release, expiry and recount changes that version. If anything changed in the meantime, the recount is rejected and the shopkeeper is asked to refresh, so a unit that's already set aside can't be sold twice. This also catches stock that changed and then came back to the same number.

### Shops, accounts and limits

Many shops run on one deployment. Everyone signs in with the campus Cognito account the marketplace uses: students, shop staff, shop owners and platform admins. Every route declares who may call it (anyone, a signed-in student, the shop's staff, its owner, or a platform admin), and anything not declared is refused. Someone with no role at a shop gets `404` for it, the same answer as for a shop that doesn't exist.

- **Holds per student.** Reserving needs an account, and each student can hold at most 3 items per shop. The limit is checked in the same all-or-nothing write as the last unit, so two phones racing for the fourth hold get one success and one `409` with `code: HOLD_LIMIT`. A retry of a hold that already went through still returns that hold, even when it took the last unit or the last free hold. Collecting, releasing or expiring a hold gives the place back.
- **Staff and owners.** A platform admin opens a shop and sends its owner an invite link. Owners invite staff the same way: the person opens the link, signs in, and joins, so nobody handles account ids. A link works once and expires after 7 days. Staff run the counter for their shop only. Every staff action writes an audit entry (who, what, when), kept for a year.
- **Shop admin** (**For shops** in the header, `#admin`). Each person sees only their sections:
  - **Counter:** staff.
  - **Catalog, Staff and Activity:** owners. In the catalog they add and edit items, or take one off sale; it stays countable but students can't see or reserve it. Staff covers people, invite links and shop details. Activity is the audit log.
  - **Moderation:** marketplace moderators, for reported listings.
  - **Shops:** platform admins, who open shops, send owner invites and suspend a shop. A suspended shop takes no new reservations.
  
  The console loads separately, so students never download it.
- **Storefront.**
  - Students pick a shop when there is more than one; the default shop comes first.
  - Items show photos, or an initials label in the notebook style when there is none.
  - Every item has its own page at `#item/<shop>/<item>`. It's a plain link, so it can be shared, and on phones the price and **Reserve** stay pinned to the bottom of the screen.
  - Searching also shows matching offers **From students** in the marketplace.
  - Pickup passes come from the student's account, so they follow the student to any device.
- **Photos.**
  - Owners add a photo from the catalog. The browser shrinks it to 1200 px on its long side, as a JPEG of about 100-250 KB, before uploading.
  - The API keeps only real JPEG, PNG or WebP files of up to 600 KB, checking the file's first bytes rather than trusting its name. Each file is named by its own content hash, so it can be cached for a year.
  - Storage is S3 behind CloudFront on AWS, a Docker volume locally, and memory in the lightweight preview.
- **Billing.** Shops pay a monthly subscription through Razorpay.
  - Create each subscription with the note `shopId` set to the shop's id, and point Razorpay's webhook at the `BillingWebhookUrl` output, with the same secret as `RazorpayWebhookSecret`.
  - The subscription's status sets the shop's: `active` opens it, while `halted`, `cancelled`, `completed`, `paused` and `expired` suspend it. `pending` (Razorpay retrying a payment) leaves it open.
  - Each event is recorded once in an append-only ledger. An older event arriving late never undoes a newer one, and a suspension set by a platform admin stays until an admin lifts it.
  - Pickups are counted per shop per month for a per-pickup fee, and platform admins see the last three months on the Shops screen, along with each shop's plan.
- **Suspended shops** take no new reservations and drop out of the shop list, and their owners can't change the catalog, photos, staff or shop details. The counter still finishes pickups already made.
- **Marketplace search** matches any word of a title, or the start of one: "sheet" finds "A2 drawing sheet". When several words are typed, every one must match.
- **The pilot shop.** Data from before shops existed belongs to the default shop (`DefaultShopId`). The `/shop/*` routes and the shared counter key still open that one shop's counter until its staff sign in with accounts. Unset the key to switch it off.

Every hold has an `expiresAt` (24 hours by default, set by `HoldMinutes`). Every 10 minutes a scheduled run marks overdue holds `EXPIRED` and puts their units back, using the same all-or-nothing write as a release. Expired holds count as no-shows in the dashboard. **Expired pickups** lists each hold until the shopkeeper taps **Back on shelf**, even if the shop was closed for days. The shopkeeper returns any set-aside units before confirming a recount. A hold can still be collected in the few minutes between its deadline and the next expiry run, which gives late students a short grace period. Choose `HoldMinutes` around the shop's hours. A 24-hour hold placed at 5 p.m. on Saturday runs out on Sunday while the shop is closed.

## API

Signed-in routes take the campus access token as `Authorization: Bearer …`. The original contract: [IMPLEMENTATION.md](docs/astrashop-mvp/IMPLEMENTATION.md#api-contract-frozen-for-phase-2). The design is in [docs/production/DESIGN.md](docs/production/DESIGN.md).

| Method | Path | Who | What it does |
|---|---|---|---|
| GET | `/shops/{shopId}/items` | anyone | A shop's catalog, sorted by name |
| GET | `/shops` | anyone | Shops taking reservations, the default shop first |
| GET | `/me` | signed in | Your account and the shops where you're staff or owner |
| GET | `/me/reservations` | signed in | Your 20 most recent holds on any device, with item name and hours |
| PUT | `/shops/{shopId}/items/{id}/photo` | owner | `{ data }`: the photo as base64, up to 600 KB, or `null` to remove it. The response includes `photoUrl`. |
| PUT | `/shops/{shopId}/staff/{userId}` | owner | `{ role: "owner" \| "staff" \| null }` changes or removes someone's access to the shop (not your own) |
| GET | `/shops/{shopId}/staff` | owner | Staff with their roles and the names they gave when joining |
| POST | `/shops/{shopId}/invites` | owner | `{ role }` makes a single-use link token, valid 7 days. Only a digest is stored. |
| POST | `/invites/accept` | signed in | `{ token, name? }` joins the shop the invite is for; `404` once used or expired |
| GET | `/shops/{shopId}/catalog` | staff | Every item, including those off sale |
| POST | `/shops/{shopId}/items` | owner | `{ id, name, course?, price, stock, pickupWindow? }` adds an item. The client makes the uuid so a retry returns the same item. |
| PUT | `/shops/{shopId}/items/{id}/details` | owner | `{ name, course, price, pickupWindow, active, expectedVersion }` edits an item or takes it off sale |
| PUT | `/shops/{shopId}` | owner | `{ name, pickupWindow }` |
| GET | `/shops/{shopId}/audit` | owner | Activity, newest first, 50 per page with `?cursor=` |
| GET, POST | `/admin/shops` | platform admin | List shops, or open one `{ id, name, pickupWindow?, ownerId? }` |
| PUT | `/admin/shops/{shopId}` | platform admin | `{ status?, plan? }`. A status set here is the admin's, and billing never lifts an admin suspension. |
| POST | `/billing/razorpay` | Razorpay | Subscription webhooks, checked against `X-Razorpay-Signature` (HMAC-SHA256 of the body); `501` when no secret is set |
| GET, PUT, POST | `/shops/{shopId}/reservations`, `/stats`, `/items/{id}`, `/reservations/{id}/…` | staff | The counter routes below, for that shop. Recounts send `{ stock, expectedVersion }`. Stats cover the last 90 days, or `?days=`. |

The pilot routes below act on the default shop. `/items` is public, `POST /reservations` needs a signed-in student, and the `/shop/*` routes need the header `x-shop-key`.

| Method | Path | What it does |
|---|---|---|
| GET | `/items` | List items |
| POST | `/reservations` | Reserve one unit `{ id, itemId }`; `401` when signed out, `409` with `code: HOLD_LIMIT` at 3 holds |
| GET | `/reservations/{id}` | Reservation status (`HELD`, `COLLECTED`, `RELEASED`, `EXPIRED`), pickup code, `expiresAt`, and `setAsideAt` once confirmed |
| GET | `/shop/reservations` | Held reservations plus expired holds not yet marked back on the shelf, oldest first |
| GET | `/shop/stats` | Reservation counts and median times from reservation to set-aside or collection |
| PUT | `/shop/items/{id}` | Set shelf stock `{ stock, expectedStock }`, stamps `confirmedAt`; `409` if stock changed since the shopkeeper loaded it |
| POST | `/shop/reservations/{id}/set-aside` | Confirm the held unit is set aside and keep its first confirmation time |
| POST | `/shop/reservations/{id}/collect` | Mark collected |
| POST | `/shop/reservations/{id}/release` | Release, stock goes back up by one |
| POST | `/shop/reservations/{id}/returned` | Clear an expired hold's "put back on shelf" reminder (stock was already restored at expiry) |

## Run it on your machine

For the complete local app, install Docker Desktop and double-click `start.command` on macOS or `start.cmd` on Windows. You can also run this command from the project folder:

```bash
docker compose up --build --wait --wait-timeout 180
```

Open [localhost:8080](http://localhost:8080). The setup builds one UI and API image. It starts persistent DynamoDB Local and Redis beside it. It creates the local tables and adds sample data without replacing existing records, and upgrades tables from an older version in place. Demo accounts:
- Asha, Ravi and Neha are students.
- **Shop owner** and **Shop staff** run the demo shop.
- **Moderator** reviews marketplace reports.
- **Platform admin** opens shops.
- The counter key `local-shop-key` still works.

Choose one under **For shops**. Tap Reserve to choose a student. Choose a demo account in Marketplace to try both sides of an exchange.

Use `docker compose down` to stop it. The named volumes keep the data. See the [container runbook](docs/campus-marketplace/CONTAINERS.md) for settings, the one-command stress test, and the AWS configuration for the same image. No AWS account is required for this setup.

### Lightweight preview without Docker

No AWS account needed. This runs the real API code with an in-memory database and the sample catalog. Data resets when you stop it.

```bash
cd backend && npm install && npm run local
```

In a second terminal:

```bash
cd frontend && npm install && npm run dev
```

Open http://localhost:5173. Tap Reserve and choose a demo student. The shop admin is at http://localhost:5173/#admin: choose **Shop owner**, **Shop staff**, **Moderator** or **Platform admin**, or use the key `local-shop-key` on the counter. To watch holds expire quickly, start the API with `HOLD_MINUTES=2 npm run local`. The local server checks for expired holds every minute.

The **Marketplace** tab offers student-to-student listings for items, services, and favors. Choose a local demo account to post or try the inbox. For the separate AWS stack, Cognito login, Redis limits, and staging checks, see the [marketplace runbook](docs/campus-marketplace/OPERATIONS.md).

## Run the tests

```bash
cd backend && npm install && npm test
```

The tests run the real handler against an in-memory stand-in for DynamoDB that also mimics stale reads, paged scans and queries, and throttling. They cover:

- the last-unit race, retries, out of stock, double release, collect-then-release, stale recounts, busy and throttled responses, input limits, and hold expiry
- the 3-hold limit and its race, a retry at the limit
- staff of one shop trying every counter route on another, owner and admin roles
- the audit trail, suspended shops, and the pilot-data migration

`test/shop.integration.test.mjs` runs the same flows against DynamoDB Local when `MARKETPLACE_DYNAMO_ENDPOINT` is set.

To test concurrent buyer and seller flows, dependency outages, and recovery in disposable local Docker services:

```bash
./scripts/stress-local.sh
```

This command leaves the normal local app and its data in place. It saves reports in `artifacts/` and removes its own test containers and volumes. See the [recorded local results](docs/campus-marketplace/STRESS-TEST.md).

CI (`.github/workflows/ci.yml`) runs the backend and client tests, frontend build, local service integration tests, Docker flow and recovery checks, and `cfn-lint` on both templates.

## Deploy to AWS

You need an AWS account, about 15 minutes, and a Mac with Homebrew. Pick one region (for example `ap-south-1`, Mumbai) and use it for everything.

1. Install the tools:

```bash
brew install awscli aws-sam-cli
```

2. Sign in to AWS from the terminal (use an IAM user's access key, or `aws configure sso` if your account uses IAM Identity Center):

```bash
aws configure
```

3. Deploy the marketplace stack first ([runbook](docs/campus-marketplace/OPERATIONS.md)). Its Cognito pool is where students, staff and admins sign in. Note its `CognitoUserPoolId` and `CognitoClientId` outputs.

Deploy the shop backend. When asked:
- Choose a stack name such as `astrashop-prod` and your region.
- Paste the two Cognito outputs as `UserPoolId` and `UserPoolClientId`.
- Leave `AllowedOrigin` as `*` for now (step 7 locks it down).
- Keep `HoldMinutes` at `1440` unless the pilot shop wants a shorter hold.
- `ShopKey` is optional. Leave it empty for a new deployment. An existing pilot can keep its key (`openssl rand -base64 24` makes one) until its staff have accounts.
- For `AlertEmail`, enter an address to get alarm emails (confirm the link AWS sends), or leave it blank.

```bash
cd backend && sam deploy --guided
```

If SAM asks "ApiFunction may not have authorization defined, Is this okay?" for a public or pilot route, answer `y`: the default is No and aborts the deploy. The pilot `/shop/*` routes are protected by the shop key inside the Lambda, and all other routes by the Cognito authorizer plus a role check in the Lambda. Don't run `sam build` first: `src/` has no `package.json`, and plain `sam deploy` uploads it as is (the Lambda runtime already includes the AWS SDK).

The output prints `ApiUrl`, `ItemsTableName`, `ReservationsTableName` and `TenancyTableName`.

4. Load the sample catalog (every item is marked as sample data; re-running skips items that already exist):

```bash
cd backend && node seed.mjs <ItemsTableName>
```

Then put the catalog and any existing reservations into the default shop, and make the shopkeeper its owner. Run this right after every upgrade from the single-shop version too: until it runs, the pilot shop's catalog and counter queue look empty. Reserving, stats and the counter key keep working in the meantime. It is safe to run again.

```bash
cd backend && node migrate-tenancy.mjs --items <ItemsTableName> --reservations <ReservationsTableName> --tenancy <TenancyTableName> --shop campus-shop --name "Campus stationery shop" --owner <shopkeeper's Cognito sub>
```

A shopkeeper without a campus email gets an account from an administrator. Self sign-up stays limited to the campus domain. The `sub` in the output is the account id to pass as `--owner` or to `POST /admin/shops`:

```bash
aws cognito-idp admin-create-user --user-pool-id <CognitoUserPoolId> --username owner@shop.example --user-attributes Name=email,Value=owner@shop.example Name=email_verified,Value=true
```

To open more shops, add a platform admin to the `PlatformAdmins` Cognito group. That admin opens the shop under **For shops → Shops** and sends the owner the invite link.

**Upgrading the single-shop pilot takes three deploys.** CloudFormation adds only one index per table per deploy, and Phases 1, 2 and 3 each add one to the reservations table.
1. Deploy Phase 1 (commit `c656253`, which adds `Queue`) and run `migrate-tenancy.mjs`.
2. Deploy Phase 2 (commit `dc53254`, which adds `ByShopCreated`).
3. Deploy this version, which adds `ByStudent` and the photo bucket and CDN.

While each new index builds, the screens that read it show an error state (the counter's numbers, then passes from the account) and recover on their own. After deploying the marketplace with word search, run `node migrate-search.mjs <MarketplaceTableName>` once so older listings show up in search again.

5. Build the frontend against your API and the marketplace stack's sign-in. Reserving needs sign-in, so the Cognito settings are required.

```bash
cd frontend && npm install && VITE_API_URL=<ApiUrl> VITE_MARKETPLACE_API_URL=<MarketplaceApiUrl> VITE_MARKETPLACE_LOGIN_ORIGIN=<CognitoLoginOrigin> VITE_MARKETPLACE_CLIENT_ID=<CognitoClientId> npm run build
```

6. Host it: open the AWS Amplify console, choose **Create new app**, then **Deploy without Git**. Zip the *contents* of `frontend/dist` and drop the zip in. Amplify gives you an `https://…amplifyapp.com` URL. Then open **Hosting → Custom headers**, paste [`frontend/amplify-custom-headers.yml`](frontend/amplify-custom-headers.yml), and replace `API_ORIGIN` with your `ApiUrl` followed by your `MarketplaceApiUrl` and `CognitoLoginOrigin`, separated by spaces. Without the login origin the browser blocks the last step of sign-in. Replace `PHOTO_ORIGIN` with the `PhotoBaseUrl` output, or item photos won't load. Save, then **upload the same zip again**: Amplify only applies header changes on the next deploy. Check that they're live:

```bash
curl -sI https://main.<app-id>.amplifyapp.com | grep -iE "content-security-policy|strict-transport-security"
```

7. Lock CORS to your site. Redeploy with your Amplify URL (no trailing slash). `--save-params` writes it into `samconfig.toml` so later plain `sam deploy` runs keep it. Without it, the next deploy would restore `*`.

```bash
cd backend && sam deploy --parameter-overrides AllowedOrigin=https://main.<app-id>.amplifyapp.com --save-params
```

Check that another site is refused (this should print nothing):

```bash
curl -si -X OPTIONS <ApiUrl>/items -H "Origin: https://example.com" -H "Access-Control-Request-Method: GET" | grep -i access-control-allow-origin
```

8. Check it on a phone. Sign in and reserve an item. Open `<your URL>/#shop`, sign in as the shop owner, open the shop's counter, and select **Set aside**. Refresh the student pass to check the confirmation. Use its code at the counter and mark the pickup collected.

To change the backend later, run `sam deploy` again from `backend/`. To change the frontend, rebuild and upload a new zip. For a separate test environment, deploy a second stack (for example `astrashop-dev`) with its own key.

## Running it in production

- **Logs:**
  - CloudWatch log groups for the Lambda (JSON, with request IDs) and for API access logs (route, status, latency, caller IP), both kept for 30 days.
  - Rejected shop keys are logged as `shop_key_rejected`, each expiry run as `holds_expired`, and billing problems as `billing_signature_rejected`, `billing_unmatched` and `billing_status_skipped`.
  - The container logs one `request` line per API call (route pattern, status, milliseconds).
- **Metrics** (namespace `Astrashop`, in total and per shop): `ReservationCreated`, `HoldLimitHit`, `Collected`, `Expired`, and `SweepRun`. They are written as CloudWatch embedded-metric log lines, straight to stdout so Lambda's JSON log format leaves them as they are. A container needs the CloudWatch agent or FireLens for the same. **First check after deploying:** confirm `Astrashop/SweepRun` appears in CloudWatch metrics within 20 minutes. If it doesn't, the lines aren't being turned into metrics, and `SweepHeartbeatAlarm` will go red about 30 minutes after the deploy.
- **More alarms:**
  - `SweepHeartbeatAlarm`: the expiry job hasn't run for 30 minutes, so holds have stopped expiring.
  - `HoldCountMismatchAlarm`: hold counts disagree with holds.
  - `BillingSignatureAlarm`: repeated bad webhook signatures, meaning a forged webhook or a secret changed on only one side.
  - On the marketplace stack, `LimiterUnavailableAlarm`: Redis is down and writes are refused.
- **Alarms:** `Api5xxAlarm` fires on 5 or more server errors in 5 minutes. `FunctionErrorsAlarm` fires on any Lambda crash or timeout, and also when the expiry job can't expire a hold (logged as `hold_expiry_failed` with the reservation and item ids). They email `AlertEmail` if you set one. After the first deploy, open CloudWatch → Metrics → ApiGateway, check that `5xx` appears under this API's ApiId and Stage, and that `Api5xxAlarm`'s graph shows that line. The alarm treats missing data as OK, so a mismatched metric would stay silent.
- **Limits:**
  - The API is throttled to bursts of 400 and 200 requests per second, sized for about 50 shops at the start of term. API Gateway treats these as targets, not exact caps.
  - Hoarding is stopped by the 3-hold limit per student per shop. Holds expire on their own.
  - The container adds Redis limits per network address and per student (20 reserve attempts per 10 minutes).
  - The app retries throttled (`429`) reservations with the same id.
  - `hold_count_mismatch` in the logs means a pickup finished without a hold count to give back (for example after a table restore). The pickup still succeeds.
- **Data safety:** all three tables have point-in-time recovery (any second in the last 35 days) and are kept if the stack is deleted. A restore creates *new* tables, and the stack keeps using the old ones. To recover:
  1. Restore **all three** tables to the same timestamp, so stock, holds and hold counts still match.
  2. Compare held reservations with stock and fix any mismatch.
  3. Copy the rows back into the live tables, or change the template to use the restored tables, before taking new reservations.
  4. Note the table names (stack outputs) before any `sam delete`.
- **Secrets:** the optional pilot shop key is a `NoEcho` parameter, compared in constant time and never logged. Rotate it with `sam deploy --guided` and a new key, or set it empty to turn it off.
- **Upgrading an existing stack:** this version adds one index to each existing table and creates the Tenancy table. CloudFormation adds only one index per table per deploy, so add any later index in a deploy of its own. Run `migrate-tenancy.mjs` right after the deploy.

### Cost and cleanup
Requests are pay-per-use and fit the AWS Free Tier at pilot traffic. Point-in-time recovery and stored logs bill per GB-month, which is cents for this data, and retained tables keep billing after `sam delete` until you delete them. On day one, check **Billing → Free Tier** and create a monthly **Budget** alert (for example $5). Keep the stack up through Demo Day (17 Dec). To remove the backend afterwards:

```bash
cd backend && sam delete
```

The three tables are kept on purpose, so a mistaken delete can't wipe reservations. When you really want them gone, delete them in the DynamoDB console (names from the `ItemsTableName`, `ReservationsTableName` and `TenancyTableName` outputs). Then delete the app in the Amplify console.

## What's left out on purpose
- **Not in scope:** online payments, delivery, and more than one campus. Marketplace includes private messages for buyer and seller handover.
- **Shop Lambda limits:** the shop Lambda has no Redis, so it relies on API Gateway throttles and the per-student hold limit. Marketplace and the combined container also use Redis for application limits.
- **Two stacks on purpose:** the shop and marketplace stay separate stacks that share one Cognito pool. Merging them would mean moving live Cognito users and retained tables between stacks, a risky one-way migration that adds nothing students or shops would notice.
- **Not built:** online payment at reservation time, course kits, and trial expiry (platform admins move shops off trial by hand or through billing).
- **Hash links, not paths:** links stay `#…` (for example `#item/campus-shop/item-02`). They are already shareable, and path links would need server rewrites for little gain without server rendering. See the phases in [DESIGN.md](docs/production/DESIGN.md#11-phases).

## License
MIT, see [LICENSE](LICENSE).
