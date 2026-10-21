-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- ovd: idempotent
-- OVD-707 (PR 1 of 3, group b): one-time seed of the live providers in
-- provider-registry.v1.json into private.provider_definitions as approved,
-- version 1 (not active).
--
-- DRAFT. NOT APPLIED. Apply after ovd-707-a.sql, in the same window and the
-- same migration. Rollback: docs/migration-drafts/ovd-707-b-seed.rollback.sql.
--
-- The rows below are generated from the liveAdapter: true entries of
-- provider-integrations/provider-registry.v1.json (admission = the registry
-- entry, verbatim) and each provider's
-- manifest.v1.json (display name, official domains as host allowlist,
-- integration.adapterKind: api -> api, *_portal -> portal, guidance_only ->
-- manual). Regenerate them if the registry changes before promotion; see
-- ovd-707-notes.md (A5, Q4).
--
-- Decided (ovd-707-notes.md, Q4): only liveAdapter: true entries are seeded,
-- and they land as approved, not active. Non-live entries are not seeded;
-- they go through create/submit/approve when needed. Seeded rows are
-- grandfathered through review only: the registry is today's authority, so
-- each row gets an approved revision with no proposer, reviewer or
-- contributors, and one 'seed' audit row with actor 'cli:ovd-707-seed'. No
-- dry run is recorded. Each provider is activated explicitly after a real dry
-- run, by two different admins (record_dry_run, then activate) or by Blaine
-- through the override. The service read fails closed, so the promotion
-- runbook must activate the live providers in the same window. Export
-- jurisdiction comes from private.export_control_provider_jurisdiction
-- (OVD-723), and export-controlled parts are not allowed for any seeded
-- provider.
--
-- Idempotent: a slug that already has a definition is skipped, so re-running
-- inserts nothing and writes no audit row.

do $seed$
declare
  v_row record;
  v_id uuid;
  v_revision_id uuid;
  v_def private.provider_definitions;
  v_jurisdiction text;
begin
  for v_row in
    select * from (values
    ('fictiv', 'Fictiv', 'portal', 'USD', array['fictiv.com']::text[], 'FICTIV_STORAGE_STATE_SECRET_NAME',
     '{"key": "fictiv", "liveAdapter": true, "sessionSecrets": [{"secretNameEnv": "FICTIV_STORAGE_STATE_SECRET_NAME", "mountEnv": "FICTIV_STORAGE_STATE_JSON", "requiredWhenListed": true}], "egress": "stable_nat", "adoptedAdapter": {"module": "worker/src/adapters/fictiv.ts", "defaultDenyTest": "worker/src/adapters/fictiv.test.ts"}}'::jsonb),
    ('quickparts', 'Quickparts', 'portal', 'USD', array['quickparts.com']::text[], 'QUICKPARTS_STORAGE_STATE_SECRET_NAME',
     '{"key": "quickparts", "liveAdapter": true, "sessionSecrets": [{"secretNameEnv": "QUICKPARTS_STORAGE_STATE_SECRET_NAME", "mountPath": "/var/secrets/quickparts-storage-state/storage-state.json", "requiredWhenListed": true}], "egress": "stable_nat", "adoptedAdapter": {"module": "worker/src/adapters/quickpartsPortal.ts"}}'::jsonb),
    ('weerg', 'Weerg', 'portal', 'EUR', array['weerg.com']::text[], 'WEERG_STORAGE_STATE_SECRET_NAME',
     '{"key": "weerg", "liveAdapter": true, "sessionSecrets": [{"secretNameEnv": "WEERG_STORAGE_STATE_SECRET_NAME", "mountPath": "/var/secrets/weerg-storage-state/storage-state.json", "requiredWhenListed": true}], "egress": "stable_nat"}'::jsonb),
    ('xometry', 'Xometry', 'portal', 'USD', array['xometry.com']::text[], 'XOMETRY_STORAGE_STATE_SECRET_NAME',
     '{"key": "xometry", "liveAdapter": true, "sessionSecrets": [{"secretNameEnv": "XOMETRY_STORAGE_STATE_SECRET_NAME", "mountEnv": "XOMETRY_STORAGE_STATE_JSON", "requiredWhenListed": false, "manualDeploy": true}], "egress": "stable_nat", "sessionlessJustification": "Xometry session binding is applied by the deploy script snapshot-or-secret path, not the generated helper."}'::jsonb)
    ) as seed(slug, display_name, kind, quote_currency, host_allowlist, credential_ref, admission)
    order by slug
  loop
    v_jurisdiction := private.export_control_provider_jurisdiction(v_row.slug);
    if v_jurisdiction not in ('us', 'foreign') then
      raise exception 'ovd707_seed_unknown_jurisdiction: %', v_row.slug;
    end if;

    insert into private.provider_definitions (
      slug, display_name, kind, quote_currency, host_allowlist, admission,
      credential_ref, export_jurisdiction, export_controlled_allowed)
    values (
      v_row.slug, v_row.display_name, v_row.kind, v_row.quote_currency, v_row.host_allowlist,
      v_row.admission, v_row.credential_ref, v_jurisdiction, false)
    on conflict (slug) do nothing
    returning * into v_def;

    continue when v_def.id is null;
    v_id := v_def.id;

    insert into private.provider_definition_revisions (
      definition_id, version, payload, proposed_by, contributors, reviewed_by, decision, decided_at,
      proposal_reason, decision_reason)
    values (
      v_id, 1, private.provider_definition_payload(v_def), null, '{}', null, 'approved',
      pg_catalog.clock_timestamp(), 'OVD-707 one-time seed from provider-registry.v1.json',
      'OVD-707 one-time seed from provider-registry.v1.json')
    returning id into v_revision_id;

    update private.provider_definitions d
    set status = 'approved',
        version = 1,
        approved_revision_id = v_revision_id,
        updated_at = pg_catalog.clock_timestamp()
    where d.id = v_id
    returning d.* into v_def;

    insert into private.provider_audit_log (actor, actor_kind, provider_id, action, before, after, reason)
    values ('cli:ovd-707-seed', 'cli', v_id, 'seed', null, private.provider_definition_state(v_def),
      'OVD-707 one-time seed from provider-registry.v1.json');
  end loop;
end;
$seed$;
