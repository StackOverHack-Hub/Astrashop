# Run and deploy the campus marketplace

## Local preview

For the persistent Docker setup, runtime settings, and the complete stress command, use the [container runbook](CONTAINERS.md). The [local stress report](STRESS-TEST.md) records concurrent flow and recovery results.

Start the project as described in the [README](../../README.md). Open **Marketplace** in the site header. Asha and Ravi start with example profiles. Choose Neha and open **My profile** to try creating a profile from scratch. The accounts share one in-memory catalog. Restart the API to restore its sample data.

Open a listing title to view its description, seller, availability, and public comments. Use **Contact seller** to start a private conversation. After the work or pickup is complete, confirm it from each participant's inbox. The buyer can then publish a review. AstraShop closes an item listing when both participants confirm. A service or favor can stay open for other students.

The normal backend test command runs the shop and marketplace unit tests. To test the production DynamoDB adapter and the Redis script, start DynamoDB Local and Redis on loopback. Set both test endpoints and run:

```bash
cd backend
MARKETPLACE_DYNAMO_ENDPOINT=http://127.0.0.1:8000 \
MARKETPLACE_REDIS_URL=redis://127.0.0.1:6379 \
node --test test/marketplace.integration.test.mjs
```

The integration tests create and remove a dedicated local table and temporary Redis keys.

Run `npm test` from `frontend` for client retry, session expiry, account changes, and token refresh checks. Run `npm run build` for TypeScript and the production bundle. CI runs these checks and the local service integration tests.

Listing drafts use this tab's session storage and are separated by account and listing. After a save error, use **Retry save** to confirm the original attempt. The form keeps that payload fixed until the API confirms its result. Browser storage must be available to restore a draft after navigation or sign-in. Closing the tab can remove its saved drafts.

## AWS setup

Use the same region as the shop. Confirm that your account supports ElastiCache Serverless Redis OSS and check its storage and compute charges. The marketplace uses a separate stack and private VPC. Its DynamoDB table is retained on stack deletion. [ElastiCache pricing](https://aws.amazon.com/elasticache/pricing/)

Choose these deployment values:

- `FrontendOrigin` is the canonical HTTPS AstraShop URL. Remove its trailing slash.
- `CampusEmailDomain` defaults to `adypu.edu.in`. Use the exact student email domain without the leading `@`.
- `ResourcePrefix` is a short lowercase name that is unique for your Cognito login domain in the region.

Build and deploy the marketplace stack:

```bash
cd backend
sam build --template-file marketplace-template.yaml
sam deploy --resolve-s3 --capabilities CAPABILITY_IAM \
  --stack-name astrashop-marketplace-staging --region "$ASTRASHOP_REGION" \
  --parameter-overrides \
    "FrontendOrigin=$ASTRASHOP_FRONTEND_ORIGIN" \
    "CampusEmailDomain=$ASTRASHOP_CAMPUS_DOMAIN" \
    "ResourcePrefix=$ASTRASHOP_MARKETPLACE_PREFIX"
```

After a deploy that brings word search, move existing listings onto it once (safe to repeat):

```bash
node migrate-search.mjs <MarketplaceTableName>
```

Copy these stack outputs to the frontend build environment. Keep the existing `VITE_API_URL` for the campus shop.

| Stack output | Frontend build variable |
| --- | --- |
| `MarketplaceApiUrl` | `VITE_MARKETPLACE_API_URL` |
| `CognitoLoginOrigin` | `VITE_MARKETPLACE_LOGIN_ORIGIN` |
| `CognitoClientId` | `VITE_MARKETPLACE_CLIENT_ID` |

Add the marketplace API origin and Cognito login origin to `connect-src` in the Amplify custom headers. Keep the shop API origin. Rebuild and deploy the static site. Open the site from the configured origin to test the Cognito callback.

Before public launch, test with two actual campus accounts. Verify signup rejects an outside address. Confirm a listing by one account appears in the public feed. Send a message and reply from the two accounts. Check that a third account cannot load their conversation. Run an agreed load check against staging and record API latency, API throttling, DynamoDB throttling, and Redis ECPU usage.

## Operation

| Scope | Burst capacity | Refill per minute |
| --- | ---: | ---: |
| Browse per source IP | 600 | 600 |
| Private reads per account | 120 | 120 |
| Writes per source IP | 300 | 300 |
| Writes per account | 24 | 24 |
| New listing submissions per account | 6 | 6 |

The API also uses API Gateway aggregate throttles. Its default rate is 35 requests per second with a burst of 70. Redis rate-limit errors return HTTP 429 with `Retry-After`. Redis or DynamoDB service failures can return HTTP 503. Check the API 5xx alarm, Lambda logs, DynamoDB throttles, and Redis connections and ECPU. Confirm the alarm’s metrics after deployment. The default stack does not send email alerts.

The data model uses conditional transactions for listing status, projections, and exchange completion. It uses bounded queries for categories, title prefixes, profiles, personal listings, saved listings, comments, reviews, inboxes, and message threads. The public listing feed uses at most three queries and bounded batch reads for seller names. Monitor the public category partitions and seller directory. Shard any partition that approaches its throughput limit before raising the API limit.

Listing edits can include a UUID `requestId`. The API writes the request fingerprint and result in the listing transaction. A repeat request returns that result. Reusing the ID with a different payload returns 409. Edit receipts have a seven-day TTL. Keep the same ID and payload after an uncertain result. Use a new ID and the latest version for a new edit.

New profiles with no existing listings receive an active-offer index marker. Their listings update `SELLER-OFFERS#<public-seller-id>` in each listing transaction. Existing profiles without the marker use at most four bounded history queries per page. Do not add the marker to an existing profile until all its active listings have been backfilled. A history page can have no active entries and still include a next cursor.

The public seller ID differs from the campus account identifier. The app shows the display name and any profile fields the member enters. Sellers and buyers can remove their own comments. Moderators can remove a comment through `PUT /marketplace/listings/{id}/comments/{commentId}`.

A user with the Cognito `MarketplaceModerators` group can call `GET /marketplace/reports` and `PUT /marketplace/listings/{id}/moderate` with a scoped access token. The removal request accepts a JSON object. Include `version` to require the version listed in the report. Removing a listing also stops new messages in its threads. The deletion is recorded with the moderator’s account and time. Reports expire after 90 days. Review access and data retention before onboarding real users.

DynamoDB is the system of record. Use point-in-time recovery to restore the whole marketplace table to a separate table. Validate listings, public projections, thread access, and messages together before restoring traffic. Redis buckets can be rebuilt by new traffic. The marketplace stack creates a Redis password in Secrets Manager. Coordinate a cache credential rotation with a Lambda deployment so the new credential reaches both resources. Keep credentials out of the frontend and deployment logs.
