-- OVD-707 (group b) ROLLBACK for docs/migration-drafts/ovd-707-b-seed.sql. Not a migration.
-- Apply: psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/migration-drafts/ovd-707-b-seed.rollback.sql
--
-- DRAFT. NOT APPLIED. Run before ovd-707-a.rollback.sql, only with Blaine's yes.
--
-- Removes the seeded definitions an admin never touched: rows whose only
-- audit entries are the seed's own. Any definition with an admin action is
-- kept and reported in a notice; undo those through the RPCs (retire) or the
-- group a rollback. Once the promotion runbook has recorded a dry run for and
-- activated a seeded live provider, that provider counts as admin-modified
-- and is kept. Each removal writes one 'seed_rollback' audit row; the
-- seed audit rows stay as evidence. The definition and revision delete guards
-- are disabled only for the removal inside this transaction, then restored.
-- Re-running finds nothing to remove and is a no-op. When ovd-707-a.sql is not
-- applied, it does nothing.

set local lock_timeout = '5s';

do $unseed$
declare
  v_kept text;
  v_def record;
begin
  if pg_catalog.to_regclass('private.provider_definitions') is null then
    return;
  end if;

  lock table private.provider_definitions, private.provider_definition_revisions,
    private.provider_audit_log in share row exclusive mode;

  select pg_catalog.string_agg(d.slug, ', ' order by d.slug) into v_kept
  from private.provider_definitions d
  where exists (select 1 from private.provider_audit_log a where a.provider_id = d.id and a.action = 'seed')
    and exists (select 1 from private.provider_audit_log a
                where a.provider_id = d.id and a.action not in ('seed', 'seed_rollback'));
  if v_kept is not null then
    raise notice 'OVD-707 seed rollback: keeping admin-modified seeded definitions: %', v_kept;
  end if;

  alter table private.provider_definitions disable trigger provider_definitions_no_delete;
  alter table private.provider_definition_revisions disable trigger provider_definition_revisions_guard;

  for v_def in
    select d.* from private.provider_definitions d
    where exists (select 1 from private.provider_audit_log a where a.provider_id = d.id and a.action = 'seed')
      and not exists (select 1 from private.provider_audit_log a
                      where a.provider_id = d.id and a.action not in ('seed', 'seed_rollback'))
    order by d.slug
    for update
  loop
    update private.provider_definitions set approved_revision_id = null, status = 'draft', version = 0,
      dry_run_passed_version = null
    where id = v_def.id;
    delete from private.provider_definition_revisions where definition_id = v_def.id;
    delete from private.provider_definitions where id = v_def.id;
    insert into private.provider_audit_log (actor, actor_kind, provider_id, action, before, after, reason)
    values ('cli:ovd-707-seed', 'cli', v_def.id, 'seed_rollback',
      pg_catalog.jsonb_build_object('slug', v_def.slug, 'status', v_def.status, 'version', v_def.version),
      null, 'OVD-707 seed rollback');
  end loop;

  alter table private.provider_definitions enable trigger provider_definitions_no_delete;
  alter table private.provider_definition_revisions enable trigger provider_definition_revisions_guard;
end;
$unseed$;
