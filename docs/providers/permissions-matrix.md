# Provider permissions matrix (OVD-724)

Checked on **2026-10-21**. Machine-readable source: [`permissions-matrix.v1.json`](permissions-matrix.v1.json). Schema: [`permissions-matrix.v1.schema.json`](permissions-matrix.v1.schema.json).

This matrix is the ToS and partner-API clearance record for paid automated quoting. It does not admit a provider, dispatch traffic, or copy the OVD-722 kill-switch runtime state.

**Stance (Blaine):** comply with the law, accept terms-of-service risk until a cease-and-desist arrives, and take on no financial liability. Agents never contact vendors. Blaine sends every outreach himself.

## Derivation

`enabled_for_paid_automation` is true only when all of these hold:

1. `in_1_0` is true (Protolabs and Weerg stay in the matrix and are marked **not in 1.0**).
2. `permission_status` is not `cease_and_desist`.
3. `tos_stance` is `allowed`, or a written permission is recorded on the row, or an owner override recorded on the row (Blaine).

On 2026-10-21, owner Blaine Wilson was shown each provider's terms clause and explicitly cleared Xometry, Fictiv and Quickparts for quote-only automated quoting on his own provider accounts. He accepts ToS risk until a cease-and-desist arrives; no orders. This owner decision does not change their ToS stances or constitute vendor consent. No vendor was contacted; agents never contact vendors. Runtime admission and enablement remain separate.

On 2026-10-22, owner Blaine Wilson explicitly cleared Weerg, Geomiq, OSH Cut and SendCutSend for quote-only automated quoting on his own provider accounts, on the same terms: ToS risk accepted until a cease-and-desist arrives; no orders. This owner decision does not change their ToS stances or constitute vendor consent. No vendor was contacted; agents never contact vendors. Weerg stays **not in 1.0**, so its `enabled_for_paid_automation` stays derived false. Runtime admission and enablement remain separate.

## Kill switch pointer

Runtime off-switch: **OVD-722**. CLI: `npm run provider:kill -- <key>|--all --on|--off --reason "..."`. RPC: `api_admin_set_provider_kill_switch`. See the [cease-and-desist playbook](../runbooks/provider-cease-and-desist.md).

## Summary

| key | in_1_0 | api_availability | tos_stance | permission_status | enabled_for_paid_automation | date_checked | kill_switch_state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| xometry | true | partner_or_request_only | prohibited | draft_outreach_prepared | true | 2026-10-21 | OVD-722 |
| fictiv | true | none | prior-consent | draft_outreach_prepared | true | 2026-10-21 | OVD-722 |
| quickparts | true | none | silent | draft_outreach_prepared | true | 2026-10-21 | OVD-722 |
| weerg | false | none | silent | not_in_1_0 | false | 2026-10-11 | OVD-722 |
| geomiq | true | none | silent | draft_outreach_prepared | true | 2026-10-11 | OVD-722 |
| rmfg | true | public_agent_api | allowed | oct23_checkpoint_referenced | true | 2026-10-11 | OVD-722 |
| oshcut | true | none | silent | draft_outreach_prepared | true | 2026-10-11 | OVD-722 |
| sendcutsend | true | none | silent | not_requested | true | 2026-10-11 | OVD-722 |
| protolabs | false | none | prohibited | not_in_1_0 | false | 2026-10-11 | OVD-722 |

## Provider rows

Each row's `- replies: N` line must equal the length of that row's `replies` array in the JSON. A reply may only be logged once the row has moved past `draft_outreach_prepared` (for example to `replied`).

### xometry

