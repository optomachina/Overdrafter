# Provider acceptance tables — permissions matrix links

Each 1.0 provider, plus Protolabs (not in 1.0), links to the permissions matrix
required by OVD-724. The matrix is the clearance record for paid automated
quoting. Live readiness, admission, and the OVD-722 kill switch remain separate
gates.

Canonical matrix: [permissions-matrix.md](permissions-matrix.md) and
[permissions-matrix.v1.json](permissions-matrix.v1.json).

| key | Issue / table | in_1_0 | Matrix clearance | Existing live-readiness |
| --- | --- | --- | --- | --- |
| xometry | OVD-206 / controlled beta | true | not cleared (`prohibited`) | `docs/1-0-beta-runbook.md` |
| fictiv | OVD-395 | true | not cleared (`prior-consent`) | [ovd673-fictiv-live-readiness.md](../workflows/ovd673-fictiv-live-readiness.md) |
| quickparts | OVD-396 | true | not cleared (`silent`) | [ovd674-quickparts-live-readiness.md](../workflows/ovd674-quickparts-live-readiness.md) |
| weerg | OVD-397 | true | not cleared (`silent`) | [ovd675-weerg-live-readiness.md](../workflows/ovd675-weerg-live-readiness.md) |
| geomiq | OVD-398 | true | not cleared (`silent`) | `provider-integrations/geomiq/offline-evaluation.md` |
| rmfg | OVD-678 / OVD-580 | true | cleared on published agent/API only | [rmfg-public-capability-recon.md](../rmfg-public-capability-recon.md) |
| oshcut | process-specific 1.0 | true | not cleared (`silent`) | `provider-integrations/oshcut/manifest.v1.json` |
| sendcutsend | named in OVD-724 | true | not cleared (`silent`) | `provider-integrations/sendcutsend/manifest.v1.json` |
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

Permissions: [permissions-matrix.md](permissions-matrix.md#xometry). Paid
automated quoting is not matrix-cleared. Legacy controlled-beta admission is a
separate ToS-risk path. C&D step one is the OVD-722 switch.

### fictiv

Permissions: [permissions-matrix.md](permissions-matrix.md#fictiv). Written
consent is required before the matrix can clear Fictiv. See also
[Fictiv live readiness](../workflows/ovd673-fictiv-live-readiness.md).

### quickparts

Permissions: [permissions-matrix.md](permissions-matrix.md#quickparts). See also
[Quickparts live readiness](../workflows/ovd674-quickparts-live-readiness.md).

### weerg

Permissions: [permissions-matrix.md](permissions-matrix.md#weerg). See also
[Weerg live readiness](../workflows/ovd675-weerg-live-readiness.md).

### geomiq

Permissions: [permissions-matrix.md](permissions-matrix.md#geomiq). Offline
evaluation notes stay in `provider-integrations/geomiq/offline-evaluation.md`.

### rmfg

Permissions: [permissions-matrix.md](permissions-matrix.md#rmfg). Matrix
clearance applies to the published quote API only. Oct 23 checkpoint asks and
OVD-678 live wiring are not duplicated here.

### oshcut

Permissions: [permissions-matrix.md](permissions-matrix.md#oshcut). Process-
specific 1.0 route. Not matrix-cleared for paid automated quoting; the OVD-677
admission basis is `owner_approved` (OVD-641).

### sendcutsend

Permissions: [permissions-matrix.md](permissions-matrix.md#sendcutsend). Named
in OVD-724. No outreach draft until Blaine adds it to the ask list.

### protolabs

Permissions: [permissions-matrix.md](permissions-matrix.md#protolabs). Marked
**not in 1.0**. Portal automation is prohibited. The row exists so the lint
keeps Protolabs visible and uncleared.
