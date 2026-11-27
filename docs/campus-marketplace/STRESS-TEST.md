# Local stress test results

## Second pass: attacks, 60 users

Date: 26 November 2026. All traffic stayed local. Run with `STRESS_PAIRS=30 ./scripts/stress-local.sh`.

The load generator now runs 30 buyer/seller pairs (60 users) at the same time as six attack phases on 64 separate identities, after an invalid-input fuzz pass:

- **Ten-click bursts.** Ten identical requests at once for publish, save, contact, reply, comment, save, confirm and review, and for reserve, set aside and collect at the counter.
- **Conflicting tabs.** Six different edits of the same version, five reviews with different ratings, and five different first-time profile names.
- **Close while buying.** The seller closes a service while eight buyers contact, comment and save it.
- **Toggle storm.** Twenty concurrent save/unsave requests.
- **Edit during handover.** The seller edits while both sides confirm, and while the buyer sends messages and comments.
- **Counter races.** Collect and release pressed together, and two simultaneous recounts.
- **Stalled uploads.** 160 clients send headers and then stall the body.
- **Invalid input.** 33 bad listing fields; mass-assignment of owner, status, version and `__proto__`; bad edits, profiles, saves, comments, messages, reports and reviews; bad paths, queries, content types, JSON, tokens, methods and shop inputs; an oversized header.

| Measure | Result |
| --- | ---: |
| Buyer/seller flows completed | 30 of 30 |
| Attack phases passed (plus the fuzz pass) | 7 of 7 |
| HTTP requests | 5,727 |
| Server errors (500) | 0 |
| Expected rate-limit responses (one shared IP) | 3,874 |
| Outage and recovery probes passed | 5 of 5 |

Same-tick repeated clicks in the production bundle (8 on Reserve for the last unit, 8 on Publish) each produced exactly one reservation or listing.

### Breaking points fixed

- **Invisible titles.** A title of three zero-width spaces was accepted and showed as blank. Required text now needs a visible character. Zero-width joiners inside real text, as Indic scripts use them, are still allowed.
- **Stalled uploads locked everyone out.** Each stalled upload held one of the 128 active-request slots for up to 10 seconds, so 160 of them turned normal reads into 503s. Requests now count against the limit only after their body arrives. The request timeout and connection cap still bound slow clients.
- **Double-clicked save reported a false conflict.** If the second copy read the listing just after the first committed, it answered "This listing changed" although the save had gone through. It now replays the committed save.
- **Seller edits refused buyer writes.** A message, comment, contact, save, report or review sent while the seller saved an edit was refused with 409 (100 of 100 in a forced race). These now re-read the listing and retry, and still refuse if the listing was removed or closed.

Each fix has a regression test that fails without it. Backend: 51 tests (49 unit plus 2 integration against DynamoDB Local and Redis).

## First pass

Date: 26 November 2026. All traffic stayed local.

### Workload and results

The Docker test used 24 identities in 12 concurrent buyer/seller pairs. It used the production frontend bundle and API code, DynamoDB Local 3.3.2, and Redis 7.2.12. The app and database each had a one-CPU limit. The load generator ran in a separate container with a one-CPU limit.

| Measure | Result |
| --- | ---: |
| Completed buyer/seller flows | 12 of 12 |
| HTTP requests | 1,101 |
| Workload time | 8.9 seconds |
| Median response | 286 ms |
| p95 response | 551 ms |
| Maximum response | 1,068 ms |
| Expected rate-limit responses | 114 |
| Unexpected failures | 0 |

These measurements include the read burst and expected invalid requests. They are local results, not an AWS capacity or latency commitment. Timing varies with host load.

The final image also passed all 48 backend tests with real local DynamoDB and Redis connections. These included offline signed Cognito token checks. All seven client tests, the frontend build, and both SAM template checks passed. The AWS Compose example passed configuration validation without starting AWS services.

Each pair created profiles, submitted a listing twice, retried an edit, checked ownership, opened a private conversation twice, sent a duplicate reply, posted a public comment, saved an offer, confirmed an exchange, and submitted a review twice. Items closed after completion. Services and favors remained reusable until the seller closed them.

A separate item had six interested buyers. All six confirmed from their side. Concurrent seller confirmations completed exactly one handover. The other buyers received a conflict. The shop test also raced 16 reservations for the last unit, retried the winning reservation, set it aside, collected it, and verified that duplicate releases could not add stock twice.

The invalid-input checks covered malformed JSON, null, arrays, strings, numbers, negative amounts, oversized bodies, invalid identifiers, invalid cursors, missing authentication, and unsupported methods. HTTP regression tests also covered invalid UTF-8, invalid percent encoding, chunked oversized bodies, long URLs, spoofed source-IP headers, CORS, and bounded active requests.

### Breaking points fixed

- The first DynamoDB volume had root ownership. A one-time initializer now gives the pinned image's database user access before startup.
- A cold JVM could start after the API's first connection attempt. Startup now waits for a database response and has a longer health-check grace period.
- Invalid UTF-8 could leave an HTTP request waiting. It now receives 400.
- A shared IP limit of 60 writes per minute made the first concurrent run take 237.1 seconds. Marketplace now permits 300 network writes per minute while retaining the 24-write account limit and six-publish limit. A network rejection no longer spends account or publish credit.
- Database socket failures returned 500. Shop and marketplace now return 503 with a retry delay for connection and service failures.

### Recovery and persistence

Redis and DynamoDB were stopped separately in the disposable test stack. During each outage, liveness stayed at 200. Readiness, shop reads, and marketplace reads returned 503. Both services recovered without replacing the API process. Stock, two completed item handovers, and the seller's single review remained correct. An app restart preserved the same data.

In Chrome, separate Asha and Ravi tabs completed the full item flow. Negative prices were rejected. Double-clicks on publish, save, comment, contact, reply, completion, and review produced the expected final state. All marketplace sections, supplies, and the authenticated counter fit at 320 CSS pixels with the same shared typography and controls.

Run `./scripts/stress-local.sh` to reproduce the workload and recovery checks. The script writes fresh JSON reports under `artifacts/`. CI runs this same command and retains those reports. AWS staging load and hosted signup remain untested.
