# Round 1 demo script

Target **2 minutes 45 seconds**, including transitions. Use one student story, one course item, and the live AWS URL. Replace placeholders with what the pilot supports. Keep the shop key off screen.

| Time | Show | Narration cue |
| --- | --- | --- |
| **0:00–0:25** | Student and the exact course requirement | “[STUDENT ALIAS] needed [EXACT ITEM] for [COURSE] by [DEADLINE]. They usually [BASELINE WORKAROUND], which [OBSERVED COST OR OUTCOME]. Astrashop lets them check the campus shop and reserve the exact item for pickup before making the trip.” |
| **0:25–1:00** | Live student catalog | Search for [EXACT ITEM]. Show the stock count, when the shop confirmed it, and the pickup window. Reserve one unit. Show the six-digit code. If the catalog is seeded, point out the **Sample data** label and name this a simulated pickup. |
| **1:00–1:35** | Shop counter and pickup | Show the matching hold on the shop screen, the item set aside, and how the student presents the code. Mark it collected. In the student view, refresh **My reservations** and show the collected status. |
| **1:35–2:00** | Request-flow diagram | “Amplify serves the web app. API Gateway sends requests to Lambda. DynamoDB takes one unit and creates the hold in one transaction. If the connection drops, Astrashop retries with the same ID so the retry won’t deduct a second unit.” |
| **2:00–2:35** | Pilot result with denominators | “We recorded [PARTICIPANT COUNT] students and [ATTEMPT COUNT] attempts. The usual method took [BASELINE TIME] to get a reliable answer. With Astrashop it took [ASTRASHOP TIME]. [BASELINE PICKUPS] of [BASELINE ATTEMPTS] versus [ASTRASHOP PICKUPS] of [ASTRASHOP ATTEMPTS] were collected before the deadline.” Use usability completion instead when using sample stock. State [PILOT LIMITATION]. |
| **2:35–2:45** | Return to the live prototype and project URL | “[EVIDENCE-BACKED BENEFIT FOR THE STUDENT].” |

Before uploading, watch the entire exported video, including title and closing frames. Confirm it runs under three minutes and that text, pickup status, and results are legible on a phone.
