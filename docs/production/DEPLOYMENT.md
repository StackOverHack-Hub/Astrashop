# AWS pilot deployment

Deployed on 28 November 2026 at 12:26 IST. The frontend release is commit `181c9ad5eb9cce7c5fa9edb4e4974d294f4929e1`. Amplify job `1` completed successfully. Both CloudFormation stacks reached `CREATE_COMPLETE`.

| Setting | Value |
| --- | --- |
| Live site | https://main.d122punxfnd0ue.amplifyapp.com/ |
| AWS region | Sydney, `ap-southeast-2` |
| Amplify app | `d122punxfnd0ue`, branch `main` |
| Shop stack | `astrashop-prod` |
| Marketplace stack | `astrashop-marketplace-prod` |
| Shop API | https://quedl6qev0.execute-api.ap-southeast-2.amazonaws.com |
| Marketplace API | https://oc1w0k83gi.execute-api.ap-southeast-2.amazonaws.com |
| Item photos | https://dvjteenhzn5hx.cloudfront.net |
| Campus email domain | `adypu.edu.in` |

The AWS organization policy refused access in Mumbai. This deployment uses the permitted Sydney region.

## Services and data

Amplify hosts the static frontend over HTTPS. API Gateway and Node.js 22 Lambda functions serve the shop and marketplace APIs. Cognito provides campus sign-in.

All application records are stored in four DynamoDB tables: items, reservations, tenancy, and marketplace. The tables use on-demand capacity and point-in-time recovery. CloudFormation retains the tables if a stack is deleted.

The rate limiter uses ElastiCache Serverless for Valkey 8 in private subnets. It uses the existing Redis protocol and token-bucket script. This option has a lower minimum storage charge than Redis OSS Serverless. S3 stores item photos in a private bucket. CloudFront reads the bucket through origin access control.

The site has 12 labeled sample items. These are not inventory from a real shop. The marketplace starts empty. Demo authentication and the shared counter key are disabled. Razorpay webhooks remain disabled until a webhook secret is configured.

AWS credits cover eligible usage while they remain available. This deployment includes services that can incur charges. Check actual costs and the credit balance in AWS Billing.

## Verification

- Backend: 89 tests passed. Three tests that need local services were skipped.
- Client: all eight tests passed. The production frontend build passed locally and in CloudShell.
- Both SAM templates passed `sam validate --lint` in AWS CloudShell.
- The live catalog, shop list, and marketplace API returned HTTP 200.
- The two private account routes returned HTTP 401 without a token.
- Both APIs allowed the exact frontend origin. Neither API allowed `https://example.com` in CORS.
- The site returned HTTP 200 with CSP, HSTS, and `nosniff` headers. The CSP includes the deployed API, Cognito, and photo origins.
- A browser loaded all 12 items, an item detail page, and the empty marketplace. Reserving while signed out opened the Cognito sign-in page with the correct callback URL and PKCE parameters.
- A manual invocation of the expiry sweep returned HTTP 200 without a Lambda function error.
- CloudWatch received the `Astrashop/SweepRun` metric with a count of 1. This confirms that embedded metrics are extracted from the deployed Lambda logs.

A complete campus sign-in and an authenticated reservation have not been verified with a real account. The requested initial administrator account was created and its `PlatformAdmins` membership was verified. Cognito sent an email invitation. The account is in `FORCE_CHANGE_PASSWORD` until its owner completes the first sign-in. Email verification was not bypassed. No shop owner has been assigned. Phone photo uploads and Razorpay test events have not been checked on this deployment.

## Deploy again

Use Node.js 22 in AWS CloudShell. Pull `main`, then run:

```bash
ASTRASHOP_REGION=ap-southeast-2 bash scripts/deploy-aws.sh
```

The script reuses the Amplify app by name and the two stack names. It preserves existing catalog records when it seeds sample data. It saves public settings and stack outputs under `artifacts/` in CloudShell. It starts an Amplify deployment; check the returned job status before announcing the release.

The GitHub repository is not connected to Amplify for automatic builds. A Git push alone does not update this site. Run the deployment script to publish a new release.
