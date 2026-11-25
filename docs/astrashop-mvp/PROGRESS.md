# Astrashop MVP Progress

## Status: Phases 1, 2, 6 done; 3 written (deploy unverified); 0, 4, 5 drafted and waiting on the team's pilot.

## Quick Reference
- Research: `docs/astrashop-mvp/RESEARCH.md`
- Implementation: `docs/astrashop-mvp/IMPLEMENTATION.md`
- Branches: `build/astrashop-mvp` (integration), `backend` (repo root), `frontend` (`.worktrees/frontend`)

---

## Phase Progress

### Phase 0: Validate the problem
**Status:** Not Started (team)

#### Blockers
- Needs humans: 5-8 student interviews, one pilot shopkeeper, team registration, AWS Builder Center verification by 27 Nov.

---

### Phase 1: Backend API and data
**Status:** Completed (audited by the frontend dev, fixes applied, 13 tests pass)

#### Audit (`docs/reviews/backend-review.md`) and what was done
| Finding | Verdict | Action |
|---|---|---|
| Eventually consistent read after the reserve transaction can miss a committed hold | Fixed | `ConsistentRead: true` on reservation reads; fake now hides fresh rows from non-consistent reads |
| Stock recount can overwrite a concurrent reservation | Fixed | `PUT` requires `expectedStock`, conditioned `stock = :expected`, `409` if stale (contract change) |
| Throttle/conflict reported as sold out or not on hold | Fixed | Classify by cancellation reason; `503` for transient errors on every route; unexpected errors logged |
| Oversized keys, non-UUID paths, unsafe integers reach DynamoDB | Fixed | Item id ≤ 128 chars, UUID path check, `Number.isSafeInteger`, stock ≤ 100000 |
| Scan pages hide held reservations | Fixed | `scanAll` follows `LastEvaluatedKey`; paged-scan test |
| Duplicate pickup codes on the same item | Accepted | Two holds on the same item with one code are interchangeable at the counter; shortcut comment in code |
| Seed re-run resets live stock | Fixed | Conditional puts skip existing items |
| Runtime SDK version differs from tested SDK | Accepted | Node.js 22 runtime ships SDK v3; bundle only if a runtime update breaks something |

Mutation check: removing `ConsistentRead` fails 5 tests; removing the recount condition fails 2.

#### Tasks Completed
- SAM template, one Lambda, two on-demand DynamoDB tables
- Transactional reserve, idempotent retry, HELD-guarded collect/release
- Seed script (12 sample items), 8 passing `node:test` tests

#### Decisions Made
- One Lambda routed by `event.routeKey` instead of one function per route: one file, one deploy unit.
- On a cancelled reserve transaction, look the reservation up by id instead of trusting `CancellationReasons` ordering. A retry is then always recognised, even if DynamoDB reports only the stock condition.
- No DynamoDB TTL for hold expiry: TTL deletes the row without returning the unit to stock.
- AWS SDK v3 is a devDependency only; the Lambda Node.js 22 runtime ships it.

---

### Phase 2: Frontend
**Status:** Completed (built by the frontend dev, reviewed by the backend dev: `docs/reviews/frontend-review.md`)

#### Tasks Completed
- Student search, stock and confirmation age, pickup window, sample label, reserve with same-id retry, My reservations
- Shop counter at `#shop`: key, held list, Collected / Release, shelf stock recount
- Pickup passes show when the shop has set a unit aside. The counter checks pickup codes and has separate Pickups, Shelf count, and Pilot numbers sections.
- Pilot numbers summarize reservation outcomes and elapsed time since reservations were placed. The pilot sheet captures attempt starts, deadlines, and baseline outcomes.
- Review fix at merge: recount sends `expectedStock`; 409 clears the draft and refreshes
- Verified end to end in a browser against the real handler (local stand-in for API Gateway and DynamoDB)

#### Blockers
- The frontend working copy could not write to the repo's `.git`, so its four tasks were committed from the main checkout on `frontend`.

---

### Phase 3: Deploy path and README
**Status:** Written, not verified on AWS

#### Blockers
- No AWS CLI, SAM CLI or credentials on this machine; the team runs the deploy.

---

### Phase 4: Pilot kit and measurement
**Status:** Kit drafted by the frontend dev (`docs/pilot/`); pilot run is the team's (28 Nov)

---

### Phase 5: Submission documents
**Status:** Drafted by the frontend dev (`docs/submission/`), technical claims checked by the backend dev; placeholders wait on pilot results and the live URL

