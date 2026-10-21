-- OVD-949 / OVD-766: promoted rollback-ACL regression for the applied Oct 15 window.
-- Exercise only the ACL-restoring b/c/e rollbacks, newest first, twice.
-- Fixtures mirror the retained rollback SQL without transaction wrappers; this
-- test owns the transaction and leaves the applied schema intact. This is not
-- qualification or authorization for the full production-window rollback.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(24);

-- First rollback pass.
\ir fixtures/ovd766_e_rollback.inc
\ir fixtures/ovd766_c_rollback.inc
\ir fixtures/ovd766_b_rollback.inc
\ir fixtures/ovd766_rollback_acl.inc

-- Replay must preserve the same post-OVD-736 ACL.
\ir fixtures/ovd766_e_rollback.inc
\ir fixtures/ovd766_c_rollback.inc
\ir fixtures/ovd766_b_rollback.inc
\ir fixtures/ovd766_rollback_acl.inc

select * from finish();
rollback;
