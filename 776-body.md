This brings the repo in line with prod after the approved window of 2026-10-15. Prod and repo now both have 159 migrations.

Prod versions (the files are named to match):
- 20261015214135 ovd768_admin_list_guards (#753)
- 20261015221725 ovd771_service_kill_switch (#765)
- 20261016000156 ovd767_admin_write_aal2_guards (#754)
- 20261016002932 ovd769_reconcile_job_parts_guard (#755). Prod bytes have begin/commit stripped.
- 20261016004826 ovd770_quote_select_editor_guard (#756). Prod bytes have begin/commit stripped.
- 20261016013742 ovd736_revoke_anon_definer_execute (#766, renamed from 20261015074957; free-quote CI fixture paths updated)
- 20261016013832 ovd766e_job_editor_scope (#773, item E)

The pending pgTAP files move into supabase/tests. The draft-only workflow ovd766-pending-pgtap.yml is removed. Rollbacks stay in docs/migration-drafts/*.rollback.sql. Rollback order: e, 736, d, c, a, 771 (before any 722 rollback), b.

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **Bug Fixes**
  * Quote and job-part actions now require appropriate edit permissions. Members who can only view a job, or whose accounts are unverified, are denied these actions.
* **Changes**
  * Provider session leasing is now enabled by default for Cloud Run deployments. Deployments use a default namespace-key secret, and the lease can still be explicitly disabled.
* **Chores**
  * Removed the automated workflow for applying pending database migrations and running their associated tests.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->