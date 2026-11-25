# Astrashop

Reserve the exact course item you need at your campus shop, and pick it up before your deadline.

A student searches the shop's items, sees how many are on the shelf and when that was last confirmed, reserves one unit, and gets a 6-digit pickup code. The shopkeeper sets that unit aside, then marks it collected (the student pays in person) or releases it back to the shelf.

Built for Techfest IIT Bombay "Campus to Cloud", Round 1. Plan and research: [docs/astrashop-mvp](docs/astrashop-mvp/).

## Architecture

```
 Phone browser ──HTTPS──▶ Amplify Hosting (React + TypeScript + Vite, static)
       │
       └──HTTPS──▶ API Gateway HTTP API ──▶ Lambda (Node.js 22, one function)
                                               │
                                               ├─▶ DynamoDB  Items         (id, name, stock, confirmedAt, pickupWindow)
                                               └─▶ DynamoDB  Reservations  (id, itemId, code, status, createdAt)
```

| AWS service | Why |
|---|---|
| Amplify Hosting | HTTPS URL for the static frontend, no server to run |
| API Gateway HTTP API | Cheapest API Gateway option, CORS built in |
| Lambda | Pay per request; the whole API is one small function |
| DynamoDB (on-demand) | Transactions make "last unit" reservations safe |
| SAM / CloudFormation | The whole backend is one template you can deploy and delete |

### Why two students can't get the last unit
`POST /reservations` is one DynamoDB `TransactWriteItems` call:

1. decrement the item's `stock`, only if `stock >= 1`
2. create the reservation, only if that reservation `id` doesn't exist yet

Both happen or neither does. If two students race for the last unit, one transaction succeeds and the other gets `409 Out of stock`.

The phone generates the reservation `id` once and resends the same `id` on retry. A retry after a dropped response finds the reservation already there and gets it back (`200`) instead of taking a second unit.

Collect and release only work on a reservation that is still `HELD`, so pressing Release twice can't put a unit back on the shelf twice.

## API

Shop routes need the header `x-shop-key`. Full contract: [IMPLEMENTATION.md](docs/astrashop-mvp/IMPLEMENTATION.md#api-contract-frozen-for-phase-2).

| Method | Path | What it does |
|---|---|---|
| GET | `/items` | List items |
| POST | `/reservations` | Reserve one unit `{ id, itemId }` |
| GET | `/reservations/{id}` | Reservation status and pickup code |
| GET | `/shop/reservations` | Held reservations, oldest first |
| PUT | `/shop/items/{id}` | Set shelf stock `{ stock }`, stamps `confirmedAt` |
| POST | `/shop/reservations/{id}/collect` | Mark collected |
| POST | `/shop/reservations/{id}/release` | Release, stock goes back up by one |

## Run the tests

```bash
cd backend && npm install && npm test
```

The tests run the real handler against an in-memory stand-in for DynamoDB. They cover the last-unit race, retries, out of stock, the shop key, double release, and collect-then-release.

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

3. Deploy the backend. When asked, choose a stack name such as `astrashop`, your region, and a `ShopKey` of at least 8 characters. Keep the key private; the shopkeeper types it into the shop screen.

```bash
cd backend && sam deploy --guided
```

The output prints `ApiUrl` and `ItemsTableName`.

4. Load the sample catalog (every item is marked as sample data):

```bash
cd backend && node seed.mjs <ItemsTableName>
```

5. Build the frontend against your API:

```bash
cd frontend && npm install && VITE_API_URL=<ApiUrl> npm run build
```

6. Host it: open the AWS Amplify console, choose **Create new app**, then **Deploy without Git**. Zip the *contents* of `frontend/dist` and drop the zip in. Amplify gives you an `https://…amplifyapp.com` URL.

7. Check it on a phone: reserve an item, then open `<your URL>/#shop`, enter the shop key, and mark it collected.

To change the backend later, run `sam deploy` again from `backend/`. To change the frontend, rebuild and upload a new zip.

### Cost and cleanup
Everything here is pay-per-request and sits inside the AWS Free Tier at pilot traffic. Check **Billing → Free Tier** in the console on day one, and keep the stack up through Demo Day (17 Dec). To remove the backend afterwards:

```bash
cd backend && sam delete
```

Then delete the app in the Amplify console.

## What's left out on purpose
Payments, delivery, chat, and more than one campus. Holds don't expire on their own: the shopkeeper releases stale ones from the shop screen. The shop screen uses one shared key, which is enough for a single pilot shop.

## License
MIT, see [LICENSE](LICENSE).
