# Campus marketplace implementation plan

## 1. Persistence and API

- [x] Add a DynamoDB repository with bounded queries and conditional transactions.
- [x] Add browse, prefix search, create, edit, close, inbox, messages, and reporting routes.
- [x] Validate lengths, amounts, identifiers, cursors, access, and state changes.
- [x] Verify duplicate submits, concurrent edits, and moderation.

## 2. Browser workflow

- [x] Add the Marketplace tab, category filters, listing form, personal listings, and inbox.
- [x] Add Cognito hosted sign-in and three local demo identities.
- [x] Preserve drafts after recoverable failures. Discard superseded browse and inbox responses.
- [x] Test buyer and seller workflows on narrow screens.

## 3. AWS and operational checks

- [x] Define Cognito, API Gateway, Lambda, DynamoDB, and private ElastiCache Redis in a separate SAM stack.
- [x] Verify bounded queries, transaction behavior, Redis failure responses, and burst handling.
- [x] Run the existing shop checks and document deployment, monitoring, and recovery.
- [ ] Run an AWS staging smoke test before public launch.

## 4. Seller profiles, comments, and reviews

- [x] Add an editable public profile with a display name, programme, and About me section.
- [x] Show sellers on listing cards and add shareable pages for sellers and listings.
- [x] Add item condition, service and favor scope, and availability to the listing form and details.
- [x] Add public comments, seller replies, private seller contact, and saved listings.
- [x] Require both participants to confirm an exchange before the buyer can review it. Close completed item listings in the same write.
- [x] Verify the full local flow in the browser and the data operations with DynamoDB Local.

## 5. Reliability refinement

- [x] Preserve account-bound listing drafts and uncertain publish attempts across navigation.
- [x] Prevent delayed actions from changing a newer screen.
- [x] Make listing edits and status changes safe to retry after a lost response.
- [x] Respect server retry delays and validate collection response shapes before rendering.
- [x] Exercise malformed requests, concurrency, rate limits, service failure, and recovery.
- [x] Verify the shared design at desktop and phone widths.

## 6. Persistent local containers and concurrent flows

- [x] Package the production UI and API in one non-root application image.
- [x] Add a one-command Compose setup with persistent DynamoDB Local and Redis.
- [x] Add macOS and Windows startup files and public runtime settings.
- [x] Provide production configuration for the same image with AWS services and Cognito.
- [x] Stress 24 identities, duplicate actions, invalid requests, competing buyers, and the shop last-unit race.
- [x] Fix volume ownership, cold startup, malformed encoding, network throttling, and dependency error handling.
- [x] Verify Redis and database recovery, app restarts, and persistent exchange and stock data.
- [x] Add the Docker flow and recovery command to CI.

## 7. Distinct buying and selling pages

- [x] Separate buying navigation from listing management and publishing.
- [x] Label buying and selling conversations in the shared inbox.
- [x] Keep account navigation stable across refresh, Back, and Forward.
- [x] Check all page templates and main states in the desktop and mobile browser.
- [x] Fix narrow reservation action overlap and document the page matrix.
