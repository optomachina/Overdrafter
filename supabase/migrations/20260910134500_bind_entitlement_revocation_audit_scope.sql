-- OVD-504: recognize one server-built UUID scope without weakening free-text checks.
-- No data rewrite, API signature, grant, persisted scope or replay-key changes.
-- Rollback: forward-replace this function with its prior body, preserving audit history.

create or replace function private.append_commercial_admin_audit_event(
  p_organization_id uuid,
  p_required_capability text,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_reason text,
  p_before_state jsonb,
  p_after_state jsonb,
  p_request_metadata jsonb,
  p_idempotency_scope text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_event_id uuid;
begin
  perform private.require_commercial_admin_capability(p_required_capability);
  perform private.assert_safe_commercial_audit_value(
    pg_catalog.to_jsonb(p_action)
  );
  perform private.assert_safe_commercial_audit_value(
    pg_catalog.to_jsonb(p_target_type)
  );
  perform private.assert_safe_commercial_audit_value(
    pg_catalog.to_jsonb(p_target_id)
  );
  perform private.assert_safe_commercial_audit_value(
    pg_catalog.to_jsonb(p_reason)
  );
  perform private.assert_safe_commercial_audit_value(p_before_state);
  perform private.assert_safe_commercial_audit_value(p_after_state);
  perform private.assert_safe_commercial_audit_value(p_request_metadata);
  -- Only the exact server-owned revocation scope is structured data. Keep its
  -- persisted bytes and replay identity unchanged; never strip UUIDs from text.
  if p_required_capability = 'billing_admin'
    and p_action = 'commercial.entitlement.revoke'
    and p_target_type = 'organization_entitlement_grant'
    and p_target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and p_idempotency_scope = 'organization_entitlement_revoke:' || p_target_id
  then
    perform private.assert_safe_commercial_audit_value(
      pg_catalog.to_jsonb(p_target_id::uuid)
    );
  else
    perform private.assert_safe_commercial_audit_value(
      pg_catalog.to_jsonb(p_idempotency_scope)
    );
  end if;
  perform private.assert_safe_commercial_audit_value(
    pg_catalog.to_jsonb(p_idempotency_key)
  );

  insert into public.commercial_admin_audit_events (
    organization_id,
    actor_user_id,
    required_capability,
    action,
    target_type,
    target_id,
    reason,
    before_state,
    after_state,
    request_metadata,
    idempotency_scope,
    idempotency_key
  )
  values (
    p_organization_id,
    auth.uid(),
    p_required_capability,
    p_action,
    p_target_type,
    p_target_id,
    trim(p_reason),
    p_before_state,
    p_after_state,
    p_request_metadata,
    trim(p_idempotency_scope),
    trim(p_idempotency_key)
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

revoke all on function private.append_commercial_admin_audit_event(
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  text,
  text
) from public, anon, authenticated, service_role;
