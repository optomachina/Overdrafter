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
specific 1.0 route. Not cleared for paid automated quoting.

### sendcutsend

Permissions: [permissions-matrix.md](permissions-matrix.md#sendcutsend). Named
in OVD-724. No outreach draft until Blaine adds it to the ask list.

### protolabs

Permissions: [permissions-matrix.md](permissions-matrix.md#protolabs). Marked
**not in 1.0**. Portal automation is prohibited. The row exists so the lint
keeps Protolabs visible and uncleared.
