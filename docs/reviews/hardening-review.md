# Production hardening review

Reviewed `git diff main...hardening/production` from `main` at `1ca870a` to `hardening/production` at `5d761ed`. File and line references below refer to the hardening branch.

## Findings

### High · Expiry makes a physical set-aside unit available before it returns to the shelf

**File and line** `backend/src/app.mjs:55`, `backend/src/app.mjs:79`, `backend/src/app.mjs:140`, `frontend/src/Shop.tsx:183`.

**Failure scenario.** The only unit is in the set-aside pile when the shop closes. The sweep increments sellable stock overnight and another student reserves it before anyone has checked the unit back in. If the shop is closed for more than 24 hours after expiry, the return notice drops out of the list. A subsequent shelf recount can silently lose the unit from inventory even though it is still in the pile. The shop screen also has no record of which return notices were already acted on.

**Suggested fix.** Let expiry close the student hold and create pending shelf-return work. Require a shop acknowledgment that atomically increments stock and stamps `restockedAt` once. Keep unacknowledged returns visible across closures, alongside the separate last-24-hours history. Include an off-hours expiry and a repeated acknowledgment in tests.

### Medium · Existing holds never expire after an in-place upgrade

**File and line** `backend/src/app.mjs:76`, `backend/src/app.mjs:102`.

**Failure scenario.** A `HELD` row created before this branch has `createdAt` but no `expiresAt`. An upgrade retains the row. Every sweep skips it, and its stock stays deducted until someone manually releases or collects it.

**Suggested fix.** Add a rollout migration or a conditional fallback deadline derived from `createdAt`. Decide and document a grace period for existing promises. Test a pre-upgrade row with `expiresAt` missing.

### Medium · Collect can succeed after the displayed deadline

**File and line** `backend/src/app.mjs:47`, `backend/src/app.mjs:172`, `frontend/src/Student.tsx:213`.

**Failure scenario.** A hold reaches `expiresAt` at 11:01 and the next sweep runs at 11:10. The shop can collect it at 11:05 because collection only checks for `HELD`. If the sweep wins first, the same pickup fails. The student may also keep seeing a held code in an open tab until a refresh.

**Suggested fix.** Enforce the deadline in the conditional collect write, using the same boundary as expiry. Define how legacy holds are handled. In the UI, refresh when the deadline passes or the tab regains focus, and stop presenting an expired code as usable. Test collection just before, at, and after the deadline with the sweep delayed.

### Medium · The sweep suppresses actionable transaction failures

**File and line** `backend/src/app.mjs:57`, `backend/src/app.mjs:81`, `backend/template.yaml:141`.

**Failure scenario.** An item row is absent after a partial table recovery. The stock arithmetic in the restock transaction fails validation, so the hold stays `HELD`. The catch treats that cancellation like a harmless collect race. Every sweep can return success with `expired: 0` and the Lambda Errors alarm remains green.

**Suggested fix.** Inspect the ordered cancellation reasons. Treat a failed `HELD` condition on the first operation as benign. Count and retry transient cases in bounded fashion and surface persistent failures with the reservation and item identifiers. Emit per-run processed, deferred, and failed counts, and alarm on persistent failures or a missing sweep heartbeat. **AWS basis:** transaction cancellation includes validation errors and conflicts as well as failed conditions. [DynamoDB transaction errors](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)

### Medium · The sweep and shop queue read unbounded reservation history

**File and line** `backend/src/app.mjs:33`, `backend/src/app.mjs:65`, `backend/src/app.mjs:76`, `backend/src/app.mjs:142`, `backend/template.yaml:34`.

**Failure scenario.** Terminal rows accumulate until gathering every page takes longer than the Lambda's 10-second timeout. The sweep waits for the whole scan before attempting its first expiry. Each later invocation starts from the first page again. The shop route also pulls every historical row into Lambda before it applies the 24-hour filter, so its queue can time out even when few holds are actionable.

**Suggested fix.** Query due holds using an index keyed by status and `expiresAt`, and query recent expired rows by `endedAt`. Process a bounded batch and resume across invocations when needed. Cap or paginate shop responses. Moving the shop filter into DynamoDB reduces returned data as an interim measure. **AWS basis:** a `Scan` reads up to 1 MB per page before it applies a filter. [DynamoDB scan semantics](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html)

