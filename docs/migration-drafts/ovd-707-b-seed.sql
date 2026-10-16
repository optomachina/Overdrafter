-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-707 (PR 1 of 3, group b): one-time seed of provider-registry.v1.json
-- into private.provider_definitions as active, version 1.
--
-- DRAFT. NOT APPLIED. Apply after ovd-707-a.sql, in the same window and the
-- same migration. Rollback: docs/migration-drafts/ovd-707-b-seed.rollback.sql.
--
-- The rows below are generated from provider-integrations/provider-registry.v1.json
-- (admission = the registry entry, verbatim) and each provider's
-- manifest.v1.json (display name, official domains as host allowlist,
-- integration.adapterKind: api -> api, *_portal -> portal, guidance_only ->
-- manual). Regenerate them if the registry changes before promotion; see
-- ovd-707-notes.md (A5, Q4).
--
-- Seeded rows are grandfathered, not reviewed: the registry is today's
-- authority, so each row gets an approved revision with no proposer or
-- reviewer, a dry-run pass whose evidence reference names the registry, and
-- one 'seed' audit row with actor 'cli:ovd-707-seed'. Export jurisdiction
-- comes from private.export_control_provider_jurisdiction (OVD-723), and
-- export-controlled parts are not allowed for any seeded provider.
-- "Active" here does not admit or enable dispatch: admission policies,
-- permits and the kill switches still decide every dispatch.
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
    ('devzmanufacturing', 'DEVZ Manufacturing', 'manual', 'USD', array['devzmanufacturing.com']::text[], null,
     '{"key": "devzmanufacturing", "liveAdapter": false, "sessionSecrets": [], "egress": "none"}'::jsonb),
    ('emachineshop', 'eMachineShop', 'manual', 'USD', array['emachineshop.com']::text[], null,
     '{"key": "emachineshop", "liveAdapter": false, "sessionSecrets": [], "egress": "none"}'::jsonb),
    ('fabworks', 'Fabworks', 'portal', 'USD', array['fabworks.com']::text[], null,
     '{"key": "fabworks", "liveAdapter": false, "sessionSecrets": [], "egress": "none"}'::jsonb),
    ('fastdms', 'FastDMS', 'manual', 'USD', array['fastdms.com']::text[], null,
     '{"key": "fastdms", "liveAdapter": false, "sessionSecrets": [], "egress": "none"}'::jsonb),
    ('fictiv', 'Fictiv', 'portal', 'USD', array['fictiv.com']::text[], 'FICTIV_STORAGE_STATE_SECRET_NAME',
     '{"key": "fictiv", "liveAdapter": true, "sessionSecrets": [{"secretNameEnv": "FICTIV_STORAGE_STATE_SECRET_NAME", "mountEnv": "FICTIV_STORAGE_STATE_JSON", "requiredWhenListed": true}], "egress": "stable_nat", "adoptedAdapter": {"module": "worker/src/adapters/fictiv.ts", "defaultDenyTest": "worker/src/adapters/fictiv.test.ts"}}'::jsonb),
    ('geomiq', 'Geomiq', 'portal', 'USD', array['geomiq.com']::text[], null,
     '{"key": "geomiq", "liveAdapter": false, "sessionSecrets": [], "egress": "none"}'::jsonb),
    ('infraredlaboratories', 'Infrared Laboratories', 'manual', 'USD', array['irlabs.com']::text[], null,
     '{"key": "infraredlaboratories", "liveAdapter": false, "sessionSecrets": [], "egress": "none"}'::jsonb),
    ('oshcut', 'OSH Cut', 'portal', 'USD', array['oshcut.com']::text[], null,
     '{"key": "oshcut", "liveAdapter": false, "sessionSecrets": [], "egress": "none"}'::jsonb),
    ('partsbadger', 'PartsBadger', 'manual', 'USD', array['parts-badger.com']::text[], null,
     '{"key": "partsbadger", "liveAdapter": false, "sessionSecrets": [], "egress": "none"}'::jsonb),
    ('ponoko', 'Ponoko', 'portal', 'USD', array['ponoko.com']::text[], null,
     '{"key": "ponoko", "liveAdapter": false, "sessionSecrets": [], "egress": "none"}'::jsonb),
    ('protolabs', 'Protolabs', 'portal', 'USD', array['protolabs.com']::text[], null,
     '{"key": "protolabs", "liveAdapter": false, "sessionSecrets": [], "egress": "none"}'::jsonb),
    ('protolabsnetwork', 'Protolabs Network', 'portal', 'USD', array['hubs.com']::text[], null,
     '{"key": "protolabsnetwork", "liveAdapter": false, "sessionSecrets": [], "egress": "none"}'::jsonb),
    ('quickparts', 'Quickparts', 'portal', 'USD', array['quickparts.com']::text[], 'QUICKPARTS_STORAGE_STATE_SECRET_NAME',
     '{"key": "quickparts", "liveAdapter": true, "sessionSecrets": [{"secretNameEnv": "QUICKPARTS_STORAGE_STATE_SECRET_NAME", "mountPath": "/var/secrets/quickparts-storage-state/storage-state.json", "requiredWhenListed": true}], "egress": "stable_nat", "adoptedAdapter": {"module": "worker/src/adapters/quickpartsPortal.ts"}}'::jsonb),
    ('rapiddirect', 'RapidDirect', 'portal', 'USD', array['rapiddirect.com']::text[], null,
     '{"key": "rapiddirect", "liveAdapter": false, "sessionSecrets": [], "egress": "none"}'::jsonb),
    ('rmfg', 'RMFG', 'api', 'USD', array['rmfg.com']::text[], 'RMFG_API_KEY_SECRET_NAME',
     '{"key": "rmfg", "liveAdapter": false, "sessionSecrets": [{"secretNameEnv": "RMFG_API_KEY_SECRET_NAME", "mountEnv": "RMFG_API_KEY", "requiredWhenListed": true}], "egress": "none", "adapterKind": "api"}'::jsonb),
    ('sendcutsend', 'SendCutSend', 'portal', 'USD', array['sendcutsend.com']::text[], null,
     '{"key": "sendcutsend", "liveAdapter": false, "sessionSecrets": [], "egress": "none"}'::jsonb),
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
    set status = 'active',
        version = 1,
        approved_revision_id = v_revision_id,
        dry_run_passed_version = 1,
        dry_run_checked_at = pg_catalog.clock_timestamp(),
        dry_run_evidence_ref = 'seed:provider-registry.v1.json',
        updated_at = pg_catalog.clock_timestamp()
    where d.id = v_id
    returning d.* into v_def;

    insert into private.provider_audit_log (actor, actor_kind, provider_id, action, before, after, reason)
    values ('cli:ovd-707-seed', 'cli', v_id, 'seed', null, private.provider_definition_state(v_def),
      'OVD-707 one-time seed from provider-registry.v1.json');
  end loop;
end;
$seed$;
