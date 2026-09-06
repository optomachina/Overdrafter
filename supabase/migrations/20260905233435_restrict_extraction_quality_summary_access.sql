-- Extraction quality is privileged operational telemetry, not a customer API.
-- Preserve the view's columns and aggregate semantics, and the existing
-- service-only evaluator, while removing owner-rights access for client roles.
alter view public.extraction_quality_summary set (security_invoker = true);

revoke all on table public.extraction_quality_summary
from public, anon, authenticated;

grant select on table public.extraction_quality_summary to service_role;

-- Fail rather than silently accepting an unexpected inherited/column grant or
-- broadening access to the underlying audit ledger to repair monitoring.
do $$
begin
  if pg_catalog.has_any_column_privilege('anon', 'public.extraction_quality_summary', 'SELECT')
    or pg_catalog.has_any_column_privilege('authenticated', 'public.extraction_quality_summary', 'SELECT') then
    raise exception 'extraction_quality_summary_client_access_remains';
  end if;

  if not pg_catalog.has_table_privilege('service_role', 'public.audit_events', 'SELECT') then
    raise exception 'extraction_quality_summary_monitoring_access_missing';
  end if;
end;
$$;

-- Rollback must retain denied client access. Fix monitoring forward with a
-- reviewed change; do not restore the historical public/client grants.
