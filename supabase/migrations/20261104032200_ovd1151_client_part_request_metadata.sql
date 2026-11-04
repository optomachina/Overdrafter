-- OVD-1151: return each part's client-visible RFQ details with the client part
-- metadata. The part request editor builds its draft from this projection and
-- could not see them, so a full "Save request details" resent shipping,
-- certification, sourcing and release values empty and
-- api_update_client_part_request overwrote the saved ones with null.
-- Only the public verified-auth wrapper changes. The private body (and the
-- OVD-978 draft that supersedes it) is untouched; its rows are already limited
-- to jobs the caller may access, and each row is joined to its own part only.
-- Exactly the keys api_update_client_part_request writes are projected; the
-- internal-only release.reviewDisposition, release.quoteBlockedUntilRelease and
-- shipping.requestedByDateOverride never are.
-- Apply as one transaction after 20261101130300.
-- Production apply follows merge and requires the authorized migration window.
-- Rollback: docs/migration-drafts/ovd-1151.rollback.sql.

set local lock_timeout = '5s';

do $ovd1151_guard$
declare
  v_md5 text;
begin
  select pg_catalog.md5(p.prosrc) into v_md5
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure('public.api_list_client_part_metadata(uuid[])');
  if v_md5 is null or v_md5 not in ('9127a3995b7bb5fc089ea4fa91525652', 'a195ef0e6fa0d766369b404638832123') then
    raise exception 'OVD-1151 refused: public.api_list_client_part_metadata(uuid[]) has an unexpected body'
      using errcode = '55000';
  end if;
end;
$ovd1151_guard$;

create or replace function public.api_list_client_part_metadata(p_job_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_verified_auth();
  return coalesce((
    select pg_catalog.jsonb_agg(
      item.value || pg_catalog.jsonb_build_object('requestMetadata', pg_catalog.jsonb_build_object(
        'shipping', pg_catalog.jsonb_build_object(
          'packagingNotes', requirement.spec_snapshot #> '{shipping,packagingNotes}',
          'shippingNotes', requirement.spec_snapshot #> '{shipping,shippingNotes}'
        ),
        'certifications', pg_catalog.jsonb_build_object(
          'requiredCertifications', requirement.spec_snapshot #> '{certifications,requiredCertifications}',
          'materialCertificationRequired', requirement.spec_snapshot #> '{certifications,materialCertificationRequired}',
          'certificateOfConformanceRequired', requirement.spec_snapshot #> '{certifications,certificateOfConformanceRequired}',
          'inspectionLevel', requirement.spec_snapshot #> '{certifications,inspectionLevel}',
          'notes', requirement.spec_snapshot #> '{certifications,notes}'
        ),
        'sourcing', pg_catalog.jsonb_build_object(
          'regionPreferenceOverride', requirement.spec_snapshot #> '{sourcing,regionPreferenceOverride}',
          'preferredSuppliers', requirement.spec_snapshot #> '{sourcing,preferredSuppliers}',
          'materialProvisioning', requirement.spec_snapshot #> '{sourcing,materialProvisioning}',
          'notes', requirement.spec_snapshot #> '{sourcing,notes}'
        ),
        'release', pg_catalog.jsonb_build_object(
          'releaseStatus', requirement.spec_snapshot #> '{release,releaseStatus}',
          'notes', requirement.spec_snapshot #> '{release,notes}'
        )
      ))
      order by item.ordinality
    )
    from pg_catalog.jsonb_array_elements(private.api_list_client_part_metadata(p_job_ids))
      with ordinality as item(value, ordinality)
    left join public.approved_part_requirements requirement
      on requirement.part_id = (item.value ->> 'partId')::uuid
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.api_list_client_part_metadata(uuid[]) from public, anon;
grant execute on function public.api_list_client_part_metadata(uuid[]) to authenticated, service_role;
