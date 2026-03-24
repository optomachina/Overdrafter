create or replace view public.extraction_quality_summary as
with extraction_events as (
  select
    organization_id,
    timezone('utc', created_at)::date as day,
    payload
  from public.audit_events
  where event_type = 'worker.extraction_completed'
)
select
  organization_id,
  day,
  count(*)::integer as completed_extractions,
  count(*) filter (
    where coalesce((payload->>'autoApproved')::boolean, false)
  )::integer as auto_approved_extractions,
  count(*) filter (
    where payload->>'extractionStatus' = 'needs_review'
  )::integer as needs_review_extractions,
  count(*) filter (
    where payload->>'extractionLifecycle' = 'partial'
  )::integer as partial_lifecycle_extractions,
  count(*) filter (
    where coalesce((payload->>'warningCount')::integer, 0) > 0
  )::integer as warning_extractions,
  count(*) filter (
    where coalesce((payload->>'modelFallbackUsed')::boolean, false)
  )::integer as model_fallback_extractions,
  coalesce(
    round(
      (
        count(*) filter (where coalesce((payload->>'autoApproved')::boolean, false))::numeric
        / nullif(count(*)::numeric, 0)
      ),
      4
    ),
    0
  ) as auto_approve_rate,
  coalesce(
    round(
      (
        count(*) filter (where coalesce((payload->>'modelFallbackUsed')::boolean, false))::numeric
        / nullif(count(*)::numeric, 0)
      ),
      4
    ),
    0
  ) as model_fallback_rate
from extraction_events
group by organization_id, day;
