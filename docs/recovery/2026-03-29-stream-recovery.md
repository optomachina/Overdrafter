# Stream Recovery Note — North Star + Heerich

Last updated: 2026-03-29

This note is the temporary fallback artifact for the recovery plan while Linear
tools are unavailable in the current Codex session. Linear remains the source of
truth; copy the relevant sections into Linear workpads/comments when the app is
available again.

## North Star

Status:
- Recover first.
- Use issue-sized Symphony workspaces and deterministic `OVD-*` branches.
- Treat the existing open PRs as salvage references, not merge targets.

Primary salvage PR:
- `#149` `codex/continue-north-star-implementation`

Secondary salvage PRs:
- `#142` `codex/implement-overdrafter-north-star-features`
- `#144` `codex/implement-north-star-sequence-with-subagents`
- `#145` `codex/build-north-star-implementation-tasks`
- `#147` `codex/implement-remaining-ovd-backlog-issues`

Primary salvage files from `#149`:
- `.env.example`
- `ARCHITECTURE.md`
- `src/lib/north-star-assembly-inference.ts`
- `src/lib/north-star-assembly-inference.test.ts`
- `src/lib/north-star-domain.ts`
- `src/lib/north-star-domain.test.ts`
- `src/lib/north-star-ingestion.ts`
- `src/lib/north-star-ingestion.test.ts`
- `src/lib/workspace-ui-variant.ts`
- `src/lib/workspace-ui-variant.test.ts`
- `src/pages/Index.tsx`
- `src/pages/Index.role.test.tsx`
- `src/pages/NorthStarPreviewHome.tsx`
- `src/vite-env.d.ts`

Issue mapping defaults:
- `OVD-104`: `src/lib/north-star-domain.*`
- `OVD-105`: `src/lib/north-star-ingestion.*`
- `OVD-106`: `src/lib/north-star-assembly-inference.*`
- UI gate / preview files only move into the exact issue whose Linear acceptance
  criteria cover that behavior.

Keep/close policy:
- Keep `#149` open only until the first recovered issue branch is live.
- Close `#142`, `#144`, `#145`, and `#147` after their useful deltas are noted
  in the corresponding Linear issue workpads.

Execution order:
1. `OVD-104`
2. `OVD-105`
3. `OVD-106`
4. Follow-on UI preview / gating issues from the existing `OVD-107..122`
   backlog, using Linear descriptions as the source of truth

## Heerich

Status:
- Recover second.
- Use issue-sized Symphony workspaces and deterministic `OVD-*` branches.
- Treat the existing open PRs as salvage references, not merge targets.

Primary salvage PRs:
- `#143` `codex/work-on-heerich-integration-tasks` for `OVD-123`
- `#146` `codex/provide-updates-on-ovd-123-to-ovd-127` for `OVD-127`
- `#150` `codex/continue-working-on-ovd-124-to-ovd-127` as umbrella reference
  for `OVD-124..126`

Superseded salvage PR:
- `#148` `codex/continue-working-on-ovd-123-to-ovd-127`

Primary salvage files from `#143`:
- `worker/THIRD_PARTY.md`
- `worker/package.json`
- `worker/src/extraction/geometryProjection.ts`
- `worker/src/extraction/sharedResult.ts`
- `worker/src/index.ts`

Primary salvage files from `#146`:
- `THIRD_PARTY.md`
- `src/concepts/set-3/PartPage.tsx`

Primary salvage files from `#150`:
- `THIRD_PARTY.md`
- `src/components/quotes/ClientQuoteAssetPanels.tsx`
- `src/components/workspace/GeometryProjectionView.tsx`
- `src/components/workspace/ProjectInspectorPanel.tsx`
- `src/components/workspace/QuoteChart.tsx`
- `src/concepts/set-3/PartPage.tsx`
- `src/features/quotes/types.ts`
- `src/features/quotes/utils.ts`
- `src/pages/ClientProject.tsx`
- `worker/THIRD_PARTY.md`
- `worker/package.json`
- `worker/src/extraction/debugLab.ts`
- `worker/src/extraction/geometryProjection.ts`
- `worker/src/extraction/hybridExtraction.test.ts`
- `worker/src/extraction/hybridExtraction.ts`
- `worker/src/extraction/sharedResult.ts`
- `worker/src/index.ts`
- `worker/src/types.ts`

Issue mapping defaults:
- `OVD-123`: worker geometry projection foundation and artifact typing
- `OVD-127`: concept gallery prototype using mock geometry projection data
- `OVD-124`: manufacturing view renderer and CAD-panel integration
- `OVD-125`: geometry-backed DFM / risk overlay
- `OVD-126`: quote-chart and cost-driver highlight sync

Known stale tests to fix when re-landing:
- `worker/src/extraction/hybridExtraction.test.ts`
- `src/features/quotes/utils.ts` and its corresponding test expectations

Keep/close policy:
- Keep `#143` and `#146` open until `OVD-123` and `OVD-127` have recovered
  issue branches.
- Use `#150` as a non-mergeable salvage branch for `OVD-124..126`.
- Close `#148` after copying any remaining useful notes into Linear.

Execution order:
1. `OVD-123`
2. `OVD-127` in parallel once `OVD-123` is underway
3. `OVD-124`
4. `OVD-125`
5. `OVD-126`

## Stream-End Review Gate

Each stream is complete only after:
- all intended issue PRs are merged
- code review has been run on the combined stream diff
- regression QA and browser verification are attached
- design review has been run for visible UX surfaces
- follow-up bugs are filed for any non-blocking findings
