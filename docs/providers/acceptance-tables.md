# Provider acceptance tables — permissions matrix links

Each 1.0 provider, plus Protolabs (not in 1.0), links to the permissions matrix
required by OVD-724. The matrix is the clearance record for paid automated
quoting. Live readiness, admission, and the OVD-722 kill switch remain separate
gates.

Canonical matrix: [permissions-matrix.md](permissions-matrix.md) and
[permissions-matrix.v1.json](permissions-matrix.v1.json).

| key | Issue / table | in_1_0 | Matrix clearance | Existing live-readiness |
| --- | --- | --- | --- | --- |
| xometry | OVD-206 / controlled beta | true | owner override 2026-10-21; quote-only on owner accounts (`prohibited`) | `docs/1-0-beta-runbook.md` |
| fictiv | OVD-395 | true | owner override 2026-10-21; quote-only on owner accounts (`prior-consent`) | [ovd673-fictiv-live-readiness.md](../workflows/ovd673-fictiv-live-readiness.md) |
| quickparts | OVD-396 | true | owner override 2026-10-21; quote-only on owner accounts (`silent`) | [ovd674-quickparts-live-readiness.md](../workflows/ovd674-quickparts-live-readiness.md) |
| weerg | OVD-397 | false | owner override 2026-10-22; quote-only on owner accounts (`silent`) | [ovd675-weerg-live-readiness.md](../workflows/ovd675-weerg-live-readiness.md) |
| geomiq | OVD-398 | true | owner override 2026-10-22; quote-only on owner accounts (`silent`) | `provider-integrations/geomiq/offline-evaluation.md` |
| rmfg | OVD-678 / OVD-580 | true | cleared on published agent/API only | [rmfg-public-capability-recon.md](../rmfg-public-capability-recon.md) |
| oshcut | process-specific 1.0 | true | owner override 2026-10-22; quote-only on owner accounts (`silent`) | `provider-integrations/oshcut/manifest.v1.json` |
| sendcutsend | named in OVD-724 | true | owner override 2026-10-22; quote-only on owner accounts (`silent`) | `provider-integrations/sendcutsend/manifest.v1.json` |
| protolabs | not in 1.0 | false | never cleared | `provider-integrations/protolabs/manifest.v1.json` |

Kill-switch certification for every 1.0 provider is an OVD-722 / OVD-319
acceptance item. Record the flip-off / no-traffic / flip-on result in the
provider's live-readiness or acceptance notes when that issue lands.

## OVD-723 export-control certification (OVD-319 walk)

OVD-723 blocks controlled or uncertain uploads at upload time and denies
dispatch unless the latest declaration is `not_controlled` and no marking block
is open. The OVD-319 certification walk must run two extra cases per 1.0
provider and record the result here:

- **Marked drawing**: upload a drawing whose title block carries an ITAR, ECCN,
  CUI, or distribution-statement marking with a `not_controlled` declaration.
  Expected: extraction records `blocked_pending_review` and the preflight
  denies with `export_review_pending` (foreign providers:
  `export_foreign_provider_requires_clean_declaration`). Zero provider traffic.
- **`unsure` answer**: answer `unsure` at upload. Expected: the upload stops,
  zero storage objects and zero `job_files` rows, so nothing can be dispatched.

Status: **not run**. The gate is a migration draft
(`docs/migration-drafts/ovd-723.sql`, needs a Blaine migration window). Run the
walk after the window 1 migration is applied, then fill in the result column.

| key | Marked drawing | `unsure` answer | Expected denial code | Result |
| --- | --- | --- | --- | --- |
| xometry | pending | pending | `export_review_pending` | not run |
| fictiv | pending | pending | `export_review_pending` | not run |
| quickparts | pending | pending | `export_review_pending` | not run |
| weerg | pending | pending | `export_foreign_provider_requires_clean_declaration` | not run |
| geomiq | pending | pending | `export_foreign_provider_requires_clean_declaration` | not run |
| rmfg | pending | pending | `export_review_pending` | not run |
| oshcut | pending | pending | `export_review_pending` | not run |
| sendcutsend | pending | pending | `export_review_pending` | not run |

