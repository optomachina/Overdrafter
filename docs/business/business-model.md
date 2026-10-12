# OverDrafter Business Model

Approved by Blaine on October 11, 2026. Source: the pricing council synthesis
(pricing council synthesis FINAL ANSWER, October 11, 2026) with Blaine's
overrides applied. Prices below are **locked** for Alpha and the scoped Beta.

Stripe catalog work on OVD-725 / [PR #671](https://github.com/optomachina/Overdrafter/pull/671)
must match this document (including Jarvis free with a $10 per seat model
usage cap). Billing stays disabled until pre charge conditions are met and
1.0 is certified (OVD-199, OVD-319). A live charge still needs separate
explicit approval (OVD-228).

## Phases

* **Alpha:** free for Blaine's invited friends. No charge. Invited friends get
  any tier's features at $0.
* **Beta (scoped beta, November 13, 2026):** paid, using the locked tiers
  below. Monthly billing only at launch. No annual plan at launch.
* **Jarvis:** free (not $49). Separate Stripe product. $10 per seat model
  usage cap. A sourcing cutoff never refunds Jarvis, and a Jarvis failure
  never refunds sourcing.

## Model

* **Buyer paid SaaS, charged per company.** That is the whole revenue model
  at launch.
* **No cut of platform orders.** OverDrafter is never merchant of record and
  takes no fee on Xometry, Fictiv, Quickparts, Weerg, Geomiq, RMFG, OSH Cut or
  SendCutSend orders. Checkout stays on the platform, in the buyer's own
  account. The platforms run on roughly 34% marketplace gross margin;
  reselling their parts would make OverDrafter a competitor and add quality
  liability.
* **Suppliers are free.** Shops get the portal and a profile claim at no cost.
  A paid shop plan comes only after OverDrafter sends a shop repeat work.
  Affiliate income is not planned.
* **Value is engineer hours saved**, roughly $100/hr. The old $49 Pro
  hypothesis is dropped as too cheap.
* **The traditional shop channel is the moat** and the hedge against a
  platform cutting off access. Hard parts (Swiss turning, nickel alloys,
  optical tolerances) need real RFQs. Supplier network architecture is
  recorded on OVD-707.

## Locked tiers (monthly only at launch)

| Tier | Price | Includes | Cap |
|---|---|---|---|
| Free | $0 | 1 user, manual quote path, no automation | 3 manual runs/mo |
| Pro | **$99/mo** | 1 user, automated comparison across live providers, history | 40 successful runs; 300 provider attempts |
| Team | **$349/mo**, 5 seats, **+$40/seat** | Pro, plus shared projects; shop RFQs, vendor portal and supplier list as each ships | 120 pooled runs; 900 attempts |
| Founding Team | **$199/mo**, max 8 teams | Team features as they ship; 12 month rate hold, billed monthly | Same as Team |
| Jarvis | **Free**, separate Stripe product | Phone to SolidWorks assistant, approval required before CAD changes | $10 per seat model usage cap |
| Procurement (pilot, month 6+, staffed) | TBD later | Outreach, chasing, PO tracking, scorecards. Kept out of the ARR plan | — |
| Suppliers | Free | Portal and profile claim | — |

**Run definitions:** one run is one part revision, one spec, and up to 3
quantities across the live providers. Failed runs and provider off errors are
free. A fresh re quote counts; viewing history is free. Each provider gets at
most one automatic retry per run and a plain daily cap per account (about 20
quotes per provider per day), with no human mimicking pacing. There is **no
overage**: notify at 80%, pause automation at 100%. If margin breaks, cut the
cap before raising the price.

**Founding offer:** 8 hand sold teams at $199/mo, rate held 12 months, billed
monthly, cancel anytime. Charge only after a team has seen one real sourcing
job succeed. In exchange: a 20 to 25 minute monthly call, with a case study
requested but not required. After 12 months they move to list price with 30
days' notice. At capacity this is $1,592 MRR.

**Annual:** none at launch. Team at $3,490/yr (2 months free) may be offered
later only after 6 months with no C&D, and only if either 3+ instant providers
are live or at least 50% of that customer's usage is shop RFQs. Pro annual
($990) waits until providers have been stable for 6 months. If service is
withdrawn, unused months are refunded in cash.

**Price tests:** test $149 Pro and $399 Team on new signups only, after 10
companies have renewed twice.

## Pre charge conditions

Before the first card:

* Form an Arizona LLC (about $50) and open a business bank account in its
  name. Put Stripe in the LLC's name.
* Turn on Stripe Tax.
* Use template terms with these clauses: providers are "currently available"
  and may change; quotes are informational and orders are placed on the
  provider's site; liability is capped at 3 months of fees; no indemnity; no
  SLA; clear auto renewal language. Add the customer acknowledgement about
  their own provider accounts. Show live providers on the checkout page.
* **Reserve:** first month of collections plus $500. The next roughly $3k goes
  to counsel to review the terms and the permissions matrix. Counsel is paid
  from revenue, not as a gate before charging.

## Refunds and switch offs

* Turn off a provider the same day on any C&D, IP or bot block, CAPTCHA wall,
  or ban of a customer's account. Never work around a block.
* Email affected customers the same day. They get 14 days to claim a full
  refund of the current month, one refund per cutoff event. No partial
  credits.
* Pro auto pauses (Stripe pause collection) when fewer than 2 instant
  providers are live.
* Team keeps billing through a cutoff only once shop RFQs are live and in
  use. Before that, it follows the Pro rule.
* Sourcing and Jarvis never cross refund.

## Wedge customer

US commercial (uncontrolled) teams in opto mechanics, robotics, instruments
and UAV: 3 to 25 engineers, no dedicated buyer, sourcing at least 2 to 4
times a month, splitting work between instant platforms and local shops.
Tucson optics is the pilot list. Makers and job shops are the wrong first
customer.

## First 90 days of monetization

Scoped beta starts November 13, 2026. Gates below assume pre charge
conditions are already met.

**Before the first charge**

* Arizona LLC, bank and Stripe in the LLC's name. Stripe Tax on.
* Template terms, acknowledgement and live provider checkout.
* Off switches tested. Refund, prorate and pause flows run once in Stripe
  test mode.
* Upload block live. Credential storage reviewed.
* Provider permissions matrix for all 8 platforms.
* Legal council review (model council) and a cease and desist response
  playbook.
* Stripe catalog for Free, Pro, Team, Founding Team and Jarvis matches this
  document (OVD-725 / PR #671). Keep billing disabled until certification
  (OVD-199, OVD-319) and separate live charge approval (OVD-228).

**Days 1 to 30:** Free Alpha for invited friends; watch real sourcing jobs on
Beta. Measure cost per run (at least 50 runs), hours saved, and support
minutes. Charge each Founding team only after one job succeeds.

**Days 31 to 60:** Fill 8 Founding slots at $199. Fund the reserve. Start the
counsel review once collections cover reserve plus $3k.

**Days 61 to 90:** Open self serve Pro only if at least 5 Founding teams are
paying, delivery cost is at or under $20/Pro and $70/Team, and support takes
under about 5 hours a week.

**Day 90 go:** At least 6 of 8 Founding teams still paying, MRR at or above
$1.5k, no more than 1 dispute, no unresolved C&D. Continue, and plan the
$149/$399 test after 10 companies have renewed twice.

**Day 90 rework:** MRR under $1.5k, fewer than 5 of 8 Founding teams paying,
churn over 8%/mo, or delivery cost over budget. Cut caps first, then rework
price or wedge.

**Jarvis checkpoint:** Fewer than 5 outside weekly active users means it
stays free and gets fewer of Blaine's hours.

## Risks

* **Platform terms of service** are the largest risk. A user's consent does
  not override a platform's ToS (Fictiv requires prior written consent for
  automated access). Mitigations: the permissions matrix, a kill switch per
  provider, partner API outreach, and the legal council review plus C&D
  playbook.
* **ITAR/EAR.** Block controlled or uncertain uploads at launch. An attestation
  plus US hosting is not authorization, and Weerg and Geomiq are foreign.
  A controlled data tier waits for a specialist review.
* **Disintermediation.** Retention comes from revision history, approvals and
  audit trails. Any order fee applies only to POs issued inside OverDrafter.
* **Nothing makes liability zero.** An LLC and a 3 month liability cap in
  customer terms bound exposure; they do not eliminate CFAA or tort risk from
  automation in customer provider accounts.

## Scope note

Blaine overrode parking Jarvis: **Jarvis continues in parallel with 1.0**,
stays free with a $10 per seat model usage cap as a separate Stripe product,
and Fixture stays on the 1.0 plan as a throughput multiplier (see
[`docs/plans/beta-launch-plan.md`](../plans/beta-launch-plan.md)). The full
procurement suite remains parked.

## Assumptions to test with real customers

1. Target engineers save 1.5+ hours a month (Pro breakeven), or 3.5+ (Team).
2. Wedge teams source at least 4 parts a month, every month.
3. Buyers pay with zero or few platforms connected, so RFQ and portal value
   stands on its own.
4. The $99 Pro price can go on a card without approval, and a higher test
   price does not cut conversion by more than about 30%.
5. Teams pay for shared projects and RFQs rather than one seat each.
6. Fully loaded automation cost per quote run keeps gross margin at 80%+.
7. At least 4 of 8 platforms permit, or will partner on, automated quoting.
8. Traditional shops answer portal RFQs at useful rates (over 40%) without
   being paid.
9. Some buyers will pay for managed chasing of shop orders.
10. Few wedge customers need controlled data support early. If many do, an
    ITAR program becomes a priority and a premium tier.
