# Astrashop MVP Implementation Plan

## Overview
A student finds an item at one campus shop, reserves the exact unit, and picks it up within a stated window. React + TypeScript + Vite on Amplify Hosting; API Gateway HTTP API + one Node.js Lambda (SAM); DynamoDB with a transactional reserve. See [RESEARCH.md](RESEARCH.md) for why.

## Who does what
Two agents build in parallel and audit each other. Nobody edits a folder they don't own.

| Owner | Branch | Working copy | Owns |
|---|---|---|---|
| Claude Code | `claude/backend` | repo root | `backend/`, `README.md`, `docs/astrashop-mvp/`, `docs/reviews/frontend-review.md` |
| ChatGPT | `chatgpt/frontend` | `.worktrees/chatgpt` | `frontend/`, `docs/submission/`, `docs/pilot/`, `docs/reviews/backend-review.md` |
| Team (humans) | none | none | Interviews, pilot shop, AWS account and deploy, demo video, final submission |

Both branches start from `build/astrashop-mvp`. Claude merges both back into it in Phase 6. Nothing is pushed or merged to `main` without the team's OK.

## API contract (frozen for Phase 2)
Base URL comes from `VITE_API_URL`. All bodies are JSON. Shop routes need header `x-shop-key`.

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| GET | `/items` | | `200 Item[]` | |
| POST | `/reservations` | `{ id: uuid, itemId }` | `201 Reservation` new, `200 Reservation` same id retried | `400` bad input, `409` out of stock, `503` busy (retry with same id) |
| GET | `/reservations/{id}` | | `200 Reservation` | `404` |
| GET | `/shop/reservations` | | `200 Reservation[]` (status HELD, oldest first) | `401` |
| PUT | `/shop/items/{id}` | `{ stock: int >= 0 }` | `200 { id, stock }` | `400`, `401`, `404` |
| POST | `/shop/reservations/{id}/collect` | | `200 { id, status }` | `401`, `409` not on hold |
| POST | `/shop/reservations/{id}/release` | | `200 { id, status }` (stock + 1) | `401`, `404`, `409` not on hold |

```ts
type Item = { id: string; name: string; course?: string; price: number; stock: number;
              confirmedAt: string; pickupWindow: string; sample?: boolean };
type Reservation = { id: string; itemId: string; code: string;
                     status: 'HELD' | 'COLLECTED' | 'RELEASED'; createdAt: string; collectedAt?: string };
```
Error bodies are `{ error: string }`. The client generates the reservation `id` with `crypto.randomUUID()` once per attempt and reuses it on every retry.

## Phase Summary
| # | Phase | Owner | Reviewer | Target |
|---|---|---|---|---|
| 0 | Validate the problem | Team | ChatGPT drafts scripts | 26 Nov |
| 1 | Backend API and data | Claude | ChatGPT audits diff | 25 Nov |
| 2 | Frontend: student and shop screens | ChatGPT | Claude reviews diff | 26 Nov |
| 3 | Deploy path and README | Claude | ChatGPT checks against brief | 26 Nov |
| 4 | Pilot kit and measurement | ChatGPT | Claude | 27 Nov |
| 5 | Submission documents | ChatGPT | Claude checks claims against code | 29 Nov |
| 6 | Integrate, verify, freeze | Claude | Team | 29 Nov |

---

## Phase 0: Validate the problem
### Objective
Decide by 26 Nov whether "reserve a course item for pickup" is the right workflow.
### Tasks
- [ ] ChatGPT: interview script for 5-8 students and a one-page shopkeeper pitch (`docs/pilot/`)
- [ ] Team: run interviews, record item, deadline, what they tried, whether they got it in time
- [ ] Team: find one shopkeeper willing to set items aside
- [ ] Team: register the team; AWS Builder Center student verification (due 27 Nov)
### Success Criteria
At least three recent incidents and one willing shopkeeper. Otherwise pick the workflow the interviews point to before Phase 2 ships.

---

