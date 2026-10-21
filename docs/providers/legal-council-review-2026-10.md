# Model-council legal review — provider ToS posture (October 2026)

**This is not legal advice.** It is an internal model-council review of the
permissions matrix and OverDrafter's published-terms posture. No paid lawyer
reviewed this document. Re-run the council when a ToS changes or a reply arrives.

Reviewed artifacts: `docs/providers/permissions-matrix.v1.json`, the first-party
URLs cited there, Blaine's recorded stance (comply with the law, accept
terms-of-service risk until a cease-and-desist arrives, take on no financial
liability), and the OVD-722 kill-switch plan.

Date: 2026-10-11. Owner: Blaine.

## Owner decision addendum — 2026-10-21

The readings and conclusions below are the historical 2026-10-11 review,
superseded on clearance by this owner decision. After being shown each terms
clause, Blaine Wilson explicitly cleared Xometry, Fictiv and Quickparts for
quote-only automated quoting on his own provider accounts. He accepts ToS risk
until a cease-and-desist; no orders. Their ToS stances remain `prohibited`
(Xometry Customer Service Agreement §7.1.2), `prior-consent` (Fictiv), and
`silent` (Quickparts). No vendor was contacted; agents never contact vendors.

The [matrix](permissions-matrix.md) now includes a recorded owner override as a
third clearance path, alongside allowed terms or written permission. Xometry,
Fictiv, Quickparts and RMFG are matrix-cleared within their recorded scopes.
The 1.0 scope, C&D stop, freshness checks, and separate runtime gates remain.
This records clearance only; it enables nothing at runtime.

## Method

Three independent readings were written against the same matrix, then reconciled.
They disagree on how far "accept ToS risk" may go. They agree on the mechanical
clearance rule and on the C&D response.

## Reading A — strict first-party terms

Portal automation that scrapes or drives a website against an express robot /
scraper / automated-application clause is outside the published license.

- Xometry §7.1.2 and Protolabs legal notices are **prohibited** for portal
  automation.
- Fictiv is **prior-consent**: applications that interact with the services need
  written consent. Consent has not been recorded, so Fictiv is not cleared.
- RMFG publishes an agent/API that invites automated quoting. That path is
  **allowed** for quote-only use. Cart, checkout, and payment stay off-limits.
- Quickparts, Weerg, Geomiq, OSH Cut, and SendCutSend are **silent**. Silence is
  not permission. They stay uncleared until a written permission or an `allowed`
  stance is recorded.

Conclusion A: only RMFG is cleared for paid automated quoting. Every other 1.0
row stays `enabled_for_paid_automation=false`.

## Reading B — business-risk stance

Blaine's recorded stance accepts ToS risk until a C&D, provided OverDrafter
complies with law and takes on no financial liability. That stance explains why
legacy Xometry controlled-beta traffic may continue as an owner-accepted risk.
It does **not** rewrite the matrix derivation. The matrix still withholds
clearance unless the terms allow automation or written permission exists.

Conclusion B: keep operating the legacy Xometry path as an accepted ToS risk,
but do not mark it cleared. The C&D playbook is the control that makes the risk
reversible within 1 hour and with no deploy.

## Reading C — consent-path / partner-API reading

Where a vendor publishes a partner or developer API, treat portal scraping as
the wrong door and the API request as the right one. Xometry's Developer API is
a partner/job-board product, not a documented customer quote API, so it does not
flip Xometry to `allowed`. Fictiv's consent clause is the entire path: ask, do
not infer. Silent vendors should be asked, not assumed.

Conclusion C: outreach drafts are the correct next action for Fictiv, Geomiq,
Weerg, OSH Cut, and the optional Quickparts and Xometry asks. RMFG's Oct 23
checkpoint already covers that vendor.

## Disagreements

| Topic | A | B | C | Reconciliation |
| --- | --- | --- | --- | --- |
| May Xometry stay on the controlled-beta path? | No, terms prohibit portal automation | Yes, as accepted ToS risk until C&D | Only through an official quote API | Matrix records **prohibited** and **not cleared**. Runtime admission is a separate legacy fact. The playbook is the stop. |
| Is silence permission? | No | No, but risk may be accepted | No; ask | Matrix records **silent** and **not cleared**. |
| Does RMFG's public API clear paid automation? | Yes, quote-only | Yes, still subject to admission/wiring | Yes, and do not send a second letter | Matrix records **allowed** and **enabled**. Oct 23 / OVD-678 remain operational work. |
| Does Fictiv's prior-consent clause allow owner-approved risk? | No | Only as uncleared risk | No; wait for writing | Matrix stays false until written permission is recorded. |
| Is Protolabs in scope? | Out of 1.0; terms prohibit automation | Out of 1.0 | Out of 1.0 | Kept in the matrix and marked **not in 1.0**. |

## Final position (historical 2026-10-11; see owner decision above)

1. The matrix is the only clearance record for paid automated quoting. A provider
   is cleared only when `enabled_for_paid_automation` is true under the published
   derivation. Today that is RMFG alone.
2. Legacy Xometry controlled-beta admission is not a matrix clearance. It is an
   owner-accepted ToS-risk path. It must still honor a C&D within 1 hour via
   OVD-722, with no deploy.
3. Fictiv, Quickparts, Weerg, Geomiq, OSH Cut, and SendCutSend are not cleared.
   Draft outreach exists for the first five plus Xometry. Nothing is sent unless
   Blaine sends it.
4. Protolabs remains in the matrix and is marked not in 1.0.
5. A C&D sets `permission_status=cease_and_desist`, forces enabled false, and
   uses the OVD-722 switch as step one.
6. This document is not legal advice and does not replace paid counsel if a
   letter demands money or a release.

## Re-run triggers

- A cited ToS URL changes.
- A reply is logged on any matrix row.
- OVD-722 lands and the kill-switch pointer needs a live command example.
- Written permission is recorded for any provider.
