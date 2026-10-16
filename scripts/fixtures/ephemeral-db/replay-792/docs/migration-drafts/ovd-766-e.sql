-- OVD-766 item E: who can edit a job (Blaine approved 2026-10-15).
-- Only the job owner (jobs.created_by) and explicitly added editors
-- (project_memberships role owner/editor on a project that contains the job)
-- can edit. Every other organization member is read-only.
-- Internal Overdrafter staff keep edit through user_can_edit_project's
-- is_internal_user branch for project jobs only.
-- Draft only: plain SQL, no transaction control, no psql meta-commands.
-- Promote with git mv into supabase/migrations in an approved window.

-- [header-only snapshot of docs/migration-drafts/ovd-766-e.sql at d2b7981b (#792); body omitted]
select 1;