## Phase 1: Backend API and data
### Objective
All seven routes in the contract, with no double hold on the last unit.
### Tasks
- [x] SAM template: HTTP API, one Lambda, Items and Reservations tables, CORS for `x-shop-key`
- [x] Reserve as one transaction: stock decrement (`stock >= 1`) + reservation put (`attribute_not_exists(id)`)
- [x] Idempotent retry by client id; `503` on transaction conflict
- [x] Collect and release guarded on `status = HELD`
- [x] Seed script with 12 items marked `sample: true`
- [x] `node:test` suite with an in-memory DynamoDB fake (8 tests)
- [ ] ChatGPT audit: `docs/reviews/backend-review.md` on its branch
- [ ] Claude fixes confirmed findings
### Success Criteria
`cd backend && npm test` passes; the audit has no open correctness findings.
### Files
`backend/template.yaml`, `backend/src/app.mjs`, `backend/seed.mjs`, `backend/test/app.test.mjs`

---

## Phase 2: Frontend: student and shop screens
### Objective
A phone-friendly page that drives the whole flow against the contract above.
### Tasks
- [ ] Vite + React + TypeScript in `frontend/`, no UI framework, no router (use `#shop` for the shop screen)
- [ ] Student: search 10-20 items; show price, stock, "stock confirmed X ago", pickup window; "Sample data" label when `sample`
- [ ] Student: Reserve. Show the 6-digit pickup code. Retry network errors and 5xx up to 2 times with the same id. Show 409 as "Just sold out"
- [ ] Student: "My reservations" kept in localStorage (wrapped in try/catch), status refreshed from `GET /reservations/{id}`
- [ ] Shop (`#shop`): enter shop key (sessionStorage); list held reservations with code, item name, age; Collected / Release buttons
- [ ] Shop: per-item stock input with "Confirm stock" (PUT); label it "units on shelf, not counting set-aside items"
- [ ] `npm run build` passes (`tsc --noEmit && vite build`)
### Success Criteria
Build passes; Claude's review in `docs/reviews/frontend-review.md` has no open correctness findings.
### Files
`frontend/**`

---

## Phase 3: Deploy path and README
### Objective
Anyone on the team can deploy from a clean Mac in under 15 minutes.
### Tasks
- [ ] README: problem, architecture, API, how the reserve transaction prevents double holds, local tests
- [ ] Exact deploy commands: install AWS CLI + SAM, `sam deploy --guided`, seed, build frontend with `VITE_API_URL`, Amplify manual deploy of `frontend/dist`
- [ ] Billing check and teardown (`sam delete`) notes
### Success Criteria
Team follows README and gets a live HTTPS URL. (Claude cannot verify this: no AWS credentials on this machine.)

---

## Phase 4: Pilot kit and measurement
### Tasks
- [ ] ChatGPT: `docs/pilot/measurement.md`: baseline (call/message/visit) vs Astrashop: time to reliable confirmation, items secured before deadline, participants
- [ ] Team: run the pilot on 28 Nov, fill in the sheet
### Success Criteria
Real numbers, with sample stock labelled as a usability test if no shop joined.

---

## Phase 5: Submission documents
### Tasks
- [ ] ChatGPT: `docs/submission/idea-brief.md` in the format the brief requires
- [ ] ChatGPT: `docs/submission/aws-build-summary.md` (services, why each, the transaction, cost)
- [ ] ChatGPT: `docs/submission/demo-script.md` under 3 minutes: one student, one course requirement, one pickup, measured result
- [ ] Claude: check every technical claim against the code
### Success Criteria
Every required Round 1 item exists; no claim the code doesn't back.

---

## Phase 6: Integrate, verify, freeze
### Tasks
- [ ] Merge `claude/backend` and `chatgpt/frontend` into `build/astrashop-mvp`
- [ ] `npm test` (backend) and `npm run build` (frontend) on the merged tree
- [ ] Update PROGRESS.md; hand the team the deploy and submission checklist
### Success Criteria
Merged branch builds and tests clean. Team decides on merging to `main` and pushing.

## Post-Implementation
- [ ] Demo video recorded, every link opened while signed out (team)
- [ ] Drive folder submitted by 30 Nov 6 p.m. IST (team leader)

## Notes
- Out of scope: payments, delivery, chat, multi-campus, automatic hold expiry (shopkeeper releases stale holds).
- Shop auth is one shared key, fine for one pilot shop; Cognito if more shops join.
