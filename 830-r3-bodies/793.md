OVD-707 PR1 follow-up: apply the Q1/Q2/Q4 design decisions from the [Linear comment](https://linear.app/overdrafter/issue/OVD-707) to the providers-as-data **drafts**. No changes to `supabase/migrations/`; nothing applied anywhere real.

## Changes
- **Q2 four-eyes:** the dry-run recorder and the activator must not be revision contributors, and the activator must differ from the recorder. Violations raise `42501 four_eyes_required`. The only exception is the Q1 override. Suspend stays single-admin.
- **Q1 override:** `private.provider_definition_override_emails` holds Blaine only. The override needs verified auth, platform admin, AAL2 and a reason of at least 10 characters, and is audited.
- **Q4 seed:** only `liveAdapter: true` providers are seeded (fictiv, quickparts, weerg, xometry), as `approved` and never `active`. The drift test is updated to match.
- **Notes:** a Decisions section follows Q6. Promotion step 5 now reads "Resolve the remaining design questions (Q3, Q5, Q6); Q1, Q2 and Q4 are decided above." Step 6 adds the same-window activation runbook.
- **pgTAP:** the lifecycle suite grows from 80 to 104 assertions, with a case for each rule.

## Proof
- `npm run lint`: pass. `npm run typecheck`: pass.
- `npx vitest run --maxWorkers=2`: 584 files passed, 2 skipped, 1 failed. Tests: 11454 passed, 3 failed. All 3 failures are the known docker failures in `qualify-ovd417-four-migration-suffix` (docker is unavailable on this box).
- Local pgTAP on PostgreSQL 17 + pgTAP: 75/75 guards, 104/104 lifecycle. Drafts apply twice and rollbacks replay twice. Removing each new check makes the suite fail. CI `ovd707-pending-pgtap` is the authoritative run.
