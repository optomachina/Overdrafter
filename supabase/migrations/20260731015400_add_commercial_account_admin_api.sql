-- OVD-233: add server-authoritative commercial-account search and detail.
--
-- Billing administrators may inspect commercial state at AAL1. Existing grant
-- and revoke mutations remain protected by billing_admin plus AAL2. The public
-- RPCs below are the only client-visible boundary; private commercial tables
-- and auth.users remain inaccessible.
--
-- Rollback: disable callers, revoke and drop the three new public RPCs, restore
-- api_admin_get_organization_entitlement_state from the preceding migration if
-- AAL2 reads are intentionally required again, then drop the private projection
-- helper. This migration creates no durable business rows and needs no data
-- rollback.

create or replace function private.get_commercial_account_entitlement_state(
  p_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_billing_account jsonb;
  v_effective jsonb;
  v_grants jsonb;
  v_subscriptions jsonb;
begin
  if p_organization_id is null
    or not exists (
      select 1
      from public.organizations organization_row
      where organization_row.id = p_organization_id
    )
  then
    raise exception 'Organization was not found.'; -- NOSONAR: stable API error
  end if;

  select pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'stripeCustomerId', billing_account.stripe_customer_id,
      'createdAt', billing_account.created_at, -- NOSONAR: stable JSON contract key
      'updatedAt', billing_account.updated_at
    )
  )
  into v_billing_account
  from private.organization_billing_accounts billing_account
  where billing_account.organization_id = p_organization_id;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'id', grant_row.id,
          'entitlementKey', grant_row.entitlement_key,
          'type', grant_row.grant_type,
          'startsAt', grant_row.starts_at,
          'expiresAt', grant_row.expires_at,
          'reviewAt', grant_row.review_at,
          'reason', grant_row.grant_reason,
          'grantedByUserId', grant_row.granted_by_user_id,
          'revokedAt', grant_row.revoked_at,
          'revokedByUserId', grant_row.revoked_by_user_id,
          'revocationReason', grant_row.revocation_reason,
          'createdAt', grant_row.created_at
        )
      )
      order by grant_row.created_at desc, grant_row.id desc
    ),
    '[]'::jsonb
  )
  into v_grants
  from private.organization_entitlement_grants grant_row
  where grant_row.organization_id = p_organization_id;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'id', subscription_row.id,
          'stripeSubscriptionId',
            subscription_row.stripe_subscription_id,
          'status', subscription_row.status,
          'billingInterval', subscription_row.billing_interval,
          'currentPeriodEnd', subscription_row.current_period_end,
          'pastDueSince', subscription_row.past_due_since,
          'cancelAtPeriodEnd',
            subscription_row.cancel_at_period_end,
          'stripeEventCreatedAt',
            subscription_row.stripe_event_created_at,
          'updatedAt', subscription_row.updated_at
        )
      )
      order by
        subscription_row.stripe_event_created_at desc,
        subscription_row.id desc
    ),
    '[]'::jsonb
  )
  into v_subscriptions
  from private.organization_subscription_projections subscription_row
  where subscription_row.organization_id = p_organization_id;

  v_effective := private.resolve_organization_entitlements_at(
    p_organization_id,
    pg_catalog.now()
  );
  v_effective := v_effective || pg_catalog.jsonb_build_object(
    'reviewDue',
    coalesce((v_effective ->> 'reviewDue')::boolean, false)
  );

  return pg_catalog.jsonb_build_object(
    'billingAccount', v_billing_account, -- NOSONAR: stable JSON contract key
    'effective', v_effective, -- NOSONAR: stable JSON contract key
    'grants', v_grants, -- NOSONAR: stable JSON contract key
    'subscriptions', v_subscriptions -- NOSONAR: stable JSON contract key
  );
end;
$$;

