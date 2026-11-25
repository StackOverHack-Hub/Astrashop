# Astrashop AWS build summary

**Deployment.** [LIVE PROTOTYPE URL] in [AWS REGION], using [RELEASE COMMIT]. Fill in these details from the deployed build before submission.

```mermaid
flowchart TD
    Browser[Student or shop browser] -->|Load web app| Hosting[Amplify Hosting]
    Browser -->|HTTPS JSON| Api[API Gateway HTTP API]
    Api -->|Invoke route handler| Lambda["Node.js Lambda"]
    Lambda -->|Read or update inventory| Items[DynamoDB items]
    Lambda -->|Create or update holds| Holds[DynamoDB reservations]
    Schedule[EventBridge every 10 min] -->|Expire overdue holds| Lambda
    Lambda -.->|JSON logs, alarms| Watch[CloudWatch + SNS]
```

## Request flow

1. The browser loads the static React app from Amplify Hosting. The Vite build uses `VITE_API_URL` to locate the HTTP API. `GET /items` reads the catalog, stock counts, latest confirmation times, and pickup windows.
2. For a hold, the browser generates a reservation UUID and sends it with the item ID. Lambda issues one DynamoDB transaction. It subtracts one unit only if stock is at least one and creates a `HELD` reservation only if the ID is unused. Both writes commit together. A retry sends the same UUID, so it cannot deduct another unit through the same reservation ID.
3. The browser checks status by reservation ID. The shop counter sends its key in `x-shop-key` to list holds, confirm a stock count, or collect or release a hold. API Gateway handles browser CORS. Lambda checks the key and allows collect and release only from `HELD`. Release returns one unit in the same transaction that closes the hold. A stock recount carries the count the shopkeeper started from and is rejected if a reservation or release changed stock in the meantime, so a unit already set aside is never offered again. Transient DynamoDB conflicts and throttling return `503`, which the app retries with the same reservation ID.
4. Every hold carries an `expiresAt`. Every 10 minutes EventBridge invokes the same Lambda, which marks overdue holds `EXPIRED` and returns each unit in one transaction, so unclaimed stock goes back on the shelf. The shop screen lists those holds as "put back on shelf" until the shopkeeper confirms, so the physical unit rejoins the shelf before the next count. A hold that can't expire is logged with its ids and trips the Lambda error alarm.

## What each service does

| AWS service | Feature and data | Why it fits | Cost, security, or reliability |
| --- | --- | --- | --- |
| **Amplify Hosting** | Serves the compiled HTML, JavaScript, and CSS. | Publishes a mobile web app over HTTPS from a static build. | Only the API URL is public frontend configuration. Keep the served build available through Demo Day and check hosting usage in AWS Billing. |
| **API Gateway HTTP API** | Receives catalog, reservation, and shop requests and passes them to Lambda. | Gives the browser a single HTTPS API endpoint with method and path routing. | CORS is locked to the frontend origin (`AllowedOrigin`). Stage throttling (burst 50, 25 requests/s) caps cost and abuse. JSON access logs record route, status, latency and caller IP for 30 days. |
| **AWS Lambda** | Handles JSON validation, stock updates, and reservation state changes. | One handler is enough for the small set of MVP routes without running a server continuously. | The shop key is a `NoEcho` parameter, compared in constant time and never logged. The role allows only GetItem, PutItem, UpdateItem and Scan on the two tables. JSON logs with request IDs, kept 30 days. |
| **Amazon EventBridge** | Scheduled rule that runs hold expiry every 10 minutes. | Serverless cron with no extra code to host. | Each run is idempotent: a hold already collected or released is skipped, so a run can never restock twice. |
| **Amazon CloudWatch + SNS** | Log groups, an API 5xx alarm and a Lambda error alarm, optional email. | Built-in metrics for API Gateway and Lambda, no agent. | Alarms cover both caught failures (5xx responses) and crashes or timeouts, including the expiry job. |
| **Amazon DynamoDB** | Stores item details, shelf stock and confirmation timestamps, and UUID-keyed holds with codes and status. | Conditional transactions protect the subtract-and-create and release-and-restock operations. | On-demand capacity. Point-in-time recovery (35 days) and `Retain` deletion policy protect the data. Conflicts return `503`, not "sold out". |

## Deployment and verification

The AWS SAM template provisions the API, Lambda, execution role, tables, schedule, log groups and alarms. CI runs the backend tests, the frontend build and `cfn-lint` on every pull request. Build the frontend against the API output URL and deploy the static build to Amplify Hosting. If seeding sample items, keep the **Sample data** label visible. Record the budget alert, Free Tier eligibility for the deployed resources, and the test date in [DEPLOYMENT NOTES].

Record actual results for [SIGNED-OUT HTTPS TEST], [LAST-UNIT AND SAME-ID RETRY TEST], [SHOP PREFLIGHT AND KEY TEST], and [COLLECT AND RELEASE TEST]. Update the service list and request flow to match the release commit before handoff.