### Medium · A reserve and expiry can cancel out the numeric recount guard

**File and line** `backend/src/app.mjs:60`, `backend/src/app.mjs:113`, `backend/src/app.mjs:159`, `frontend/src/Shop.tsx:136`.

**Failure scenario.** The shop starts a recount with `expectedStock = 1`. A new hold changes stock to zero, then expiry of a different hold returns it to one. The stale recount still passes `stock = :expected` and can write a count that includes a unit since set aside.

**Suggested fix.** Add a monotonic inventory version that updates in every reserve, restock or release, and recount. Require the shop to submit the version it loaded before counting. Keep a regression test where stock returns to its original numeric value between read and write.

### Medium · A throttled retry can discard the original reservation ID

**File and line** `backend/template.yaml:47`, `frontend/src/api.ts:80`, `frontend/src/Student.tsx:116`.

**Failure scenario.** A reserve commits but the browser loses the response. The same-ID retry receives a gateway `429`. If the response is visible to the browser, `reserveItem` treats it as terminal and the student screen drops the pending ID. The next user attempt can use a new ID and hold a second unit, or leave the first hold inaccessible in the student's list.

**Suggested fix.** Treat `429` as retryable with bounded backoff and keep the pending ID when retries run out. Remove it only on a definitive application rejection. Test a lost success response followed by throttling and then recovery of the original reservation. **AWS basis:** HTTP API throttling produces `429` responses and clients can resubmit them with rate limiting. [HTTP API throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html)

### Medium · The documented redeploy can restore wildcard CORS

**File and line** `README.md:94`, `README.md:121`, `README.md:126`, `backend/template.yaml:42`.

**Failure scenario.** Guided setup saves `AllowedOrigin="*"` in `samconfig.toml`. The one-off `--parameter-overrides` command locks down the deployed stack, but the saved config still contains the wildcard. The next plain `sam deploy` reuses the saved wildcard and puts it back on the API.

