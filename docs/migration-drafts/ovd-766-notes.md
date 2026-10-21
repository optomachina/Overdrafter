# OVD-766 notes

Drafts `ovd-766-a.sql` through `ovd-766-e.sql` stay in `docs/migration-drafts/`. The rollback check is also covered by the ephemeral-db rollback stage (OVD-924), pending PR-2.
Rollbacks restore the post-736 ACL and self-check it; ovd766_rollback_acl runs after each rollback pass (OVD-949).
