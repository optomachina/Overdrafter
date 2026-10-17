# Migration immutability fixtures (OVD-871)

`_base/migrations/` holds a two-file migration history. The tests in
`scripts/check-migration-immutability.test.mjs` copy it into a scratch git repo
as `supabase/migrations/` (no fixture path contains that directory name, so the
migration guardrails never match a fixture), then apply each case on top.

`timeline.json` is a trimmed GitHub issue timeline: Blaine (`optomachina`)
applies `migration-edit-approved` at 2026-10-10T09:00:00Z.

`ci-job.draft.yml` is the proposed `migration-immutability` job for
`.github/workflows/ci.yml` (a card item, not wired into CI). The tests run its
step script against scratch repos so the draft keeps working.