---

### Phase 6: Integrate, verify, freeze
**Status:** Completed on `build/astrashop-mvp` (not merged to `main`, not pushed)

#### Tasks Completed
- Merged `backend` and `frontend` with no conflicts
- Backend 13/13 tests, frontend type-check and build pass on the merged tree
- Later merged to `main` and pushed to `StackOverHack-Hub/Astrashop` (25 Nov)

---

### Phase 7: Production hardening
**Status:** Completed on `hardening/production` (deploy not verified: no AWS credentials here)

#### Audit (`docs/reviews/hardening-review.md`) and what was done
| Finding | Verdict | Action |
|---|---|---|
| Expired unit's return notice vanishes after 24 h / no record of acting on it | Fixed | Listed until the shopkeeper taps Back on shelf (`POST .../returned`, stamps `returnedAt`). Stock stays restored at expiry: a recount made before the unit goes back undercounts, and the next recount fixes it. Restocking only on acknowledgement would double count if the shopkeeper recounts first and acknowledges later. |
| Pre-upgrade holds without `expiresAt` never expire | Fixed | Deadline falls back to `createdAt + HoldMinutes`; test |
| Collect allowed between deadline and next sweep | Accepted | ≤10-minute grace for late students, no double-sell possible (collect and expiry are both HELD-guarded); documented |
| Sweep swallows non-benign cancellations | Fixed | Benign / deferred / failed classification; failures logged with ids and fail the run → `FunctionErrorsAlarm`; test with `ValidationError` |
| Unbounded scans in sweep and shop list | Accepted | Pilot scale (one shop); shortcut comments name the GSI upgrade |
| Reserve + expiry ABA passes the numeric recount guard | Accepted | Under "expiry restocks" semantics the net-zero case leaves stock equal to sellable units; version counter if more write paths appear |
| Throttled (429) retry drops the reservation id | Fixed | 429 retried with backoff and keeps the pending id |
| Redeploy restores wildcard CORS from samconfig | Fixed | Lock-down uses `--save-params`; preflight check from a foreign origin documented |
| Amplify headers need a redeploy | Fixed | Re-upload step plus `curl -sI` check |
| Retained/restored tables need a recovery procedure | Fixed | Restore runbook in README |
| Throttling and cost wording too strong | Fixed | "Targets", PITR/log storage cost, Budget alert |
| (Backend dev) `AllowedOrigin` typo like a trailing slash silently breaks CORS | Fixed | `AllowedPattern` on the parameter |

#### Decisions Made
- Hold expiry by schedule, not DynamoDB TTL: TTL deletes rows without returning stock and runs up to 48 h late.
- No Lambda reserved concurrency: new accounts often have a concurrency quota of 10, which makes any reservation fail to deploy. API stage throttling caps traffic instead.
- No per-route throttles: SAM route settings can race route creation on first deploy; one stage-wide limit is enough at pilot scale.
- No WAF: HTTP APIs can't attach it; documented as the upgrade path with Cognito for shop logins.
- Expired holds stay on the shop list until the shop confirms they are back on the shelf. This gives staff a reminder before the next recount.
- Alarm on API 5xx, not only Lambda Errors: the handler turns caught failures into 500/503 responses, which Lambda doesn't count as errors.

---

## Session Log

### 2026-11-25
- Read the team's planning notes and extracted the brief's requirements from the NotebookLM notebook.
- Built and tested the backend; wrote the plan, README and deploy steps.
- Created `build/astrashop-mvp`, `backend`, and the `frontend` worktree.

## Files Changed
- `.gitignore`, `README.md`
- `backend/template.yaml`, `backend/src/app.mjs`, `backend/seed.mjs`, `backend/test/app.test.mjs`, `backend/package.json`
- `docs/astrashop-mvp/IMPLEMENTATION.md`, `docs/astrashop-mvp/PROGRESS.md`

## Architectural Decisions
See Phase 1 decisions. Shop auth is one shared key (`ShopKey` NoEcho parameter), compared with `timingSafeEqual`.

## Lessons Learned
- Cross-review paid off: The frontend dev's audit found two real high-severity bugs (stale read after the transaction, recount overwriting a reservation) that the first test suite could not see because its fake had no read lag.
- Freezing the API contract in the plan let the frontend and backend be built in parallel and merge cleanly; the one contract change was applied at merge, after the frontend dev had finished with those files.
- Give a second working copy write access to the repo's `.git`, or plan to commit its work from the main checkout.
