# Astrashop frontend and docs review

Reviewed by Claude Code: `build/astrashop-mvp...chatgpt/frontend` (commits `bba8c9b`..`c916303`), then the merged tree.

## Verification
- `tsc --noEmit && vite build` passes on the merged tree.
- End to end in a browser against the real Lambda handler (local HTTP API stand-in, in-memory tables): reserve the last unit → pickup code shown, card flips to out of stock → shop unlocks with key, sees the hold → stale recount rejected and the field refreshes to the true count → Collected → student screen shows Collected. Only console error: the expected 409.
- Not verified: the deployed AWS stack, CORS preflight from the Amplify origin, real phones.

## Findings
| File | Severity | Issue | Status |
|---|---|---|---|
| `frontend/src/Shop.tsx`, `frontend/src/api.ts` | High | Stock recount sent only `{ stock }`. After the backend review, the contract requires `expectedStock` so a recount made before a reservation landed can't re-offer a set-aside unit. | Fixed at merge: the count the shopkeeper started from is captured on first edit and sent as `expectedStock`; on 409 the draft is cleared and the catalog refreshed. |
| `docs/submission/aws-build-summary.md` | Low | Didn't mention the recount guard or `503` retry behaviour added after the backend review. | Fixed at merge. |
| `frontend/src/Student.tsx` | Nit | The "is held" success banner stays after the hold is collected, until the next action. | Open, cosmetic. |
| `frontend/src/Shop.tsx` | Nit | Held list doesn't refresh after a 409 on stock; the shopkeeper taps Refresh holds. | Open, cosmetic. |

## What's good
- Reservation id generated once per attempt and reused on retry; retries only on network errors and 5xx, with backoff; pending attempts survive reloads in localStorage, wrapped in try/catch.
- 409 on reserve shows "Just sold out" and refreshes stock; 401 on the shop screen locks the counter.
- Sample data labelled on every card; labels and `aria` attributes on controls; no UI library, no router, as planned.
- Submission and pilot drafts use placeholders (`[PILOT RESULT]` etc.) instead of invented numbers, and the build summary matches the code.
