# Campus marketplace progress

## 26 November 2026

| Phase | Result |
| --- | --- |
| Persistence and API | Implemented listing search and lifecycle, private threads, reports, moderator removal, conditional writes, and input limits. |
| Browser workflow | Verified a paid service listing, title search and filtering, buyer contact, seller reply, edit, and close in Chrome. Verified the layout at 320 and 390 CSS pixels. |
| AWS infrastructure | Prepared the SAM stack, Cognito signup for `adypu.edu.in`, private Redis network, DynamoDB recovery, CI checks, and deployment instructions. The current release stays local. |

All 30 backend tests passed with DynamoDB Local 3.3.2 and Redis 7.2.12. In the Redis test, two clients sent 96 calls to one bucket. It accepted 12 calls at the set capacity and limited the other 84. In a separate test, the production Redis client connected to a temporary TLS cluster with password authentication and the template's Redis permissions. It accepted eight of 24 calls at the set capacity.

The REA runtime check confirmed the marketplace route opened and showed its heading in a fresh browser session. Evidence ID `ev_0a3def81519d36d66b0490588a5a1c5c25d9d0e626327af03541a45c86463f4a`.

See the [implementation plan](IMPLEMENTATION.md) for scope and the [operations guide](OPERATIONS.md) for AWS setup and staging acceptance.

## Seller and listing refinement

The local preview now includes the seller directory, profile editor, About me, shareable listing details, public comments, private messages, saved listings, and exchange-confirmed reviews. Item completion removes the offer from the browse feed and prevents a second completed exchange. Services and favors can accept different buyers.

In Chrome, Neha created a profile and published a service. Ravi opened the details, saved the listing, asked a public question, and sent a private message. Neha replied as the seller. Both confirmed the exchange. Ravi published a review that then appeared on Neha’s public profile after reload. The listing and seller pages fit at 320 CSS pixels without horizontal scrolling.

All 35 backend tests passed with DynamoDB Local and Redis. The frontend build and both AWS templates passed their checks. The preview stays local.

## Reliability refinement

Listing drafts and uncertain save attempts now stay in browser session storage for the account that created them. A retry uses the same request ID and payload. The API records listing edits in the same transaction as their public projections. A replay returns the saved result without overwriting a later edit. New listings require a seller profile at the API boundary.

Delayed contact, listing, and profile actions cannot replace a newer screen. The client rejects private responses after an account change. It respects server retry delays and reports malformed collection responses. Expired API sessions and rejected token refreshes show a sign-in message. The listing draft remains available after sign-in.

New seller profiles use a separate active-offer partition. Older profiles retain bounded queries over their listing history. The public read bucket now allows 600 calls per minute per IP to give students behind a shared campus network more room. Account and write limits remain in place.

The final checks passed 39 backend tests and six client tests. Backend checks included DynamoDB Local and Redis. Redis accepted exactly 12 of 96 concurrent calls at a bucket capacity of 12. The frontend production build and both SAM template checks passed.

A temporary local fault proxy returned an invalid collection and withheld successful publish and edit confirmations. Chrome showed a recoverable error for the collection. Publish and edit retries recovered without duplicate records. An uncertain publish survived leaving and reopening the editor. A two-second contact response did not move the user away from the profile screen. Seller, listing, conversation, profile, supplies, and counter pages fit at 320 CSS pixels without horizontal scrolling. The temporary test services were stopped after verification.

These checks verify local behavior. AWS deployment, hosted Cognito signup, and staging load acceptance remain pending under the local-only instruction.

## Persistent containers and concurrent flow testing

The complete local app now starts with Docker Compose or the platform startup file. One image serves the UI and API. DynamoDB Local and Redis have persistent volumes. Runtime settings let the same application image use managed DynamoDB, Cognito, and TLS Redis. Production mode rejects demo authentication and local database bootstrap.

The separate Docker test project completed all 12 concurrent buyer/seller flows with 24 identities. It processed 1,101 requests in 8.9 seconds, with a local p95 response time of 551 ms. Rate limits produced 114 expected 429 responses. No unexpected failures occurred. Redis and database outages returned controlled 503 responses. Data remained correct after both services recovered and after the app restarted.

See [test results](STRESS-TEST.md) for the workload, fixes, and limits. See [container operations](CONTAINERS.md) for setup and AWS configuration. The app remains local.

The final application image passed 48 backend checks with local DynamoDB and Redis. Seven client tests, the production build, both SAM template checks, and AWS Compose configuration validation passed. Replacing the main image preserved the completed browser listing, its review, private messages, and saved state. Test identities were disabled in the normal app.

## Clearer page sections

Marketplace navigation now has its own bordered panel. Search and category filters share a separate tinted section. Listing and seller cards have individual boundaries and clearer action areas. Saved offers, personal listings, and the inbox have explicit section headings. Shop items and working panels use the same border treatment.

Search, category filters, all six marketplace sections, supplies, and the authenticated counter were checked in the local browser. The pages fit at 320 CSS pixels without horizontal overflow. The frontend build and seven client tests passed. The Docker preview was rebuilt with the new layout.

## Separate buying and selling areas

Buying now contains browsing, sellers, and saved offers. Selling has its own listings page and publish action. Messages show the student's role in each exchange. Account pages keep the same navigation after a refresh or a change of area. Main marketplace pages have stable hash URLs and support Back and Forward.

All page templates and their main populated, empty, guest, and missing-record states were checked in Chrome at desktop and mobile widths. Further checks at 320 pixels found a supplies price overlap with Reserve another. The narrow layout now puts that action below the price. Wider layouts retain their compact row. Error panels, category badges, and the optional profile label also use consistent spacing.

The final build and all seven client tests passed. The Docker preview is running locally with the rebuilt UI. See [responsive UI checks](UI-CHECKS.md) for the page matrix and browser limits.
