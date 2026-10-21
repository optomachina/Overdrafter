# OVD-766 notes

PR #776 records the applied Oct 15 production window at its production migration
versions. The OVD-766 a-e and OVD-771 forward drafts and their pending tests are
promoted; the rollback scripts remain here for the documented window procedure.
They are no longer a pending draft family for the ephemeral-db rollback stage:
that stage pairs rollbacks with selected forward drafts, which no longer exist.

OVD-949 hardened the b/c/e rollbacks to restore the post-OVD-736 ACL
(`20261015074957`): PUBLIC and anon cannot execute the six affected functions;
authenticated and service_role retain EXECUTE. The rollback scripts retain their
inline ACL self-checks.

The OVD-949 pending `ovd766_rollback_acl` test is now
`supabase/tests/ovd766_rollback_acl.sql`, selected by the normal policy suite.
It applies the b/c/e rollback fixtures newest first twice and runs all 12 original
ACL assertions after each pass (24 assertions total). Fixture SQL mirrors the
retained rollback files with only top-level BEGIN/COMMIT wrappers removed so the
suite's outer transaction can roll back every change. The ephemeral-db contract
test checks fixture parity and that promotion leaves no orphaned 766/771 family.
This covers rollback ACLs, not a full-window rollback or DM-1R qualification;
production rollback still requires the separately authorized window procedure.
