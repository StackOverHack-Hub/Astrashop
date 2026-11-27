# Local containers and AWS configuration

## Start and stop

Install Docker Desktop. From the project folder, run:

```bash
docker compose up --build --wait --wait-timeout 180
```

Open [localhost:8080](http://localhost:8080). On macOS, `start.command` starts Docker Desktop if needed, starts the services, and opens the site. On Windows, start Docker Desktop and use `start.cmd`.

The setup contains one application image, DynamoDB Local, Redis, and a short volume initialization job. The application image serves the production frontend bundle and the HTTP API. Only the application port is published, on loopback. Database and cache ports stay inside Docker.

The app creates three local tables. Sample inserts use conditions so a restart cannot replace a profile, reset stock, reopen an item, or remove a review. DynamoDB and Redis use named volumes. `docker compose down` stops the services and keeps those volumes. `docker compose up --wait` starts them again. Avoid `down --volumes` for the normal app unless you intend to erase its local data.

Copy `.env.example` to `.env` if you need a different port, counter key, or hold duration. Start scripts read the actual published port, including a port set in `.env`.

The application runs as the image's `node` user with a read-only root filesystem. Its temporary directory is writable. The initializer has only the permission needed to set the database volume owner. The app waits for actual database responses during a cold start. Compose uses readiness checks for startup. [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/)

## Check behavior

Run the full local test from the project folder:

```bash
./scripts/stress-local.sh
```

Only Docker and a POSIX shell are required. The script builds the image and creates a separate test project with fresh volumes and 64 local test identities. A separate load generator runs 12 concurrent buyer/seller pairs. The script then stops and restores Redis, stops and restores DynamoDB, and restarts the app. It checks persisted stock, completed exchanges, and review totals after recovery. It removes only its own containers and volumes on exit.

Reports are saved in `artifacts/stress-report.json` and `artifacts/recovery-*.json`. `STRESS_PAIRS=20 ./scripts/stress-local.sh` increases the number of pairs. The maximum is 30. The default uses a random loopback port. Set `STRESS_PORT` only if you need a fixed test port. All load targets must be loopback addresses. The normal Compose setup has no stress identities.

Use `docker compose logs --tail 100 app` to inspect API logs. `/health/live` checks the process. `/health/ready` checks all four tables and Redis. A dependency outage returns 503 with a retry delay. It does not terminate the API process. A restored dependency can return the same process to ready status.

## Reuse the image on AWS

The image uses runtime configuration. No frontend rebuild is needed to change from local demo accounts to Cognito. `/config.js` exposes only the API paths, Cognito login origin, client ID, and demo-mode flag. Counter keys, Redis credentials, and AWS credentials never enter that file.

`compose.aws.yaml` is a separate runtime example for existing AWS resources. It provisions nothing. Copy `.env.aws.example` to `.env.aws` and fill in the public resource settings and secret file paths. The required settings are:

| Setting | Purpose |
| --- | --- |
| `APP_ENV=production`, `AUTH_MODE=cognito` | Disable demo accounts and local bootstrap. |
| `AWS_REGION` | Region used by the AWS SDK. |
| `ITEMS_TABLE`, `RESERVATIONS_TABLE`, `TENANCY_TABLE`, `MARKETPLACE_TABLE` | Existing DynamoDB tables from the SAM stack outputs. Run `backend/migrate-tenancy.mjs` once after upgrading from the single-shop version. |
| `PHOTO_BUCKET`, `PHOTO_BASE_URL` | Optional item photos: the shop stack's `PhotoBucketName` and `PhotoBaseUrl` outputs. The task role needs `s3:PutObject` on `items/*`. Leave both unset to turn photo upload off. Locally, photos go to the `photo-data` volume and are served at `/photos/`. |
| `RAZORPAY_WEBHOOK_SECRET` (or `_FILE`) | Optional Razorpay webhook secret for `POST /api/billing/razorpay`. Unset returns `501`. |
| `DEFAULT_SHOP_ID` | The shop that owns pilot data and that the counter key opens. Defaults to `campus-shop`. |
| `REDIS_HOST`, `REDIS_PORT` | Reachable private ElastiCache endpoint. |
| `REDIS_TLS=true`, `REDIS_CLUSTER` | TLS and the cache's cluster mode. |
| `REDIS_PASSWORD_FILE`, `SHOP_KEY_FILE` | Secret files. ECS can inject the equivalent secret environment values. The shop key is optional: without it, staff open the counter only with their accounts. |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_LOGIN_ORIGIN` | Existing student pool, public app client, and managed login origin. |
| `ALLOWED_ORIGIN` | Exact HTTPS site origin, also registered as the Cognito callback and logout origin. |
| `TRUST_PROXY_HOPS` | Keep zero unless a trusted proxy is the only allowed network caller. |

Production mode rejects demo authentication, a local DynamoDB endpoint, unencrypted Redis, and a short counter key. It never creates tables or seeds sample data. Cognito verification checks the signature, issuer, expiry, client ID, access-token type, and marketplace scope. Signed-token tests verify this locally without contacting AWS. [AWS JWT verifier](https://github.com/awslabs/aws-jwt-verify)

For ECS, push this image to your ECR repository and run it behind an HTTPS load balancer. Set port 8080 as the target port and `/health/ready` as the health path. Use a task role for DynamoDB access and Secrets Manager references for secrets. Give the task access to the three tables, the private cache, and the Cognito public signing-key endpoint. The task needs outbound access for signing-key retrieval. Keep database and cache access inside the VPC. Restrict application ingress to the load balancer before setting `TRUST_PROXY_HOPS=1`.

The verified local image is `linux/arm64`. Use an ARM64 ECS task, or build `linux/amd64` with Buildx for an x86 task. Pin the image digest when promoting it between environments. The existing Lambda SAM deployment remains available and shares the same marketplace and shop handlers.

No AWS resources were deployed for these checks. Hosted signup, VPC access, secret injection, load-balancer routing, and AWS load acceptance still require staging verification.
