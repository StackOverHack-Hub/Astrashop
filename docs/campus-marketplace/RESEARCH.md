# Campus marketplace research

Students need a place to offer spare supplies, paid services, and free help to other students. Buyers need to find an offer and contact its owner without sharing their email address. The existing campus shop keeps its stock and pickup workflow.

Meta documents a browse, filter, listing detail, seller message, and handover flow. That flow informs the marketplace navigation. AstraShop uses its own layout and terms and adds categories for items, services, and favors. A signed-out Marketplace request reached a login screen. The REA capture reached its navigation deadline before it could inspect that page. The public documentation describes the seller flow. [Meta’s Marketplace introduction](https://about.fb.com/news/2016/10/introducing-marketplace-buy-and-sell-with-your-local-community/)

## Architecture

| Decision | Rationale |
| --- | --- |
| Separate API and AWS stack | Deploy and roll back the marketplace independently of shop inventory. |
| Cognito managed login and API Gateway JWT authorization | Require verified email for writes and private reads. Use authorization code and PKCE for the browser. Limit signup to the configured campus email domain. |
| DynamoDB on demand with point-in-time recovery | Use transactions for listing state, public projections, inbox entries, and retries. Use bounded key queries for every collection. |
| Redis OSS on Amazon ElastiCache Serverless | Enforce shared limits across Lambda instances. Use an atomic Lua token bucket. Return 503 if the limiter is unavailable. |
| Text listings and private threads | Support the sale and handover flow with a category, title, description, amount, campus meetup area, and private messages. Free listings use a zero amount. |

DynamoDB reuses the project’s existing operational model. PostgreSQL would make full-text search and cross-campus queries simpler. Those workloads would add a new database and migrations. The initial scope uses title-prefix search and sort keys. Monitor capacity by category before introducing feed shards or a search service. [DynamoDB query reference](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html)

API Gateway throttles aggregate traffic. Redis limits browse requests by source IP and sensitive actions by both source IP and account. DynamoDB remains the source of record. Keep Redis inside the VPC with TLS and restrict its security group to the marketplace Lambda. Attach a DynamoDB gateway endpoint to the private route tables. [Lambda and ElastiCache](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/LambdaRedis.html) · [HTTP API JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)

## Scope

Students can post, edit, close, find, contact, reply to, and report listings. Only the listing owner can edit it. Only thread participants can read or send messages. Moderators can review reports and remove listings. The app arranges a handover. It collects no payment and exposes no email address in marketplace responses. Photo storage and shipping are outside the scope.

## Seller identity, listing discussion, and reputation

| Pattern | AstraShop design |
| --- | --- |
| Feedback profiles link to seller information, messaging, and other offers. | Show the seller on each card. Give sellers a shareable profile with an About me section, their active offers, and public feedback. [eBay feedback profiles](https://www.ebay.com/help/Account/Settings/Feedback_profiles?id=4204) |
| Service listings describe scope, delivery, and what the buyer must provide. | Keep a full description for every offer. Add condition for items, scope for services and favors, and optional availability. [Upwork Project Catalog](https://support.upwork.com/hc/en-us/articles/360057397533-How-to-create-a-project-in-Project-Catalog) |
| Public listing comments and private discussion serve different purposes. | Use a public question-and-answer list for common questions. Use the private inbox to arrange times and locations. [Poshmark listing comments](https://blog.poshmark.com/2014/10/09/sellers-what-make-an-offer-means-for-you-faqs/amp/) · [Etsy seller messaging](https://help.etsy.com/hc/en-us/articles/115013328428-How-to-Contact-a-Shop) |
| A reputation score carries more weight when tied to an exchange. | Both participants confirm completion in the private conversation. The buyer can then leave one review. Label it **Exchange confirmed** because payment and delivery occur outside AstraShop. [Etsy reviews](https://www.etsy.com/legal/buyers/) · [eBay seller ratings](https://www.ebay.com/help/Buying/Working_With_Sellers/Seller_ratings?id=4023) |
| Saved offers help people return after comparing them. | Add private, account-bound saves. A saved listing reflects its current title and availability. [Meta Marketplace overview](https://about.fb.com/news/2016/10/introducing-marketplace-buy-and-sell-with-your-local-community/amp/) |

Use the existing DynamoDB table. Public profile IDs differ from account identifiers. Read seller names with bounded batch loads, so a display name change takes effect across the marketplace. Store each review and update the seller totals in one transaction. Keep each completion flag and review private until its author publishes the review. [DynamoDB BatchGetItem](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchGetItem.html)

## Failure and retry design

DynamoDB transactions apply their writes together. Its optional client token covers a ten-minute retry window. AstraShop also stores an edit receipt in the transaction so a browser can resume an uncertain save across navigation. Receipts use an account-scoped request ID, a payload fingerprint, and a seven-day TTL. These receipts are an application design choice. [DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)

API Gateway throttles are best-effort targets. Redis supplies the shared application buckets across Lambda instances. The browser respects the API's retry delay and keeps uncertain writes tied to their original payload. The public read limit allows for multiple students behind one campus IP. Actual campus traffic and AWS latency still require staging measurement. [HTTP API throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html)