**Suggested fix.** Make the lock-down step update the saved config through `sam deploy --guided` with saved settings, or change `AllowedOrigin` explicitly in the appropriate saved environment before redeploying. Verify preflight from both the actual Amplify origin and an unrelated origin. **AWS basis:** the CLI flag takes precedence for that invocation and the guided flow updates the configuration file. The CLI supplies `UsePreviousValue` for unspecified stack parameters, so the original command does not inherently lose the existing `ShopKey`. [SAM configuration precedence](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-config.html) · [SAM deploy source](https://github.com/aws/aws-sam-cli/blob/develop/samcli/commands/deploy/deploy_context.py)

### Medium · The Amplify instructions stop before activating security headers

**File and line** `README.md:116`, `frontend/amplify-custom-headers.yml:7`.

**Failure scenario.** The operator uploads the zip, saves the headers in Amplify, and proceeds to the phone check. The application still works, but the served deployment has yet to pick up the new CSP and HSTS headers.

**Suggested fix.** After saving headers and substituting the HTTPS API origin, redeploy the manual zip. Verify the CSP and HSTS headers on the deployed `/` response, an allowed API call, and the cache policy for `/` and a hashed asset. **AWS basis:** Amplify explicitly requires a redeploy after editing custom headers, including for manual deployments. [Amplify custom-header deployment](https://docs.aws.amazon.com/amplify/latest/userguide/setting-custom-headers.html)

### Medium · Retention and individually restored tables need an application recovery step

**File and line** `backend/template.yaml:64`, `backend/template.yaml:74`, `backend/template.yaml:94`, `README.md:133`, `README.md:143`.

**Failure scenario.** A stack recreation provisions fresh table names and the Lambda follows those references, while the retained data remains in the old tables. During PITR recovery, restoring just one table can leave an active reservation with stock from before its deduction, or stock already deducted without a matching hold.

**Suggested fix.** Capture table names before deletion. Document restoring both tables to a coordinated recovery point, reconciling stock and holds, and deliberately importing or rebinding the recovered tables and their IAM resources before allowing writes. **AWS basis:** retention preserves the old resource when replaced, PITR restores to a new table, and backup propagation can split changes from a transaction. [DeletionPolicy](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html) · [UpdateReplacePolicy](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-updatereplacepolicy.html) · [DynamoDB restore](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/pointintimerecovery_restores.html) · [Transaction propagation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)

### Low · The documented cost and traffic guarantees are stronger than the configuration

**File and line** `backend/template.yaml:46`, `README.md:132`, `README.md:137`.

**Failure scenario.** A maintainer treats 25 requests per second as a hard aggregate budget or assumes idle retained tables incur no costs. `DefaultRouteSettings` supplies defaults for routes, and API Gateway describes throttling as best effort. PITR is billed separately from request traffic and can continue when the data is retained.

**Suggested fix.** Describe the settings as throttling targets, document the ongoing costs of retained data, and have the operator confirm service eligibility and set a Budget alert. **AWS basis:** SAM defines `DefaultRouteSettings` as defaults for all routes unless overridden. API Gateway describes throttling as a target and DynamoDB documents separate backup billing. [SAM HTTP API defaults](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-resource-httpapi.html) · [HTTP API throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html) · [DynamoDB backup billing](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/backup-restore-billing.html)

## AWS and CI verification

- **Schedule and IAM.** SAM `Schedule` creates an EventBridge rule, whose scheduled payload has `source: aws.events`. An HTTP API v2 JSON body remains inside its request envelope. The transaction members used here are `Put` and `Update`. The underlying `PutItem` and `UpdateItem` permissions on the two table ARNs authorize those members, including their condition expressions. `ConditionCheckItem` is for a separate `ConditionCheck` member. `GetItem` and `Scan` cover the current read paths. [SAM Schedule](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-property-function-schedule.html) · [EventBridge event reference](https://docs.aws.amazon.com/eventbridge/latest/userguide/event-reference.html) · [HTTP API Lambda payload](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html) · [DynamoDB transaction IAM](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)
- **Tables.** The two policies are placed at resource level and PITR sits within each table's properties. AWS documents a 35-day default recovery window. The recovery and billing findings above concern operating those valid settings. [DynamoDB PITR specification](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-dynamodb-table-pointintimerecoveryspecification.html)
- **API and Lambda logs.** The `!Sub` creates the log-group ARN without `:*`, matching AWS's HTTP API access-log example. The format includes `requestId` and uses documented HTTP API variables. The Lambda custom `LogGroup` takes the group name, and the SAM-generated execution role's basic execution policy covers log delivery. The deploying principal also needs the HTTP API logging permissions documented by AWS. [HTTP API logging](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-logging.html) · [Access log variables](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-logging-variables.html) · [Lambda custom log group](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-loggroups.html) · [Lambda basic execution policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AWSLambdaBasicExecutionRole.html)
- **CORS and alarms.** SAM generates an inline HTTP API definition and inserts the `AllowOrigins` configuration. API Gateway handles ordinary preflight and `x-shop-key` is in the allowlist. `5xx` and the `ApiId` + `Stage` dimensions match the HTTP API metrics docs, and SAM defaults to `$default` for an unnamed stage. The SNS topic and alarm action use the same condition. `AWS::NoValue` removes the action property with a blank email. Confirm the email subscription and metric delivery during deployment. [SAM HTTP API](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-resource-httpapi.html) · [HTTP API CORS](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-cors.html) · [HTTP API metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-metrics.html) · [CloudFormation conditions](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/intrinsic-function-reference-conditions.html) · [SNS topic subscriptions](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-sns-topic.html)
- **Frontend and CI.** TypeScript and Vite passed against the Git snapshot in memory. The built HTML loads external same-origin JS and CSS, and the bundle uses the configured HTTPS API origin. The CSP permits those resources when `API_ORIGIN` is replaced. Both YAML files parsed. CI uses the existing npm lockfiles and Python 3.12, which is supported by the pinned `cfn-lint` release. Both Python package pins exist. I found no workflow wiring defect in static review. [Amplify header pattern format](https://docs.aws.amazon.com/amplify/latest/userguide/custom-header-YAML-format.html) · [cfn-lint release](https://pypi.org/project/cfn-lint/1.61.0/) · [SAM translator release](https://pypi.org/project/aws-sam-translator/1.118.0/)

The 16 backend tests passed in memory with DynamoDB command stubs. Five additional observations reproduced the legacy hold, late collect, immediate restock and disappearing notice, swallowed validation cancellation, and recount guard cases. A separate mocked fetch check reproduced the `429` retry stop. Live AWS deployment, CloudWatch delivery, the hosted headers, `cfn-lint`, and a GitHub Actions run remain unverified.