revoke all on function
  private.get_commercial_account_entitlement_state(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.api_admin_get_organization_entitlement_state(
  p_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to view commercial accounts.';
  end if;

  if not public.current_user_has_commercial_capability('billing_admin') then -- NOSONAR: explicit capability boundary
    raise exception 'You do not have the required commercial capability.'; -- NOSONAR: stable API error
  end if;

  return private.get_commercial_account_entitlement_state(
    p_organization_id
  );
end;
$$;

revoke all on function
  public.api_admin_get_organization_entitlement_state(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.api_admin_get_organization_entitlement_state(uuid)
  to authenticated;

create or replace function public.api_admin_search_commercial_accounts(
  p_search text default null,
  p_cursor text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_search text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_search, ''))
  );
  v_search_pattern text;
  v_cursor_payload jsonb;
  v_cursor_created_at timestamptz;
  v_cursor_id uuid;
  v_cursor_search_hash text;
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_created_at timestamptz;
  v_next_id uuid;
  v_next_cursor text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to search commercial accounts.';
  end if;

  if not public.current_user_has_commercial_capability('billing_admin') then
    raise exception 'You do not have the required commercial capability.';
  end if;

  if pg_catalog.length(v_search) > 320 then
    raise exception 'Commercial account search is too long.';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Commercial account page size must be between 1 and 100.';
  end if;

  v_search_pattern :=
    '%'
    || pg_catalog.replace(
      pg_catalog.replace(
        pg_catalog.replace(v_search, E'\\', E'\\\\'),
        '%',
        E'\\%'
      ),
      '_',
      E'\\_'
    )
    || '%';

  if nullif(pg_catalog.btrim(coalesce(p_cursor, '')), '') is not null then
    if pg_catalog.length(p_cursor) > 2000 then
      raise exception 'Commercial account cursor is invalid.'; -- NOSONAR: stable API error
    end if;

    begin
      v_cursor_payload := pg_catalog.convert_from(
        pg_catalog.decode(p_cursor, 'base64'), -- NOSONAR: stable cursor encoding
        'UTF8'
      )::jsonb;
      v_cursor_created_at :=
        (v_cursor_payload ->> 'createdAt')::timestamptz;
      v_cursor_id := (v_cursor_payload ->> 'id')::uuid;
      v_cursor_search_hash := v_cursor_payload ->> 'searchHash';
    exception
      when others then
        raise exception 'Commercial account cursor is invalid.';
    end;

    if v_cursor_created_at is null
      or v_cursor_id is null
      or v_cursor_search_hash is null
      or v_cursor_search_hash is distinct from pg_catalog.md5(v_search)
    then
      raise exception 'Commercial account cursor is invalid.';
    end if;
  end if;

  with page_keys as (
    select
      organization_row.id as organization_id,
      organization_row.created_at
    from public.organizations organization_row
    where (
      v_search = ''
      or pg_catalog.lower(organization_row.name)
        ilike v_search_pattern escape E'\\'
      or pg_catalog.lower(organization_row.slug)
        ilike v_search_pattern escape E'\\'
      or exists (
        select 1
        from public.organization_memberships matching_membership
        join auth.users matching_user
          on matching_user.id = matching_membership.user_id
        where matching_membership.organization_id = organization_row.id
          and pg_catalog.lower(matching_user.email)
            ilike v_search_pattern escape E'\\'
      )
    )
      and (
        v_cursor_created_at is null
        or (organization_row.created_at, organization_row.id)
          > (v_cursor_created_at, v_cursor_id)
      )
    order by organization_row.created_at asc, organization_row.id asc
    limit p_limit + 1
  ),
  projected as materialized (
    select
      organization_row.id as organization_id,
      organization_row.name as organization_name,
      organization_row.slug as organization_slug,
      organization_row.created_at,
      member_summary.member_count,
      member_summary.matching_member_emails,
      private.resolve_organization_entitlements_at(
        organization_row.id,
        pg_catalog.now()
      ) as effective,
      quote_summary.manual_request_count,
      quote_summary.automatic_request_count,
      quote_summary.active_manual_request_count,
      quote_summary.last_request_at
    from page_keys page_key
    join public.organizations organization_row
      on organization_row.id = page_key.organization_id
    cross join lateral (
      select
        pg_catalog.count(*)::integer as member_count,
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              matching_member.email
              order by pg_catalog.lower(matching_member.email)
            )
            from (
              select app_user.email
              from public.organization_memberships membership
              join auth.users app_user
                on app_user.id = membership.user_id
              where membership.organization_id = organization_row.id
                and v_search <> ''
                and pg_catalog.lower(app_user.email)
                  ilike v_search_pattern escape E'\\'
              order by pg_catalog.lower(app_user.email)
              limit 5
            ) matching_member
          ),
          '[]'::jsonb
        ) as matching_member_emails
      from public.organization_memberships membership
      where membership.organization_id = organization_row.id
    ) member_summary
    cross join lateral (
      select
        pg_catalog.count(*) filter (
          where request_row.request_mode = 'manual' -- NOSONAR: explicit quote mode
        )::integer as manual_request_count,
        pg_catalog.count(*) filter (
          where request_row.request_mode = 'automatic'
        )::integer as automatic_request_count,
        pg_catalog.count(*) filter (
          where request_row.request_mode = 'manual'
            and request_row.status in ('queued', 'requesting')
        )::integer as active_manual_request_count,
        pg_catalog.max(request_row.created_at) as last_request_at
      from public.quote_requests request_row
      where request_row.organization_id = organization_row.id
    ) quote_summary
    order by page_key.created_at asc, page_key.organization_id asc
  ),
  candidates as (
    select
      projected.organization_id,
      projected.organization_name,
      projected.organization_slug,
      projected.created_at,
      projected.member_count,
      projected.matching_member_emails,
      projected.effective || pg_catalog.jsonb_build_object(
        'reviewDue',
        coalesce((projected.effective ->> 'reviewDue')::boolean, false)
      ) as effective,
      projected.manual_request_count,
      projected.automatic_request_count,
      projected.active_manual_request_count,
      projected.last_request_at
    from projected
  ),
  numbered as (
    select
      candidate.*,
      pg_catalog.row_number() over (
        order by candidate.created_at asc, candidate.organization_id asc
      ) as row_number
    from candidates candidate
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'organizationId', numbered.organization_id, -- NOSONAR: stable JSON contract key
          'organizationName', numbered.organization_name,
          'organizationSlug', numbered.organization_slug,
          'createdAt', numbered.created_at,
          'memberCount', numbered.member_count,
          'matchingMemberEmails', numbered.matching_member_emails,
          'effective', numbered.effective,
          'quoteActivity',
            pg_catalog.jsonb_build_object(
              'manualRequestCount', numbered.manual_request_count,
              'automaticRequestCount', numbered.automatic_request_count,
              'activeManualRequestCount',
                numbered.active_manual_request_count,
              'lastRequestAt', numbered.last_request_at
            )
        )
        order by numbered.created_at asc, numbered.organization_id asc
      ) filter (where numbered.row_number <= p_limit),
      '[]'::jsonb
    ),
    pg_catalog.count(*) > p_limit,
    pg_catalog.max(numbered.created_at)
      filter (where numbered.row_number = p_limit),
    (
      pg_catalog.array_agg(numbered.organization_id)
        filter (where numbered.row_number = p_limit)
    )[1]
  into
    v_items,
    v_has_more,
    v_next_created_at,
    v_next_id
  from numbered;

  if v_has_more then
    v_next_cursor := pg_catalog.replace(
      pg_catalog.encode(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'createdAt', v_next_created_at,
            'id', v_next_id,
            'searchHash', pg_catalog.md5(v_search)
          )::text,
          'UTF8'
        ),
        'base64'
      ),
      E'\n',
      ''
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'items', v_items,
    'nextCursor', v_next_cursor
  );
