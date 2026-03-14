create or replace function public.api_get_client_intake_compatibility()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supports_current_create_job boolean :=
    to_regprocedure('public.api_create_job(uuid,text,text,text,text[],text[],text,text,integer[],date)') is not null;
  v_supports_legacy_create_job_v2 boolean :=
    to_regprocedure('public.api_create_job(uuid,text,text,text,text[],integer[],date)') is not null;
  v_supports_legacy_create_job_v1 boolean :=
    to_regprocedure('public.api_create_job(uuid,text,text,text,text[])') is not null;
  v_supports_legacy_create_job_v0 boolean :=
    to_regprocedure('public.api_create_job(uuid,text,text,text)') is not null;
  v_supports_current_create_client_draft boolean :=
    to_regprocedure('public.api_create_client_draft(text,text,uuid,text[],text[],text,text,integer[],date)') is not null;
  v_supports_legacy_create_client_draft_v1 boolean :=
    to_regprocedure('public.api_create_client_draft(text,text,uuid,text[],integer[],date)') is not null;
  v_supports_legacy_create_client_draft_v0 boolean :=
    to_regprocedure('public.api_create_client_draft(text,text,uuid,text[])') is not null;
  v_has_requested_service_kinds_column boolean :=
    exists(
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'jobs'
        and column_name = 'requested_service_kinds'
    );
  v_has_primary_service_kind_column boolean :=
    exists(
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'jobs'
        and column_name = 'primary_service_kind'
    );
  v_has_service_notes_column boolean :=
    exists(
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'jobs'
        and column_name = 'service_notes'
    );
  v_missing text[] := array[]::text[];
begin
  if not v_supports_current_create_job then
    v_missing := array_append(v_missing, 'public.api_create_job(uuid, text, text, text, text[], text[], text, text, integer[], date)');
  end if;

  if not v_supports_current_create_client_draft then
    v_missing := array_append(v_missing, 'public.api_create_client_draft(text, text, uuid, text[], text[], text, text, integer[], date)');
  end if;

  if not v_has_requested_service_kinds_column then
    v_missing := array_append(v_missing, 'public.jobs.requested_service_kinds');
  end if;

  if not v_has_primary_service_kind_column then
    v_missing := array_append(v_missing, 'public.jobs.primary_service_kind');
  end if;

  if not v_has_service_notes_column then
    v_missing := array_append(v_missing, 'public.jobs.service_notes');
  end if;

  return jsonb_build_object(
    'supportsCurrentCreateJob', v_supports_current_create_job,
    'supportsLegacyCreateJobV2', v_supports_legacy_create_job_v2,
    'supportsLegacyCreateJobV1', v_supports_legacy_create_job_v1,
    'supportsLegacyCreateJobV0', v_supports_legacy_create_job_v0,
    'supportsCurrentCreateClientDraft', v_supports_current_create_client_draft,
    'supportsLegacyCreateClientDraftV1', v_supports_legacy_create_client_draft_v1,
    'supportsLegacyCreateClientDraftV0', v_supports_legacy_create_client_draft_v0,
    'hasRequestedServiceKindsColumn', v_has_requested_service_kinds_column,
    'hasPrimaryServiceKindColumn', v_has_primary_service_kind_column,
    'hasServiceNotesColumn', v_has_service_notes_column,
    'missing', v_missing
  );
end;
$$;

grant execute on function public.api_get_client_intake_compatibility() to authenticated;
