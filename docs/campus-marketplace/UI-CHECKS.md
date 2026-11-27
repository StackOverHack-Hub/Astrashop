# Responsive UI checks

Date: 26 November 2026. Target: the local Docker app at `http://localhost:8080`.

## Changes

Buying and Selling now have separate navigation buttons, clear selected states, and descriptions on desktop. Buying contains Browse, Sellers, and Saved offers. Selling contains My listings and the Post a listing action. The inbox labels each conversation with the student's buying or selling role. Listing status badges distinguish active offers from completed exchanges.

Inbox and My profile use a shared account navigation bar. This bar stays the same after a refresh and when opened from either area. Each main page has its own hash URL. Navigation returns the page to the top.

All pages use the same type, controls, panel borders, card spacing, and section headings. Missing seller and listing pages now use the same error panel treatment. The Programme label keeps Optional on the same line. Listing category badges keep their natural width.

At 320 CSS pixels, Reserve another overlapped the supplies price. A narrow-screen rule now puts the price and button on separate rows. At 390 and 1440 pixels, they keep the compact row with a 16-pixel gap.

## Browser coverage

Checks used Chrome with viewport overrides of 1440 × 900 and 390 × 844. Further checks used 320 × 800. The final card regression check at 390 pixels used a height of 900 pixels. The browser returned to its normal viewport after testing.

Each row below was checked at both 1440 and 390 CSS pixels. Checks included visible layout, heading hierarchy, control spacing, navigation, and horizontal overflow.

| Page or flow | States checked |
| --- | --- |
| Buying | Guest and signed-in browse; all categories; title search; results; empty results; Clear |
| Seller directory | Seller cards and links to public profiles |
| Public seller | Profile with reviews; profile without reviews; active offers |
| Listing details | Item, service, favor, and completed item; public questions and seller reply |
| Listing actions | Contact seller form and report form |
| Saved offers | Populated list and empty list |
| Selling | Active listings; active and completed listings; status and edit actions |
| Listing editor | New item, service, and favor; existing service; completed item |
| Profile | Create and edit; profile prerequisite before publishing |
| Inbox | Empty and populated; buying and selling role labels |
| Conversation | Buyer and seller; pending exchange; completed exchange; review form and published review |
| Sign-in gates | Guest Selling, Saved offers, Inbox, and My profile |
| Missing records | Listing unavailable and Seller unavailable panels with retry controls |
| Find supplies | Catalog, search, empty search, and reservation action |
| Pickup passes | Reserved, set aside, and collected |
| Shop counter | Locked and unlocked; pickups, shelf count, and pilot numbers |

The 320-pixel checks covered Buying, the seller directory, service details, Saved offers, Selling, the new listing form, profile editing, a seller conversation, supplies, and the unlocked counter. No horizontal viewport overflow or off-screen primary controls remained in these checks. The supplies price and reservation button were also checked for overlap, since a viewport overflow check alone did not detect the original problem.

There were 118 recorded browser observations: 56 at 1440 pixels, 48 at 390 pixels, 13 at 320 pixels, and one at the restored normal desktop width. These include repeated observations after fixes.

## Navigation and local behavior

- Selling kept its selected state and content after reload.
- Back and Forward restored the previous marketplace page.
- Contact seller opened the resulting conversation in Inbox.
- Inbox and My profile kept the same navigation when opened from Buying or Selling and after reload.
- Switching pages returned the scroll position to the top.
- Local buyer and seller messages, completed exchanges, reviews, and saved offers remained available after the application image changed.
- The final preview interruption came from a clean stop of all three runtime containers. The stack was started again. The final browser reload showed Buying and its offers without an error notice.

These were local Chrome checks with sample accounts and stock. They did not test physical mobile devices, other browser engines, hosted Cognito pages, or an AWS deployment. The report form was inspected without submitting a report.

## Build checks

The final TypeScript check, production frontend build, and all seven client tests passed. The local Docker image was rebuilt and started with Compose health checks. Backend behavior was unchanged by this UI refinement. See [stress test results](STRESS-TEST.md) for the earlier concurrent buyer and seller checks.
