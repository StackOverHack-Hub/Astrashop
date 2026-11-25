# Astrashop

Reserve the exact course item you need at your campus shop, and pick it up before your deadline.

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

When the shopkeeper recounts the shelf, the app sends the stock number they were looking at. If a student reserved a unit in the meantime, the recount is rejected and the shopkeeper is asked to refresh, so a unit that's already set aside can't be sold twice.

Every hold has an `expiresAt` (24 hours by default, set by `HoldMinutes`). Every 10 minutes a scheduled run marks overdue holds `EXPIRED` and puts their units back, using the same all-or-nothing write as a release. Expired holds count as no-shows in the dashboard. **Expired pickups** lists each hold until the shopkeeper taps **Back on shelf**, even if the shop was closed for days. The shopkeeper returns any set-aside units before confirming a recount. A hold can still be collected in the few minutes between its deadline and the next expiry run, which gives late students a short grace period. Choose `HoldMinutes` around the shop's hours. A 24-hour hold placed at 5 p.m. on Saturday runs out on Sunday while the shop is closed.

## API

Shop routes need the header `x-shop-key`. Full contract: [IMPLEMENTATION.md](docs/astrashop-mvp/IMPLEMENTATION.md#api-contract-frozen-for-phase-2).

| Method | Path | What it does |
|---|---|---|
| GET | `/items` | List items |
| POST | `/reservations` | Reserve one unit `{ id, itemId }` |
| GET | `/reservations/{id}` | Reservation status (`HELD`, `COLLECTED`, `RELEASED`, `EXPIRED`), pickup code, `expiresAt`, and `setAsideAt` once confirmed |
| GET | `/shop/reservations` | Held reservations plus expired holds not yet marked back on the shelf, oldest first |
| GET | `/shop/stats` | Reservation counts and median times from reservation to set-aside or collection |
| PUT | `/shop/items/{id}` | Set shelf stock `{ stock, expectedStock }`, stamps `confirmedAt`; `409` if stock changed since the shopkeeper loaded it |
| POST | `/shop/reservations/{id}/set-aside` | Confirm the held unit is set aside and keep its first confirmation time |
| POST | `/shop/reservations/{id}/collect` | Mark collected |
| POST | `/shop/reservations/{id}/release` | Release, stock goes back up by one |
| POST | `/shop/reservations/{id}/returned` | Clear an expired hold's "put back on shelf" reminder (stock was already restored at expiry) |

## Run it on your machine

No AWS account needed. This runs the real API code with an in-memory database and the sample catalog. Data resets when you stop it.

```bash
cd backend && npm install && npm run local
```

In a second terminal:

```bash
cd frontend && npm install && npm run dev
```

Open http://localhost:5173. The shop counter is at http://localhost:5173/#shop, with the key `local-shop-key`. To watch holds expire quickly, start the API with `HOLD_MINUTES=2 npm run local`. The local server checks for expired holds every minute.

## Run the tests

```bash
cd backend && npm install && npm test
```

The tests run the real handler against an in-memory stand-in for DynamoDB that also mimics stale reads, paged scans and throttling. They cover the last-unit race, retries, out of stock, the shop key, double release, collect-then-release, stale recounts, busy/throttled responses, input limits, and hold expiry.

CI (`.github/workflows/ci.yml`) runs these tests, the frontend type-check and build, and `cfn-lint` on the template for every push to `main` and every pull request.

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

3. Make a shop key (at least 16 characters). Keep it private; the shopkeeper types it into the shop screen:

```bash
openssl rand -base64 24
```

Deploy the backend. When asked, choose a stack name such as `astrashop-prod`, your region, and paste the key as `ShopKey`. Leave `AllowedOrigin` as `*` for now (step 7 locks it down). Keep `HoldMinutes` at `1440` unless the pilot shop wants a shorter hold. For `AlertEmail`, enter an address to get alarm emails (confirm the link AWS sends), or leave it blank.

```bash
cd backend && sam deploy --guided
```

SAM asks "ApiFunction may not have authorization defined, Is this okay?" once per route. Answer `y` each time: the default is No and aborts the deploy. The shop routes are protected by the shop key inside the Lambda. Don't run `sam build` first: `src/` has no `package.json`, and plain `sam deploy` uploads it as is (the Lambda runtime already includes the AWS SDK).

The output prints `ApiUrl` and `ItemsTableName`.

4. Load the sample catalog (every item is marked as sample data; re-running skips items that already exist):

```bash
cd backend && node seed.mjs <ItemsTableName>
```

5. Build the frontend against your API:

```bash
cd frontend && npm install && VITE_API_URL=<ApiUrl> npm run build
```

6. Host it: open the AWS Amplify console, choose **Create new app**, then **Deploy without Git**. Zip the *contents* of `frontend/dist` and drop the zip in. Amplify gives you an `https://…amplifyapp.com` URL. Then open **Hosting → Custom headers**, paste [`frontend/amplify-custom-headers.yml`](frontend/amplify-custom-headers.yml), and replace `API_ORIGIN` with your `ApiUrl`. Save, then **upload the same zip again**: Amplify only applies header changes on the next deploy. Check that they're live:

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

8. Check it on a phone. Reserve an item, open `<your URL>/#shop`, enter the shop key, and select **Set aside**. Refresh the student pass to check the confirmation. Use its code at the counter and mark the pickup collected.

To change the backend later, run `sam deploy` again from `backend/`. To change the frontend, rebuild and upload a new zip. For a separate test environment, deploy a second stack (for example `astrashop-dev`) with its own key.

## Running it in production

- **Logs:** CloudWatch log groups for the Lambda (JSON, with request IDs) and for API access logs (route, status, latency, caller IP). Both are kept for 30 days. Rejected shop keys are logged as `shop_key_rejected`, and each expiry run as `holds_expired`.
- **Alarms:** `Api5xxAlarm` fires on 5 or more server errors in 5 minutes. `FunctionErrorsAlarm` fires on any Lambda crash or timeout, and also when the expiry job can't expire a hold (logged as `hold_expiry_failed` with the reservation and item ids). They email `AlertEmail` if you set one. After the first deploy, open CloudWatch → Metrics → ApiGateway, check that `5xx` appears under this API's ApiId and Stage, and that `Api5xxAlarm`'s graph shows that line. The alarm treats missing data as OK, so a mismatched metric would stay silent.
- **Limits:** every route is throttled to bursts of 50 and 25 requests per second. API Gateway treats these as targets, not exact caps, but they bound cost and slow scripted hoarding. Holds expire on their own, and the app retries throttled (`429`) reservations with the same id.
- **Data safety:** both tables have point-in-time recovery (any second in the last 35 days) and are kept if the stack is deleted. A restore creates *new* tables, and the stack keeps using the old ones. To recover:
  1. Restore **both** tables to the same timestamp, so stock and holds still match.
  2. Compare held reservations with stock and fix any mismatch.
  3. Copy the rows back into the live tables, or change the template to use the restored tables, before taking new reservations.
  4. Note the table names (stack outputs) before any `sam delete`.
- **Secrets:** the shop key is a `NoEcho` parameter, compared in constant time and never logged. Rotate it with `sam deploy --guided` and a new key.

### Cost and cleanup
Requests are pay-per-use and fit the AWS Free Tier at pilot traffic. Point-in-time recovery and stored logs bill per GB-month, which is cents for this data, and retained tables keep billing after `sam delete` until you delete them. On day one, check **Billing → Free Tier** and create a monthly **Budget** alert (for example $5). Keep the stack up through Demo Day (17 Dec). To remove the backend afterwards:

```bash
cd backend && sam delete
```

The two tables are kept on purpose, so a mistaken delete can't wipe reservations. When you really want them gone, delete them in the DynamoDB console (names from the `ItemsTableName` and `ReservationsTableName` outputs). Then delete the app in the Amplify console.

## What's left out on purpose
- **Not in scope:** payments, delivery, chat, and more than one campus.
- **Shop login:** one shared key, which is enough for a single pilot shop. Move to Amazon Cognito with an API Gateway JWT authorizer once more than one shop or shopkeeper needs their own login.
- **Per-IP rate limits:** need AWS WAF, which HTTP APIs don't support. They'd mean fronting the API with CloudFront or switching to a REST API, which isn't worth it at pilot scale.

## License
MIT, see [LICENSE](LICENSE).
