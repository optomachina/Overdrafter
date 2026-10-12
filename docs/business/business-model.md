# OverDrafter Business Model

Approved by Blaine on October 11, 2026. Source: the business council synthesis
(Grok, Astra and Opus, two rounds) with Blaine's changes applied.

**Final prices are pending a council rerun.** This document records the model
and the tier structure. Every price below is TBD until that rerun is approved,
and the Stripe catalog (OVD-228) stays disabled until then and until 1.0
certification (OVD-199, OVD-319).

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
* **Value is engineer hours saved**, roughly $100/hr. The old $49 hypothesis is
  dropped as too cheap.
* **The traditional shop channel is the moat** and the hedge against a
  platform cutting off access. Hard parts (Swiss turning, nickel alloys,
  optical tolerances) need real RFQs. Supplier network architecture is
  recorded on OVD-707.

## Tiers (prices TBD)

| Tier | Price | Includes |
|---|---|---|
| Free | $0 | Manual quote runs on the existing free quote meter, 1 user, no automation, no RFQ send |
| Pro | TBD | 1 user, automated multi provider quotes (only providers the permissions matrix clears), fair use cap, history, requote on revision |
| Team | TBD | Multiple seats, shared projects, traditional shop RFQs and the QR vendor portal, private approved supplier list |
| Founding Team | TBD, locked 12 months, max 12 teams | Team features in exchange for a case study and a monthly call |
| Procurement (pilot, month 6+, staffed) | TBD (flat monthly or a capped percent of in app PO value, buyer picks) | Outreach, chasing, PO tracking, scorecards. Kept out of the ARR plan |
| Suppliers | Free | Portal and profile claim |

Metering is a fair use cap where failed runs don't count, with no overage at
launch. Cost per run is measured before the cap is set.

## Wedge customer

US commercial (uncontrolled) teams in opto mechanics, robotics, instruments
and UAV: 3 to 25 engineers, no dedicated buyer, sourcing at least 2 to 4
times a month, splitting work between instant platforms and local shops.
Tucson optics is the pilot list. Makers and job shops are the wrong first
customer.

## First 90 days of monetization

**Days 1 to 21: gates before any charge**

* Provider permissions matrix for all 8 platforms.
* **Legal council review (model council) and a cease and desist response
  playbook.** This replaces a paid lawyer review for now.
* Per provider kill switch.
* Block controlled or uncertain (ITAR/EAR) uploads.
* Ask Fictiv/MISUMI, Geomiq, Weerg and OSH Cut about partner API access.
* Set up the Stripe catalog for Pro, Team and Founding Team with prices TBD
  (OVD-228). Keep it disabled until the council rerun sets prices and 1.0 is
  certified.

**Days 22 to 45:** Founding Beta (OVD-358) with about 10 Tucson and regional
teams. Watch 2 to 3 real sourcing jobs per team. Log hours saved per part,
quote comparability, cost per run and the reason for each "no".

**Days 46 to 60:** Offer Founding Team once a team has seen value (OVD-320).
Target 6 to 8 paying teams.

**Days 61 to 90:** Publish 3 case studies with real cross supplier price
spreads. Open self serve Pro.

**Day 90 gate:** If MRR misses the target set in the pricing rerun, fewer than
5 of 8 Founding teams are still paying, or churn is over 8% a month, rework
price or wedge. If 60%+ renew and usage is 4+ parts a month, start the Pro
price test and the Team upsell. Still no shop fees and no Procurement tier.

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

## Scope note

The council suggested parking Jarvis and Fixture until paying teams exist.
Blaine overrode that: **Jarvis continues in parallel with 1.0** and Fixture
stays on the 1.0 plan as a throughput multiplier (see
[`docs/plans/beta-launch-plan.md`](../plans/beta-launch-plan.md)). The full
procurement suite remains parked.

## Assumptions to test with real customers

1. Target engineers save 1.5+ hours a month (Pro breakeven), or 3.5+ (Team).
2. Wedge teams source at least 4 parts a month, every month.
3. Buyers pay with zero or few platforms connected, so RFQ and portal value
   stands on its own.
4. The Pro price can go on a card without approval, and a higher test price
   does not cut conversion by more than about 30%.
5. Teams pay for shared projects and RFQs rather than one seat each.
6. Fully loaded automation cost per quote run keeps gross margin at 80%+.
7. At least 4 of 8 platforms permit, or will partner on, automated quoting.
8. Traditional shops answer portal RFQs at useful rates (over 40%) without
   being paid.
9. Some buyers will pay for managed chasing of shop orders.
10. Few wedge customers need controlled data support early. If many do, an
    ITAR program becomes a priority and a premium tier.
