-- Founding Beta access fixture for the local authenticated browser lane.
--
-- scripts/seed-dev.mjs applies this file with psql as postgres after its REST
-- seed, and only when both the API and the database targets are local. The
-- Founding Beta evidence tables are revoked from service_role and append-only,
-- so every statement is guarded and the file is safe to apply repeatedly.
--
--   Fixture Machine Co.  (uuid 1): enrolled; client.demo accepted the notice.
--   Outsider Fixture Co. (uuid 2): no Founding Beta rows (cross-org denial).
--   Unenrolled Fixture Co. (uuid 3): complimentary entitlement, no enrollment.

begin;

create temporary table beta_access_fixture on commit drop as
select
  '00000000-0000-4000-8000-000000000001'::uuid as enrolled_organization_id,
  '00000000-0000-4000-8000-000000000003'::uuid as unenrolled_organization_id,
  (select id from auth.users where email = 'admin.demo@overdrafter.local') as actor_user_id,
  (select id from auth.users where email = 'client.demo@overdrafter.local') as client_user_id,
  (select id from auth.users where email = 'unenrolled.demo@overdrafter.local') as unenrolled_user_id,
  private.current_founding_beta_notice() as notice;

do $$
begin
  if exists (
    select 1
    from beta_access_fixture
    where actor_user_id is null
      or client_user_id is null
      or unenrolled_user_id is null
  ) then
    raise exception 'beta-access fixture needs the seed-dev users; run the REST seed first.';
  end if;
end;
$$;

-- Grant enrollment unless the latest enrollment event is already a grant.
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision,
  terms_path, privacy_path, idempotency_key
)
select
  fixture.enrolled_organization_id,
  fixture.actor_user_id,
  'grant',
  'Local authenticated browser fixture',
  fixture.notice ->> 'policyRevision',
  fixture.notice ->> 'termsPath',
  fixture.notice ->> 'privacyPath',
  'seed-dev:enrolled-organization:grant:' || (
    select pg_catalog.count(*)
    from private.founding_beta_enrollment_events event_row
    where event_row.organization_id = fixture.enrolled_organization_id
  )
from beta_access_fixture fixture
where not exists (
  select 1
  from (
    select event_row.action
    from private.founding_beta_enrollment_events event_row
    where event_row.organization_id = fixture.enrolled_organization_id
    order by event_row.id desc
    limit 1
  ) latest
  where latest.action = 'grant'
);

insert into private.founding_beta_notice_acceptances (
  organization_id, user_id, policy_revision, terms_path, privacy_path
)
select
  fixture.enrolled_organization_id,
  fixture.client_user_id,
  fixture.notice ->> 'policyRevision',
  fixture.notice ->> 'termsPath',
  fixture.notice ->> 'privacyPath'
from beta_access_fixture fixture
where not exists (
  select 1
  from private.founding_beta_notice_acceptances acceptance
  where acceptance.organization_id = fixture.enrolled_organization_id
    and acceptance.user_id = fixture.client_user_id
    and acceptance.policy_revision = fixture.notice ->> 'policyRevision'
);

-- A billing entitlement alone must not open new-part intake.
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason,
  granted_by_user_id
)
select
  fixture.unenrolled_organization_id,
  'complimentary',
  pg_catalog.now() - interval '1 day',
  pg_catalog.now() + interval '365 days',
  'Local authenticated browser fixture',
  fixture.actor_user_id
from beta_access_fixture fixture
where not exists (
  select 1
  from private.organization_entitlement_grants grant_row
  where grant_row.organization_id = fixture.unenrolled_organization_id
    and grant_row.grant_type = 'complimentary'
    and grant_row.revoked_at is null
);

update private.commercial_rollout_controls
set enabled = true,
    revision = revision + 1,
    change_reason = 'Local authenticated browser fixture',
    updated_at = pg_catalog.now()
where capability = 'automatic_quote_collection'
  and not enabled;

do $$
declare
  v_enrolled_state text;
  v_unenrolled_state text;
begin
  select
    private.resolve_founding_beta_access_state(enrolled_organization_id, client_user_id) ->> 'state',
    private.resolve_founding_beta_access_state(unenrolled_organization_id, unenrolled_user_id) ->> 'state'
  into v_enrolled_state, v_unenrolled_state
  from beta_access_fixture;

  if v_enrolled_state is distinct from 'eligible' then
    raise exception 'beta-access fixture: client.demo is %, expected eligible.', v_enrolled_state;
  end if;

  if v_unenrolled_state is distinct from 'not_enrolled' then
    raise exception 'beta-access fixture: unenrolled.demo is %, expected not_enrolled.', v_unenrolled_state;
  end if;

  if not exists (
    select 1
    from private.commercial_rollout_controls
    where capability = 'automatic_quote_collection'
      and enabled
  ) then
    raise exception 'beta-access fixture: automatic_quote_collection rollout is not enabled.';
  end if;
end;
$$;

commit;
