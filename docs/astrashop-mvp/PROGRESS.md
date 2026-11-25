# Astrashop MVP Progress

## Status: Phase 1 done, awaiting ChatGPT audit. Phase 2 handed to ChatGPT. Phase 3 README written.

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
**Status:** Built, awaiting audit

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
**Status:** Handed to ChatGPT

---

### Phase 3: Deploy path and README
**Status:** Written, not verified on AWS

#### Blockers
- No AWS CLI, SAM CLI or credentials on this machine; the team runs the deploy.

---

### Phase 4: Pilot kit and measurement
**Status:** Not Started (ChatGPT, then team)

---

### Phase 5: Submission documents
**Status:** Not Started (ChatGPT, Claude reviews)

---

### Phase 6: Integrate, verify, freeze
**Status:** Not Started (Claude)

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
(after the merge)
