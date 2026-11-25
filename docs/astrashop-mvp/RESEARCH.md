# Astrashop MVP Research

Sources: the team's NotebookLM notebook (official Techfest brief and the 560-point research guide), extracted on 25 Nov, plus the team's desk research. Re-check quoted figures against the notebook before they go into the submission.

## Overview
Astrashop lets a student find a course item at one campus shop, reserve the exact unit, and pick it up within a stated window. Entry for Techfest IIT Bombay "Campus to Cloud" (AWS), Round 1.

## Problem Statement
The brief asks for a "real, everyday problem" affecting Indian users and a deployed solution that makes their lives "measurably better". Teams choose the domain, stack, AWS services and region; there is no minimum feature count.

Astrashop's problem: students need specific items (drawing sheets, lab record books, calculators, lab coats) before a class, lab or submission deadline, and today they call, message or walk to the shop without knowing whether the item is there. We have to show a student can confirm an item is physically set aside before the trip, with less effort than those channels.

### Evidence so far (desk research, not yet our campus)
- IIT Delhi Board for Student Welfare survey of its SCOOPS stationery shop: 475 of 684 respondents said needed items were sometimes out of stock. One store, fieldwork date unclear: proof the problem exists, not its size.
- SPA Delhi notes architecture and design students need specialised supplies general shops often lack; IIT Delhi's shop lists record books, journal sheets and calculators.
- Existing options: SuperCampus (stationery orders, QR pickup) and Google local inventory listings (same/next-day pickup). Our difference has to be "this exact unit, set aside by the shopkeeper, until a stated pickup time".

## User Stories
- Student: search 10-20 items, see stock and when it was last confirmed, reserve one unit, get a pickup code.
- Student on a flaky network: retry and still hold only one unit.
- Shopkeeper: see held reservations, mark one collected or release it, update shelf stock.

## Technical Research

### What the brief requires on AWS
- A "working prototype on the AWS Free Tier", reachable at a project URL that "stays accessible through Demo Day".
- Judges check that it is live, that it works, and that the AWS services are used well.
- The guide's idea of "working": one real end-to-end user journey with a useful outcome, tested on the deployed URL including invalid inputs and failure states; sample data and simulated integrations labelled as such.
- The guide lists Amplify Hosting or S3 + CloudFront, API Gateway, Lambda, DynamoDB and Cognito as examples to pick from by workflow.
- Credits: up to US$200 AWS Free Tier credits, up to US$30 Builder Center rewards via badges. Check eligibility, credits, region limits; set a budget alert.

### Approach Options
| Option | For | Against |
|---|---|---|
| Amplify Gen 2 full-stack (AppSync + Cognito) | Batteries included | More moving parts to explain; conditional "last unit" logic still needs custom resolvers |
| **API Gateway HTTP API + Lambda + DynamoDB, SAM** | Small, cheap, each service has one clear job; DynamoDB transactions make the last-unit guarantee explicit | We write the routes ourselves |
| EC2/Lightsail + SQL | Familiar | Always-on cost, weaker "uses AWS well" story, must stay up to Demo Day |

### Recommended Approach
- Frontend: React + TypeScript + Vite on Amplify Hosting (manual deploy, no Git integration needed).
- API: API Gateway HTTP API + one Node.js 22 Lambda, deployed with AWS SAM.
- Data: DynamoDB on-demand, tables Items and Reservations.
- Correctness: one `TransactWriteItems` decrements stock (condition `stock >= 1`) and creates the reservation (condition `attribute_not_exists(id)`). The client-generated reservation id makes retries idempotent. This is the AWS story for "Working AWS Build".
- Cognito skipped for the pilot: one shared shop key is enough for one shop.

### Data Requirements
- Item: id, name, course, price, stock (units on shelf, excluding set-aside units), confirmedAt, pickupWindow, sample flag.
- Reservation: id (client UUID), itemId, 6-digit code, status HELD / COLLECTED / RELEASED, createdAt, collectedAt.
- No personal data stored: no names, phones or emails.

## UI/UX Considerations
- Phone-first. Student screen: search, item cards with stock and "confirmed X ago", Reserve, pickup code.
- Shop screen at `#shop`: held list with code and age, Collected / Release, per-item stock confirm.
- Label sample data visibly (the guide asks for this).

## Judging Rubric (same for Rounds 1 and 2; no score bands published)
| Criterion | Weight | Judges assess | What to show (guide advice) |
|---|---|---|---|
| Bharat Impact | 30% | How real the problem is, how well it serves Indian users | Named users, recurring problem, current workaround, measured baseline |
| Working AWS Build | 25% | Live on AWS, works, services used well | Core task on the live URL; what each deployed service does |
| Innovation | 25% | How fresh the idea or approach is | The specific difference and why it matters to the user |
| Demo & Storytelling | 20% | How clearly the team shows who it helps and how | User, problem, benefit in the first 30 seconds, then live workflow and impact evidence |

## Round 1 Submission (one Google Drive folder, submitted by the team leader)
| Item | Required content |
|---|---|
| Live prototype | AWS project URL, live through Demo Day |
| Idea Brief | Problem, who it's for, how it works, impact (format open) |
| Build Summary | Development process; which AWS services and why. Guide: architecture diagram, request flow, per service its feature, data, reason, cost/security/reliability |
| Code repository | Link; public encouraged; README, setup, architecture, placeholder env vars, licence |
| Demo video | Under 3 minutes: problem, who it helps, how it works, impact, wider relevance |

The team leader pastes the folder link into "Submission Link" on techfest.org. Have the AWS Builder Center alias, idea and live URL ready. Give judges Viewer access and test every link signed out.

## Key Dates
| Date | Milestone |
|---|---|
| 25-26 Nov | Interviews and pilot shop; build decision by 26 Nov |
| 27 Nov | Recommended date for AWS Builder Center student verification (SheerID) |
| 30 Nov, 11:59 p.m. IST | Techfest registration closes (gives the Team ID) and Round 1 submission closes. Aim for 6 p.m. |
| By 5 Dec | Round 1 results; top 35 teams advance |
| 17 Dec | Demo Day at IIT Bombay: 3 min live demo + 2 min Q&A; prototype must still be live |

Eligibility: students 18+ enrolled in India, teams of up to four. Builder Center signup and SheerID verification are tied to eligibility to win.

## Validating the Problem (guide method)
1. Short interviews and direct observation: who has the problem, how often, today's workaround and its cost, what better looks like.
2. Evidence log: date, user type, question, observation or quote, decision it changed. Prefer a small, well-documented pilot.
3. Pick one or two metrics before building and record a baseline. For Astrashop: **time to reliable availability confirmation** and **successful pickups before the student's deadline**, with participant and attempt counts.

## Risks and Challenges
- Innovation (25%) is the weakest criterion: a catalogue plus pickup code looks familiar. Lead with the shopkeeper physically setting the unit aside, and with measured results.
- No shopkeeper joins: run a usability test on sample stock and say so.
- Credits or Free Tier expire before 17 Dec: budget alert on day one; everything is pay-per-request.
- Live URL must survive to Demo Day: no expiring dev endpoints, no personal laptop servers.

## Open Questions
- Which shop and which 10-20 items (from the interviews).
- Hold expiry: for now the shopkeeper releases stale holds by hand.
- Repo visibility: public is encouraged; the team decides.

## References
- NotebookLM notebook: https://notebook.google.com/notebook/d8ae5631-dd99-49bb-b397-12150ab579d8
- Official competition page: https://techfest.org/competitions/aws
- DynamoDB transactions: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html