end;
$$;

revoke all on function
  public.api_admin_search_commercial_accounts(text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.api_admin_search_commercial_accounts(text, text, integer)
  to authenticated;

create or replace function public.api_admin_get_commercial_account(
  p_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_organization jsonb;
  v_members jsonb;
  v_state jsonb;
  v_quote_activity jsonb;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to view commercial accounts.';
  end if;

  if not public.current_user_has_commercial_capability('billing_admin') then
    raise exception 'You do not have the required commercial capability.';
  end if;

  select pg_catalog.jsonb_build_object(
    'id', organization_row.id,
    'name', organization_row.name,
    'slug', organization_row.slug,
    'createdAt', organization_row.created_at
  )
  into v_organization
  from public.organizations organization_row
  where organization_row.id = p_organization_id;

  if v_organization is null then
    raise exception 'Organization was not found.';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'userId', membership.user_id,
        'email', app_user.email,
        'role', membership.role,
        'joinedAt', membership.created_at
      )
      order by
        pg_catalog.lower(app_user.email),
        membership.user_id
    ),
    '[]'::jsonb
  )
  into v_members
  from public.organization_memberships membership
  join auth.users app_user
    on app_user.id = membership.user_id
  where membership.organization_id = p_organization_id;

  v_state := private.get_commercial_account_entitlement_state(
    p_organization_id
  );

  select pg_catalog.jsonb_build_object(
    'manualRequestCount',
      pg_catalog.count(*) filter (
        where request_row.request_mode = 'manual'
      )::integer,
    'automaticRequestCount',
      pg_catalog.count(*) filter (
        where request_row.request_mode = 'automatic'
      )::integer,
    'activeManualRequestCount',
      pg_catalog.count(*) filter (
        where request_row.request_mode = 'manual'
          and request_row.status in ('queued', 'requesting')
      )::integer,
    'receivedRequestCount',
      pg_catalog.count(*) filter (
        where request_row.status = 'received'
      )::integer,
    'failedRequestCount',
      pg_catalog.count(*) filter (
        where request_row.status = 'failed'
      )::integer,
    'lastRequestAt', pg_catalog.max(request_row.created_at),
    'recentRequests',
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'requestId', recent_request.id,
              'jobId', recent_request.job_id,
              'jobTitle', recent_request.job_title,
              'requestMode', recent_request.request_mode,
              'status', recent_request.status,
              'createdAt', recent_request.created_at
            )
            order by recent_request.created_at desc, recent_request.id desc
          )
          from (
            select
              request_item.id,
              request_item.job_id,
              job_row.title as job_title,
              request_item.request_mode,
              request_item.status,
              request_item.created_at
            from public.quote_requests request_item
            join public.jobs job_row
              on job_row.id = request_item.job_id
            where request_item.organization_id = p_organization_id
            order by request_item.created_at desc, request_item.id desc
            limit 25
          ) recent_request
        ),
        '[]'::jsonb
      )
  )
  into v_quote_activity
  from public.quote_requests request_row
  where request_row.organization_id = p_organization_id;

  return pg_catalog.jsonb_build_object(
    'organization', v_organization,
    'members', v_members,
    'billingAccount', v_state -> 'billingAccount',
    'effective', v_state -> 'effective',
    'grants', v_state -> 'grants',
    'subscriptions', v_state -> 'subscriptions',
    'quoteActivity', v_quote_activity
  );
