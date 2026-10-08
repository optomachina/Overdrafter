# Ownership handoff receipt (2026-10-08T07:4xZ)

Issued by the cloud coordinator (session_01GqaoSqia9BNetUBaGnMQSM) to the owner side (Blaine; Codex chat 01a11a5b-5227-7100-acf6-ce063d5a69ec; local root /Users/blainewilson/Documents/GitHub/Overdrafter).

## Canonical run store

The coordinator's run store is the cloud scratchpad `scratchpad/run/` of this session: `state.json` (workflows, merges, pr_state, lane_status, decisions, production_ledger), `specs/` (unit and lane manifests), `findings/` (review and audit outputs), `production-apply-packet-v*.md`, `handoff/`. It is not reachable from the local machine. The evidence of record never lives there: it lives in PR bodies, hosted run ids, Linear comments and merge commits. The local side therefore needs no copy of the store; it returns results through the PR and the chat, and the coordinator records them.

Assignment manifests attached to this receipt: `specs/local-OVD630.json`, `specs/local-OVD636.json`.

## Reservations (one writer per branch)

| Unit | Owner | Branch | Base and revision | Cloud coordinator role |
|---|---|---|---|---|
| OVD-630 | LOCAL (owner side) | claude/ovd630-client-shell-tablet-fixture | main @ 7b50f0d (or the then-current origin/main) | verify lane, CodeRabbit request, gate, squash-merge; no implementation, no push |
| OVD-636 | LOCAL (owner side) | claude/ovd636-browser-recovery-test-robustness | codex/recovered-release-free-safety-20261003 @ f9348a2 | verify lane, manual CodeRabbit request, gate, squash-merge into the integration branch; no implementation, no push |
| OVD-641 (#605) | CLOUD coordinator | bwilson/ovd-641-owner-approved-permission-basis @ f776fe3 | main @ 7b50f0d | lane wf_4b1233b6-541 in round 2; the local side does not push to this branch while the lane runs |
| #565 carve | CLOUD coordinator | claude/carve565-* (per carve) | main | plan in progress; first lane after #605 |
| Ledger queries, workstation X1 test-runtime | LOCAL (owner) | n/a | production project ozuatdcakezjtevztjlr (read-only); workstation-fizzy-candle | prepares only; no production or native action |

Reservation comments posted on OVD-630 and OVD-636 at 2026-10-08T07:17Z. No `claude/ovd630*` or `claude/ovd636*` branch exists on origin at issue time.

## Current revisions at issue time

| Ref | Revision |
|---|---|
| origin/main | 7b50f0ddbc457a9372d1c900c9eb607acfcea3c6 |
| origin/codex/recovered-release-free-safety-20261003 | f9348a2768088214be0febb5b08def3f40674e20 |
| origin/bwilson/ovd-641-owner-approved-permission-basis | f776fe3 (lane fix f1) |
| origin/handoff/jarvis-reviewed-e5e3db0 (#565) | bae69fbf09a05b83bf60fd46c40985c86a83849b |

## Launch protocol for the local side

1. `git fetch origin`; branch from the base revision in the manifest; `npm ci` (and `npm ci` in `worker/` for OVD-636).
2. Follow the manifest's acceptance list A1-A7 in order; red first, then green, then mutation.
3. Push ordinary commits; open the DRAFT PR; reply in chat with PR number and head sha.
4. Do not request CodeRabbit (the coordinator schedules it against the hourly limit); do not re-run CI more than once; do not merge.
5. On a coordinator review finding, the local side pushes the fix (it stays the single writer) or replies why not.

## Boundaries (unchanged)

No production apply, no native SolidWorks actions, no broad permission allowlist, no purchases, no human or vendor outreach, no duplicate cloud implementation of the reserved units. The coordinator's trailer is added only at squash-merge.
