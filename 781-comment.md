QA: PASS on 878827df
OVD-797 ACs: the disposable local PG17 fixture passed 80/80 (DM-1..DM-11 and DM-1R, empty pg_dump diff on rollback and on the replay). The MAJOR-1 read gap is closed: `jarvis_control_commands_select_own` is keyed on `conversation_id`, and the shared-run cases (ok 54-57) show neither user can see the other's commands on the same graph_run_id. No `supabase/migrations/` file is added. Review gate: Opus re-review APPROVED on the head (issuecomment-6209157557).
CI run 38858192816 green, and the pgTAP job in run 38858192765 is green; SonarCloud gate passed.
Proof re-run: `bash docs/migration-drafts/ovd-797-fixture.sh` at 878827df; runs 38858192816, 38858192765.