end;
$$;

revoke all on function
  public.api_admin_get_commercial_account(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.api_admin_get_commercial_account(uuid)
  to authenticated;

create or replace function public.api_admin_list_commercial_account_audit(
  p_organization_id uuid,
  p_cursor text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_cursor_payload jsonb;
  v_cursor_organization_id uuid;
  v_cursor_created_at timestamptz;
  v_cursor_id uuid;
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_created_at timestamptz;
  v_next_id uuid;
  v_next_cursor text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to view commercial account audit.';
  end if;

  if not public.current_user_has_commercial_capability('billing_admin') then
    raise exception 'You do not have the required commercial capability.';
  end if;

  if not exists (
    select 1
    from public.organizations organization_row
    where organization_row.id = p_organization_id
  ) then
    raise exception 'Organization was not found.';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Commercial account audit page size must be between 1 and 100.';
  end if;

  if nullif(pg_catalog.btrim(coalesce(p_cursor, '')), '') is not null then
    if pg_catalog.length(p_cursor) > 2000 then
      raise exception 'Commercial account audit cursor is invalid.'; -- NOSONAR: stable API error
    end if;

    begin
      v_cursor_payload := pg_catalog.convert_from(
        pg_catalog.decode(p_cursor, 'base64'),
        'UTF8'
      )::jsonb;
      v_cursor_organization_id :=
        (v_cursor_payload ->> 'organizationId')::uuid;
      v_cursor_created_at :=
        (v_cursor_payload ->> 'createdAt')::timestamptz;
      v_cursor_id := (v_cursor_payload ->> 'id')::uuid;
    exception
      when others then
        raise exception 'Commercial account audit cursor is invalid.';
    end;

    if v_cursor_organization_id is null
      or v_cursor_organization_id is distinct from p_organization_id
      or v_cursor_created_at is null
      or v_cursor_id is null
    then
      raise exception 'Commercial account audit cursor is invalid.';
    end if;
  end if;

  with candidates as (
    select
      event_row.id as event_id,
      event_row.organization_id,
      event_row.actor_user_id,
      actor_user.email as actor_email,
      event_row.action,
      event_row.target_type,
      event_row.target_id,
      event_row.reason,
      event_row.before_state,
      event_row.after_state,
      event_row.request_metadata,
      event_row.idempotency_key,
      event_row.created_at
    from public.commercial_admin_audit_events event_row
    left join auth.users actor_user
      on actor_user.id = event_row.actor_user_id
    where event_row.organization_id = p_organization_id
      and event_row.required_capability = 'billing_admin'
      and (
        v_cursor_created_at is null
        or (event_row.created_at, event_row.id)
          < (v_cursor_created_at, v_cursor_id)
      )
    order by event_row.created_at desc, event_row.id desc
    limit p_limit + 1
  ),
  numbered as (
    select
      candidate.*,
      pg_catalog.row_number() over (
        order by candidate.created_at desc, candidate.event_id desc
      ) as row_number
    from candidates candidate
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'eventId', numbered.event_id,
          'organizationId', numbered.organization_id,
          'actorUserId', numbered.actor_user_id,
          'actorEmail', numbered.actor_email,
          'action', numbered.action,
          'targetType', numbered.target_type,
          'targetId', numbered.target_id,
          'reason', numbered.reason,
          'beforeState', numbered.before_state,
          'afterState', numbered.after_state,
          'requestMetadata', numbered.request_metadata,
          'idempotencyKey', numbered.idempotency_key,
          'createdAt', numbered.created_at
        )
        order by numbered.created_at desc, numbered.event_id desc
      ) filter (where numbered.row_number <= p_limit),
      '[]'::jsonb
    ),
    pg_catalog.count(*) > p_limit,
    pg_catalog.min(numbered.created_at)
      filter (where numbered.row_number = p_limit),
    (
      pg_catalog.max(numbered.event_id::text)
        filter (where numbered.row_number = p_limit)
    )::uuid
  into
    v_items,
    v_has_more,
    v_next_created_at,
    v_next_id
  from numbered;

  if v_has_more then
    v_next_cursor := pg_catalog.replace(
      pg_catalog.encode(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'organizationId', p_organization_id,
            'createdAt', v_next_created_at,
            'id', v_next_id
          )::text,
          'UTF8'
        ),
        'base64'
      ),
      E'\n',
      ''
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'items', v_items,
    'nextCursor', v_next_cursor
  );
end;
$$;

revoke all on function
  public.api_admin_list_commercial_account_audit(uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.api_admin_list_commercial_account_audit(uuid, text, integer)
  to authenticated;
