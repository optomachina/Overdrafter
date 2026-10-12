-- OVD-736 DRAFT (optional): stop new public functions from defaulting to anon/PUBLIC EXECUTE.
-- Prod pg_default_acl today grants anon=X for functions created by postgres and supabase_admin in public.
-- supabase_admin's default ACL may only be alterable by Supabase; verify in the window.
-- Rollback: alter default privileges for role postgres in schema public grant execute on functions to public, anon;
begin;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;
alter default privileges for role postgres revoke execute on functions from public;
commit;