## Per-provider acceptance notes

### xometry

Permissions: [permissions-matrix.md](permissions-matrix.md#xometry). Cleared by
Blaine Wilson's owner override on 2026-10-21 after reviewing the terms clause:
quote-only automated quoting on his own provider accounts, ToS risk accepted
until a cease-and-desist, no orders. ToS stance remains `prohibited`.
No vendor was contacted; agents never contact vendors. Runtime gates are unchanged.
Legacy controlled-beta admission remains separate. C&D step one is the OVD-722 switch.

### fictiv

Permissions: [permissions-matrix.md](permissions-matrix.md#fictiv). Cleared by
Blaine Wilson's owner override on 2026-10-21 after reviewing the terms clause:
quote-only automated quoting on his own provider accounts, ToS risk accepted
until a cease-and-desist, no orders. ToS stance remains `prior-consent`.
No vendor was contacted; agents never contact vendors. Runtime gates are unchanged.
No written vendor consent is recorded. See also [Fictiv live readiness](../workflows/ovd673-fictiv-live-readiness.md). C&D step one is the OVD-722 switch.

### quickparts

Permissions: [permissions-matrix.md](permissions-matrix.md#quickparts). Cleared by
Blaine Wilson's owner override on 2026-10-21 after reviewing the terms clause:
quote-only automated quoting on his own provider accounts, ToS risk accepted
until a cease-and-desist, no orders. ToS stance remains `silent`.
No vendor was contacted; agents never contact vendors. Runtime gates are unchanged.
See also [Quickparts live readiness](../workflows/ovd674-quickparts-live-readiness.md). C&D step one is the OVD-722 switch.

### weerg

Permissions: [permissions-matrix.md](permissions-matrix.md#weerg). Cleared by
Blaine Wilson's owner override on 2026-10-22: quote-only automated quoting on
his own provider accounts, ToS risk accepted until a cease-and-desist, no
orders. ToS stance remains `silent`. No vendor was contacted; agents never
contact vendors. Runtime gates are unchanged. See also
[Weerg live readiness](../workflows/ovd675-weerg-live-readiness.md).

### geomiq

Permissions: [permissions-matrix.md](permissions-matrix.md#geomiq). Cleared by
Blaine Wilson's owner override on 2026-10-22: quote-only automated quoting on
his own provider accounts, ToS risk accepted until a cease-and-desist, no
orders. ToS stance remains `silent`. No vendor was contacted; agents never
contact vendors. Runtime gates are unchanged. Offline
evaluation notes stay in `provider-integrations/geomiq/offline-evaluation.md`.

### rmfg

Permissions: [permissions-matrix.md](permissions-matrix.md#rmfg). Matrix
clearance applies to the published quote API only. Oct 23 checkpoint asks and
OVD-678 live wiring are not duplicated here.

### oshcut

Permissions: [permissions-matrix.md](permissions-matrix.md#oshcut). Cleared by
Blaine Wilson's owner override on 2026-10-22: quote-only automated quoting on
his own provider accounts, ToS risk accepted until a cease-and-desist, no
orders. ToS stance remains `silent`. No vendor was contacted; agents never
contact vendors. Runtime gates are unchanged. Process-
specific 1.0 route. The OVD-677 admission basis
remains `owner_approved` (OVD-641).

### sendcutsend

Permissions: [permissions-matrix.md](permissions-matrix.md#sendcutsend). Cleared by
Blaine Wilson's owner override on 2026-10-22: quote-only automated quoting on
his own provider accounts, ToS risk accepted until a cease-and-desist, no
orders. ToS stance remains `silent`. No vendor was contacted; agents never
contact vendors. Runtime gates are unchanged. Named
in OVD-724. No outreach draft until Blaine adds it to the ask list.

### protolabs

Permissions: [permissions-matrix.md](permissions-matrix.md#protolabs). Marked
**not in 1.0**. Portal automation is prohibited. The row exists so the lint
keeps Protolabs visible and uncleared.
