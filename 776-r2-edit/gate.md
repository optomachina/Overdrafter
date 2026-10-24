## Gate change review

This PR loosens or edits gates. Declared by hand: `validate-pr-body.mjs` in CI mode (`--skip-unless-enabling --verify-links`) reports "No provider enablement or gate edit in this diff", because its gate list (`GATE_FILES` in `scripts/provider-enablement-detect.mjs`) covers only the PR body gate's own files, not Sonar settings or workflow deletions.

gate_loosening: detected (declared manually)
- `.sonarcloud.properties` (M): adds `supabase/migrations/20261015221725_ovd771_service_kill_switch.sql` and `supabase/migrations/20261016000156_ovd767_admin_write_aal2_guards.sql` to `sonar.cpd.exclusions`.
- `.github/workflows/ovd766-pending-pgtap.yml` (D): deletes the draft-only pending pgTAP workflow. (Opus @9489b783 judged this deletion "not a loosening" because its suites moved into the main pgTAP job; it is declared here as a gate edit anyway.)
- requires: grokbot_countersign + blaine_card

Reviewer: PENDING Blaine (card). Not reviewed or approved yet.
- "Approved by Blaine" note for the CPD exclusion: **pending Blaine**, not filled in.
- `migration-edit-approved` label for the OVD-736 rename: **pending Blaine**, not added.

Evidence: Opus review calling out the gate loosening, https://github.com/optomachina/Overdrafter/pull/776#issuecomment-6229492279; rollbacks for both are in Rollback / risk notes.