- displayName: Xometry
- api_availability: partner_or_request_only
- tos_stance: prohibited
- partner_program: Xometry Developer API exists for accepted jobs and a separately approved Job Board. Customer-side instant quoting is not a published public API.
- contact: Developer API / website support; support@xometry.com
- permission_status: draft_outreach_prepared
- date_checked: 2026-10-21
- kill_switch_state: OVD-722 `private.provider_kill_switches` row for xometry
- enabled_for_paid_automation: true
- owner_override: Blaine Wilson; 2026-10-21; quote-only on owner accounts; ToS risk accepted until a cease-and-desist; no orders.
- tos_automation_clause: [Xometry Customer Service Agreement §7.1.2](https://www.xometry.com/service-agreement/) — You shall not or permit any third party to: use any manual or automated software devices or other processes (including but not limited to spiders, robots, scrapers, crawlers, avatars, data mining tools or the like) to “scrape” or download data from any web pages contained in the Website.
- replies: 0
- notes: Owner reviewed Customer Service Agreement §7.1.2 and explicitly cleared quote-only automated quoting on his own accounts. The prohibited ToS stance is unchanged. Legacy controlled-beta admission remains separate. No vendor was contacted; agents never contact vendors.

### fictiv

- displayName: Fictiv / MISUMI
- api_availability: none
- tos_stance: prior-consent
- partner_program: No public customer-quoting API found. Fictiv is part of MISUMI. Written consent is the stated path for any application that interacts with the services.
- contact: Published terms contact; help@fictiv.com
- permission_status: draft_outreach_prepared
- date_checked: 2026-10-21
- kill_switch_state: OVD-722 `private.provider_kill_switches` row for fictiv
- enabled_for_paid_automation: true
- owner_override: Blaine Wilson; 2026-10-21; quote-only on owner accounts; ToS risk accepted until a cease-and-desist; no orders.
- tos_automation_clause: [Fictiv Terms](https://www.fictiv.com/terms) — You will not or permit any third party to: ... develop or use any applications that interact with our Services without our prior written consent.
- replies: 0
- notes: Owner reviewed the prior-consent clause and explicitly cleared quote-only automated quoting on his own accounts. No written vendor consent is recorded; the prior-consent ToS stance is unchanged. No vendor was contacted; agents never contact vendors. Terms also prohibit scraping/downloading site data and using another user's account without authorization from that user and Fictiv.

### quickparts

- displayName: Quickparts
- api_availability: none
- tos_stance: silent
- partner_program: No public quote API found. QuickQuote is an authenticated website tool, not a published partner API.
- contact: Published website contact; https://quickparts.com/contact/
- permission_status: draft_outreach_prepared
- date_checked: 2026-10-21
- kill_switch_state: OVD-722 `private.provider_kill_switches` row for quickparts
- enabled_for_paid_automation: true
- owner_override: Blaine Wilson; 2026-10-21; quote-only on owner accounts; ToS risk accepted until a cease-and-desist; no orders.
- tos_automation_clause: [Quickparts Website Terms of Use](https://quickparts.com/terms-conditions/) — none of the material may be copied, reproduced, distributed, republished, downloaded ... without the prior written permission of Quickparts. No express automation clause.
- replies: 0
- notes: Owner reviewed the terms clause and explicitly cleared quote-only automated quoting on his own accounts. The silent ToS stance is unchanged. No vendor was contacted; agents never contact vendors. Website terms restrict copying site materials. They do not expressly allow or ban authenticated automated quoting. Sales terms at https://quickparts.com/sales-terms-conditions/ also omit an automation clause.

### weerg

- displayName: Weerg
- api_availability: none
- tos_stance: silent
- partner_program: Not in 1.0. Weerg is blocked and RMFG substitutes. No 1.0 partner-API outreach.
- contact: Published company contact; info@weerg.com
- permission_status: not_in_1_0
- date_checked: 2026-10-11
- kill_switch_state: OVD-722 `private.provider_kill_switches` row for weerg
- enabled_for_paid_automation: false
- owner_override: Blaine Wilson; 2026-10-22; quote-only on owner accounts; ToS risk accepted until a cease-and-desist; no orders.
- tos_automation_clause: [Weerg General Terms of Use and Delivery](https://www.weerg.com/faq/general-terms-and-conditions-for-the-purchase-of-services-and-supplies-supplier) — no published robots, scraper, or partner-API clause.
- replies: 0
- notes: Kept in the matrix and marked **not in 1.0**. Weerg is blocked; RMFG substitutes in the 1.0 set. 2026-10-22 owner override (appended): Owner explicitly cleared quote-only automated quoting on his own accounts on 2026-10-22, accepting ToS risk until a cease-and-desist; no orders. The silent ToS stance is unchanged. No vendor was contacted; agents never contact vendors.

### geomiq

- displayName: Geomiq
- api_availability: none
- tos_stance: silent
- partner_program: No public customer-quoting API found. Manufacturing-partner onboarding is a separate program and is not a customer quote API.
- contact: Published support contact; support@geomiq.com
- permission_status: draft_outreach_prepared
- date_checked: 2026-10-11
- kill_switch_state: OVD-722 `private.provider_kill_switches` row for geomiq
- enabled_for_paid_automation: true
- owner_override: Blaine Wilson; 2026-10-22; quote-only on owner accounts; ToS risk accepted until a cease-and-desist; no orders.
- tos_automation_clause: [Geomiq User Terms](https://geomiq.com/user-terms-conditions/) — Users must not introduce harmful software or misuse the platform. No grant of customer automation rights.
- replies: 0
- notes: User terms mention Geomiq's own automated data extraction for quoting. They do not grant customers a right to automate the portal. Ask for partner API access and written permission. 2026-10-22 owner override (appended): Owner explicitly cleared quote-only automated quoting on his own accounts on 2026-10-22, accepting ToS risk until a cease-and-desist; no orders. The silent ToS stance is unchanged. No vendor was contacted; agents never contact vendors. The partner-API and written-permission ask above stays open.

### rmfg

- displayName: RMFG
- api_availability: public_agent_api
- tos_stance: allowed
- partner_program: Public REST and hosted MCP agent API for quote, DFM, and cart preparation. Payments require a separate consent scope. OverDrafter stays quote-only.
- contact: Published developer / support contact; support@rmfg.com
- permission_status: oct23_checkpoint_referenced
- date_checked: 2026-10-11
- kill_switch_state: OVD-722 `private.provider_kill_switches` row for rmfg
- enabled_for_paid_automation: true
- tos_automation_clause: [RMFG API & AI Agents](https://www.rmfg.com/docs/api) — Your agent can upload STEP files, inspect parts, configure manufacturing, and prepare checkout.
- notes: Oct 23 checkpoint asks already cover RMFG API access. Do not duplicate them. Runtime admission and OVD-678 live wiring remain separate. Cart, checkout, and payment stay unreachable.
- replies: 0

### oshcut

- displayName: OSH Cut
- api_availability: none
- tos_stance: silent
- partner_program: No public quote API found. An affiliate rewards program exists and is not an API partnership.
- contact: Published support contact; support@oshcut.com
- permission_status: draft_outreach_prepared
- date_checked: 2026-10-11
- kill_switch_state: OVD-722 `private.provider_kill_switches` row for oshcut
- enabled_for_paid_automation: true
- owner_override: Blaine Wilson; 2026-10-22; quote-only on owner accounts; ToS risk accepted until a cease-and-desist; no orders.
- tos_automation_clause: [OSH Cut Terms of Service](https://www.oshcut.com/terms-of-service) — no published clause addresses automated access, robots, or a customer quote API.
- replies: 0
- notes: Sales terms are silent on automation. Ask for partner API access and written permission. Historical admission permission basis: owner_approved (OVD-641), recorded by Blaine on 2026-10-15; the planned OVD-677 go-live was superseded by the 2026-10-20 default-off decision. OSH Cut remains liveAdapter:false with no session secrets and egress:none. This is not a matrix clearance, so enabled_for_paid_automation stays derived false. 2026-10-22 owner override (appended): Owner explicitly cleared quote-only automated quoting on his own accounts on 2026-10-22, accepting ToS risk until a cease-and-desist; no orders. The silent ToS stance is unchanged. No vendor was contacted; agents never contact vendors. It supersedes the "not a matrix clearance" sentence above: the override is the matrix clearance; runtime gates (liveAdapter, session secrets, egress, admission) are unchanged. The partner-API and written-permission ask above stays open.

### sendcutsend

- displayName: SendCutSend
- api_availability: none
- tos_stance: silent
- partner_program: No public developer API found. Marketplace is a seller program for individual accounts, not a quote API.
- contact: Published website support; https://sendcutsend.com/contact/
- permission_status: not_requested
- date_checked: 2026-10-11
- kill_switch_state: OVD-722 `private.provider_kill_switches` row for sendcutsend
- enabled_for_paid_automation: true
- owner_override: Blaine Wilson; 2026-10-22; quote-only on owner accounts; ToS risk accepted until a cease-and-desist; no orders.
- tos_automation_clause: [SendCutSend Terms](https://sendcutsend.com/terms-of-service/) — no published clause addresses automated access, robots, scrapers, or a public developer API.
- replies: 0
- notes: Named in OVD-724. Not in the current outreach ask list. No partner-API draft is prepared until Blaine adds it. 2026-10-22 owner override (appended): Owner explicitly cleared quote-only automated quoting on his own accounts on 2026-10-22, accepting ToS risk until a cease-and-desist; no orders. The silent ToS stance is unchanged. No vendor was contacted; agents never contact vendors.

### protolabs

- displayName: Protolabs
- api_availability: none
- tos_stance: prohibited
- partner_program: Not in 1.0. No 1.0 partner-API outreach.
- contact: Published legal notices; https://www.protolabs.com/legal-notices/
- permission_status: not_in_1_0
- date_checked: 2026-10-11
- kill_switch_state: OVD-722 `private.provider_kill_switches` row for protolabs
- enabled_for_paid_automation: false
- tos_automation_clause: [Protolabs Legal Notices](https://www.protolabs.com/legal-notices/) — do not use software or automated agents or scripts ... to generate automated searches, requests, or queries to (or to strip, scrape, or mine data from) the Site.
- replies: 0
- notes: Kept in the matrix and marked **not in 1.0**.

## Related records

- Acceptance tables: [acceptance-tables.md](acceptance-tables.md)
- Outreach drafts (not sent): [outreach/](outreach/)
- Model-council legal review: [legal-council-review-2026-10.md](legal-council-review-2026-10.md)
- C&D playbook: [../runbooks/provider-cease-and-desist.md](../runbooks/provider-cease-and-desist.md)
- Provider manifests (OVD-688 registry fallback): `provider-integrations/<key>/manifest.v1.json`
