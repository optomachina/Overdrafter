import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const verifierPath = resolve(process.cwd(), 'scripts/verify-ovd373-production-postconditions.sql')
const verifierSql = readFileSync(verifierPath, 'utf8')
const rolloutVerifierPath = resolve(
  process.cwd(),
  'scripts/verify-ovd373-rollout-preconditions.sql',
)
const rolloutVerifierSql = readFileSync(rolloutVerifierPath, 'utf8')
const deploymentRunbook = readFileSync(
  resolve(process.cwd(), 'docs/workflows/ovd361-production-deployment.md'),
  'utf8',
)

const expectedMigrationVersions = [
  '20260330144838',
  '20260331000000',
  '20260331000001',
  '20260331010000',
  '20260402100000',
  '20260402120000',
  '20260403103000',
  '20260405103000',
  '20260406000000',
  '20260408120000',
  '20260408193000',
  '20260409000000',
  '20260514120000',
  '20260514120100',
  '20260725090000',
  '20260728190000',
  '20260731015300',
  '20260731015400',
  '20260815090000',
  '20260815093000',
  '20260815100000',
  '20260815184740',
  '20260816011204',
  '20260816015000',
  '20260816015500',
] as const

describe('OVD-373 hosted production postcondition verifier', () => {
  it('pins the complete final ledger while preserving the original production fingerprint', () => {
    expect(verifierSql).toContain('v_count <> 99')
    expect(verifierSql).toContain("v_head <> '20260816015500'")
    expect(verifierSql).toContain('003aabeb74c993bd942f5d59b29855ac')
    expect(verifierSql).toContain('7aeeca99fe188de2b537f14dd9c068fa')

    for (const version of expectedMigrationVersions) {
      expect(verifierSql).toContain(`'${version}'`)
    }
  })

  it('fails closed on founding-beta enrollment, notice, ACL, and creation boundaries', () => {
    for (const fragment of [
      'private.founding_beta_enrollment_events',
      'private.founding_beta_notice_acceptances',
      'private.reject_founding_beta_evidence_mutation()',
      'founding-beta-2026-08-15',
      'private.current_founding_beta_notice()',
      'private.resolve_founding_beta_access_state(uuid,uuid)',
      'public.current_user_has_current_founding_beta_access(uuid)',
      'public.api_accept_founding_beta_notice(uuid,text)',
      'public.api_admin_set_founding_beta_enrollment(uuid,boolean,text,text)',
      'public.api_create_job(uuid,text,text,text,text[],text[],text,text,integer[],date)',
      'public.api_create_client_draft(text,text,uuid,text[],text[],text,text,integer[],date)',
      'jobs_insert_members',
      'current_user_has_current_founding_beta_access',
      'select count(*) from private.founding_beta_enrollment_events',
      'select count(*) from private.founding_beta_notice_acceptances',
      'select count(*) from private.xometry_beta_dispatch_permits',
    ]) {
      expect(verifierSql).toContain(fragment)
    }

    expect(verifierSql).toContain("has_function_privilege('anon'")
    expect(verifierSql).toContain("has_function_privilege('authenticated'")
    expect(verifierSql).toContain("has_function_privilege('service_role'")
    expect(verifierSql).toContain("has_table_privilege('anon'")
    expect(verifierSql).toContain('forbidden legacy create overload remains')
    expect(verifierSql).toContain("pg_get_userbyid(p.proowner) = 'postgres'")
  })

  it('pins upload, storage binding, dispatch preflight, and deferred foundation safety', () => {
    for (const fragment of [
      'private.require_current_founding_beta_file_access(uuid,text)',
      'public.api_prepare_job_file_upload(uuid,text,public.job_file_kind,text,bigint,text)',
      'public.api_finalize_job_file_upload(uuid,text,text,text,public.job_file_kind,text,bigint,text)',
      'legacy_file_attach_unavailable',
      'job_files_storage_insert',
      'quote_artifacts_storage_read_drawing_previews',
      'storage_path%objects.name',
      'storage_bucket%objects.bucket_id',
      'private.xometry_beta_dispatch_permits',
      'public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)',
      'public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)',
      'private.current_founding_beta_notice',
      'private.resolve_founding_beta_access_state',
      'resolve_organization_entitlements_at',
      'automatic_quote_rollout_enabled_with_lock',
      'public.org_vendor_configs',
      'get_enabled_client_quote_vendors',
      'quote_scope_fingerprint',
      'xometry_beta_confirmation_required',
      'dispatch_confirmation_required',
      'public.evaluate_extraction_quality_alerts(date)',
      'extraction_quality_alerts_internal_select',
      'v_service_request_line_item_id uuid;',
      'request_service_request_line_item_id',
      'canonical_service_request_line_item_id',
      'vendor_routing_scores',
      'public.get_enabled_client_quote_vendors(uuid)',
      "array[''xometry'', ''fictiv'', ''protolabs'']",
      'payments service-only table contract drifted',
      'supplier directory became bound to quote execution',
      'mobile-auth service-only RPC contract drifted',
      'public.api_admin_list_manual_quote_requests(text,integer)',
      'public.api_admin_complete_manual_quote_request(uuid,uuid,uuid,uuid,public.vendor_name,text,text,public.vendor_status,text,text,text,jsonb,jsonb)',
    ]) {
      expect(verifierSql).toContain(fragment)
    }
  })

  it('requires every commercial rollout control to remain off', () => {
    for (const capability of [
      'automatic_quote_collection',
      'commercial_admin_mutations',
      'order_administration',
      'promotion_codes',
    ]) {
      expect(verifierSql).toContain(`'${capability}'`)
    }

    expect(verifierSql).toContain('v_enabled_count <> 0')
    expect(verifierSql).toContain('v_expected_count <> 4')
  })

  it('provides a separate read-only all-off guard before history repair or DDL', () => {
    for (const capability of [
      'automatic_quote_collection',
      'commercial_admin_mutations',
      'order_administration',
      'promotion_codes',
    ]) {
      expect(rolloutVerifierSql).toContain(`'${capability}'`)
    }

    expect(rolloutVerifierSql).toContain('v_count <> 4')
    expect(rolloutVerifierSql).toContain('v_enabled_count <> 0')
    expect(rolloutVerifierSql).toContain(
      'OVD-373 rollout precondition failed: % total, % recognized, % enabled',
    )
    expect(rolloutVerifierSql).toMatch(
      /v_count,\s*v_expected_count,\s*v_enabled_count;/,
    )
    expect(rolloutVerifierSql).toContain('OVD-373 rollout preconditions passed.')
    expect(rolloutVerifierSql).toContain('begin read only;')
    expect(rolloutVerifierSql).toContain('commit;')
    expect(rolloutVerifierSql).not.toMatch(
      /^\s*(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|call|copy)\b/gim,
    )
    expect(rolloutVerifierSql).not.toMatch(
      /\b(from|join)\s+(auth\.users|public\.|storage\.objects)\b/i,
    )
  })

  it('replays the all-off guard against the restored production backup', () => {
    const restoreDatabaseReference = deploymentRunbook.indexOf(
      '--dbname ovd361_restore_verify',
    )
    const restoredRolloutGuard = deploymentRunbook.indexOf(
      '--file /workspace/scripts/verify-ovd373-rollout-preconditions.sql',
      restoreDatabaseReference,
    )
    const governedUpgradeSection = deploymentRunbook.indexOf(
      '## Governed production upgrade',
    )

    expect(restoreDatabaseReference).toBeGreaterThanOrEqual(0)
    expect(restoredRolloutGuard).toBeGreaterThan(restoreDatabaseReference)
    expect(restoredRolloutGuard).toBeLessThan(governedUpgradeSection)
    expect(deploymentRunbook).toContain(
      'Require `OVD-372 production preconditions passed.` and\n`OVD-373 rollout preconditions passed.`',
    )
  })

  it('is a read-only catalog/control-registry verifier with fail-closed assertions', () => {
    expect(verifierSql).toContain('raise exception')
    expect(verifierSql).toContain('OVD-373 production postconditions passed.')
    expect(verifierSql).toContain('begin read only;')
    expect(verifierSql).toContain('commit;')

    expect(verifierSql).not.toMatch(
      /^\s*(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|call|copy|execute)\b/gim,
    )
    expect(verifierSql).not.toMatch(
      /\b(from|join)\s+(auth\.users|public\.(organizations|organization_members|jobs|job_files|quote_requests|quote_runs|quotes|uploaded_files)|storage\.objects)\b/i,
    )
    expect(verifierSql).not.toMatch(/\bperform\s+(public|private)\./i)
    expect(verifierSql).not.toMatch(/\bselect\s+.*\b(public|private)\.[a-z_]+\s*\(/i)

    const relationReferences = [...verifierSql.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)]
      .map((match) => match[1].toLowerCase())
    const allowedRelationReferences = new Set([
      'actual',
      'expected',
      'private.commercial_rollout_controls',
      'private.founding_beta_enrollment_events',
      'private.founding_beta_notice_acceptances',
      'private.xometry_beta_dispatch_permits',
      'supabase_migrations.schema_migrations',
    ])
    expect(
      relationReferences.filter(
        (relation) =>
          !relation.startsWith('pg_catalog.') && !allowedRelationReferences.has(relation),
      ),
    ).toEqual([])

    expect(verifierSql).toContain('from supabase_migrations.schema_migrations')
    expect(verifierSql).toContain('from pg_catalog.pg_proc')
    expect(verifierSql).toContain('from pg_catalog.pg_policies')
    expect(verifierSql).toContain('from private.commercial_rollout_controls')
  })
})
