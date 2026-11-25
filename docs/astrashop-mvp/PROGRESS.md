# Astrashop MVP Progress

## Status: Phases 1, 2, 6 done; 3 written (deploy unverified); 0, 4, 5 drafted and waiting on the team's pilot.

## Quick Reference
- Research: `docs/astrashop-mvp/RESEARCH.md`
- Implementation: `docs/astrashop-mvp/IMPLEMENTATION.md`
- Branches: `build/astrashop-mvp` (integration), `claude/backend` (repo root), `chatgpt/frontend` (`.worktrees/chatgpt`)

---

## Phase Progress

### Phase 0: Validate the problem
**Status:** Not Started (team)

#### Blockers
- Needs humans: 5-8 student interviews, one pilot shopkeeper, team registration, AWS Builder Center verification by 27 Nov.

---

### Phase 1: Backend API and data
**Status:** Completed (audited by ChatGPT, fixes applied, 13 tests pass)

#### ChatGPT audit (`docs/reviews/backend-review.md`) and what was done
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
**Status:** Completed (built by ChatGPT, reviewed by Claude: `docs/reviews/frontend-review.md`)

#### Tasks Completed
- Student search, stock and confirmation age, pickup window, sample label, reserve with same-id retry, My reservations
- Shop counter at `#shop`: key, held list, Collected / Release, shelf stock recount
- Review fix at merge: recount sends `expectedStock`; 409 clears the draft and refreshes
- Verified end to end in a browser against the real handler (local stand-in for API Gateway and DynamoDB)

#### Blockers
- ChatGPT's sandbox could not write `.git/worktrees/chatgpt/index.lock`, so Claude committed its four tasks on `chatgpt/frontend` for it.

---

### Phase 3: Deploy path and README
**Status:** Written, not verified on AWS

#### Blockers
- No AWS CLI, SAM CLI or credentials on this machine; the team runs the deploy.

---

### Phase 4: Pilot kit and measurement
**Status:** Kit drafted by ChatGPT (`docs/pilot/`); pilot run is the team's (28 Nov)

---

### Phase 5: Submission documents
**Status:** Drafted by ChatGPT (`docs/submission/`), technical claims checked by Claude; placeholders wait on pilot results and the live URL

---

### Phase 6: Integrate, verify, freeze
**Status:** Completed on `build/astrashop-mvp` (not merged to `main`, not pushed)

#### Tasks Completed
- Merged `claude/backend` and `chatgpt/frontend` with no conflicts
- Backend 13/13 tests, frontend type-check and build pass on the merged tree

---

## Session Log

### 2026-11-25
- Read the ChatGPT "Plan Astrashop Build" chat; NotebookLM needed a Google sign-in and the Chrome extension was not connected, so ChatGPT was asked to extract the notebook's requirements.
- Built and tested the backend; wrote the plan, README and deploy steps.
- Created `build/astrashop-mvp`, `claude/backend`, and the `chatgpt/frontend` worktree.

## Files Changed
- `.gitignore`, `README.md`
- `backend/template.yaml`, `backend/src/app.mjs`, `backend/seed.mjs`, `backend/test/app.test.mjs`, `backend/package.json`
- `docs/astrashop-mvp/IMPLEMENTATION.md`, `docs/astrashop-mvp/PROGRESS.md`

## Architectural Decisions
See Phase 1 decisions. Shop auth is one shared key (`ShopKey` NoEcho parameter), compared with `timingSafeEqual`.

## Lessons Learned
- Cross-review paid off: ChatGPT's audit found two real high-severity bugs (stale read after the transaction, recount overwriting a reservation) that the first test suite could not see because its fake had no read lag.
- Freezing the API contract in the plan let the frontend and backend be built in parallel and merge cleanly; the one contract change was applied at merge, after ChatGPT had finished with its files.
- Give the second agent a working copy whose `.git` it can write, or plan for the first agent to commit for it.
