-- Private persistence boundary for the website-mediated iOS authentication bridge.
--
-- Raw state, PKCE verifiers, handoff codes, cookies, CSRF values, access tokens,
-- and refresh tokens never cross this database boundary. The server supplies
-- keyed digests and authenticated-encryption envelopes produced with keys held
-- outside Postgres.

create schema if not exists private;

create table private.mobile_auth_transactions (
  id uuid primary key,
  trace_id uuid not null unique,
  contract_version smallint not null,
  status text not null default 'authenticating',
  row_version bigint not null default 1,
  crypto_key_version integer not null,
  state_digest text not null unique,
  state_envelope text,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  browser_binding_digest text not null,
  csrf_digest text not null,
  ceremony_storage_key text not null,
  provider_callback_path text not null,
  callback_origin text not null,
  callback_path text not null,
  return_to text not null,
  handoff_digest text,
  session_envelope text,
  verified_user_id uuid references auth.users(id) on delete cascade,
  source_session_id uuid,
  failure_code text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  browser_expires_at timestamptz not null,
  completed_at timestamptz,
  handoff_expires_at timestamptz,
  consumed_at timestamptz,
  revoked_at timestamptz,
  constraint mobile_auth_transactions_contract_version_check
    check (contract_version = 1),
  constraint mobile_auth_transactions_status_check
    check (
      status in (
        'created',
        'authenticating',
        'verifying',
        'completed',
        'consumed',
        'failed',
        'expired',
        'cancelled',
        'revoked'
      )
    ),
  constraint mobile_auth_transactions_row_version_check
    check (row_version > 0),
  constraint mobile_auth_transactions_crypto_key_version_check
    check (crypto_key_version > 0),
  constraint mobile_auth_transactions_state_digest_check
    check (state_digest ~ '^[A-Za-z0-9_-]{43}$'),
  constraint mobile_auth_transactions_handoff_digest_check
    check (
      handoff_digest is null
      or handoff_digest ~ '^[A-Za-z0-9_-]{43}$'
    ),
  constraint mobile_auth_transactions_browser_binding_digest_check
    check (browser_binding_digest ~ '^[A-Za-z0-9_-]{43}$'),
  constraint mobile_auth_transactions_csrf_digest_check
    check (csrf_digest ~ '^[A-Za-z0-9_-]{43}$'),
  constraint mobile_auth_transactions_code_challenge_check
    check (
      code_challenge_method = 'S256'
      and code_challenge ~ '^[A-Za-z0-9_-]{43}$'
    ),
  constraint mobile_auth_transactions_state_envelope_check
    check (
      state_envelope is null
      or (
        octet_length(state_envelope) between 32 and 4096
        and state_envelope ~ '^[A-Za-z0-9._~-]+$'
      )
    ),
  constraint mobile_auth_transactions_session_envelope_check
    check (
      session_envelope is null
      or (
        octet_length(session_envelope) between 32 and 32768
        and session_envelope ~ '^[A-Za-z0-9._~-]+$'
      )
    ),
  constraint mobile_auth_transactions_storage_key_check
    check (
      octet_length(ceremony_storage_key) between 8 and 160
      and ceremony_storage_key ~ '^[A-Za-z0-9:._-]+$'
    ),
  constraint mobile_auth_transactions_provider_callback_path_check
    check (provider_callback_path = '/auth/mobile/provider-callback'),
  constraint mobile_auth_transactions_callback_path_check
    check (callback_path = '/auth/mobile/callback'),
  constraint mobile_auth_transactions_callback_origin_check
    check (
      callback_origin ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'
      or callback_origin ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]{1,5})?$'
    ),
  constraint mobile_auth_transactions_return_to_check
    check (
      return_to ~ '^/(parts(/[A-Za-z0-9_-]+)?|quotes(/[A-Za-z0-9_-]+)?|search|projects/[A-Za-z0-9_-]+)$'
    ),
  constraint mobile_auth_transactions_browser_expiry_check
    check (
      browser_expires_at > created_at
      and browser_expires_at <= created_at + interval '10 minutes'
    ),
  constraint mobile_auth_transactions_handoff_expiry_check
    check (
      handoff_expires_at is null
      or (
        completed_at is not null
        and handoff_expires_at > completed_at
        and handoff_expires_at <= completed_at + interval '120 seconds'
      )
    ),
  constraint mobile_auth_transactions_completion_fields_check
    check (
      handoff_digest is null
      or (
        completed_at is not null
        and handoff_expires_at is not null
        and verified_user_id is not null
        and source_session_id is not null
      )
    ),
  constraint mobile_auth_transactions_envelope_state_check
    check (
      (
        status in ('created', 'authenticating', 'verifying')
        and state_envelope is not null
        and session_envelope is null
        and handoff_digest is null
        and completed_at is null
        and handoff_expires_at is null
        and verified_user_id is null
        and source_session_id is null
      )
      or (
        status = 'completed'
        and state_envelope is null
        and session_envelope is not null
        and handoff_digest is not null
        and completed_at is not null
        and handoff_expires_at is not null
        and verified_user_id is not null
        and source_session_id is not null
      )
      or (
        status in ('consumed', 'failed', 'expired', 'cancelled', 'revoked')
        and state_envelope is null
        and session_envelope is null
      )
    ),
  constraint mobile_auth_transactions_consumed_at_check
    check (
      (status = 'consumed' and consumed_at is not null)
      or (status <> 'consumed' and consumed_at is null)
    ),
  constraint mobile_auth_transactions_revoked_at_check
    check (
      (status = 'revoked' and revoked_at is not null)
      or (status <> 'revoked' and revoked_at is null)
    ),
  constraint mobile_auth_transactions_failure_code_check
    check (
      failure_code is null
      or failure_code in (
        'mobile_auth_cancelled',
        'mobile_auth_invalid_request',
        'mobile_auth_provider_failed',
        'mobile_auth_network_failed',
        'mobile_auth_state_mismatch',
        'mobile_auth_expired',
        'mobile_auth_replayed',
        'mobile_auth_pkce_failed',
        'mobile_auth_session_invalid',
        'mobile_auth_bootstrap_failed',
        'mobile_auth_logout_failed',
        'mobile_auth_rate_limited',
        'mobile_auth_service_unavailable'
      )
    ),
  constraint mobile_auth_transactions_failure_status_check
    check (
      (
        status in ('created', 'authenticating', 'verifying', 'completed', 'consumed')
        and failure_code is null
      )
      or (
        status in ('failed', 'expired', 'cancelled', 'revoked')
        and failure_code is not null
      )
    )
);

create table private.mobile_auth_rate_limit_counters (
  scope text not null,
  key_version integer not null,
  key_digest text not null,
  window_started_at timestamptz not null,
  window_seconds integer not null,
  limit_value integer not null,
  attempt_count integer not null,
  expires_at timestamptz not null,
  constraint mobile_auth_rate_limit_counters_pkey
    primary key (scope, key_version, key_digest, window_started_at, window_seconds),
  constraint mobile_auth_rate_limit_counters_scope_check
    check (scope in ('start_ip', 'bootstrap_ip', 'bootstrap_handoff')),
  constraint mobile_auth_rate_limit_counters_key_version_check
    check (key_version > 0),
  constraint mobile_auth_rate_limit_counters_key_digest_check
    check (key_digest ~ '^[A-Za-z0-9_-]{43}$'),
  constraint mobile_auth_rate_limit_counters_window_seconds_check
    check (window_seconds between 1 and 86400),
  constraint mobile_auth_rate_limit_counters_limit_check
    check (limit_value between 1 and 10000),
  constraint mobile_auth_rate_limit_counters_attempt_count_check
    check (attempt_count between 1 and 10001),
  constraint mobile_auth_rate_limit_counters_expiry_check
    check (
      expires_at
      = window_started_at + make_interval(secs => window_seconds)
    )
);

create table private.mobile_auth_audit_events (
  id bigint generated always as identity primary key,
  trace_id uuid not null,
  event_type text not null,
  contract_version smallint not null,
  environment text not null,
  failure_code text,
  duration_bucket text,
  app_version text,
  os_version text,
  created_at timestamptz not null default statement_timestamp(),
  constraint mobile_auth_audit_events_event_type_check
    check (
      event_type in (
        'start_accepted',
        'start_rejected',
        'browser_auth_completed',
        'browser_auth_failed',
        'handoff_created',
        'bootstrap_accepted',
        'bootstrap_rejected',
        'replay_detected',
        'logout_requested',
        'logout_completed',
        'session_restoration_succeeded',
        'session_restoration_failed'
      )
    ),
  constraint mobile_auth_audit_events_contract_version_check
    check (contract_version between 1 and 32767),
  constraint mobile_auth_audit_events_environment_check
    check (environment in ('test', 'local', 'preview', 'production')),
  constraint mobile_auth_audit_events_failure_code_check
    check (
      failure_code is null
      or failure_code in (
        'mobile_auth_cancelled',
        'mobile_auth_invalid_request',
        'mobile_auth_provider_failed',
        'mobile_auth_network_failed',
        'mobile_auth_state_mismatch',
        'mobile_auth_expired',
        'mobile_auth_replayed',
        'mobile_auth_pkce_failed',
        'mobile_auth_session_invalid',
        'mobile_auth_bootstrap_failed',
        'mobile_auth_logout_failed',
        'mobile_auth_rate_limited',
        'mobile_auth_service_unavailable'
      )
    ),
  constraint mobile_auth_audit_events_duration_bucket_check
    check (
      duration_bucket is null
      or duration_bucket in (
        'lt_100ms',
        '100_499ms',
        '500_1999ms',
        '2_9s',
        '10_59s',
        '1_9m',
        'gte_10m'
      )
    ),
  constraint mobile_auth_audit_events_app_version_check
    check (
      app_version is null
      or (
        octet_length(app_version) between 1 and 64
        and app_version !~ '[[:cntrl:]]'
      )
    ),
  constraint mobile_auth_audit_events_os_version_check
    check (
      os_version is null
      or (
        octet_length(os_version) between 1 and 64
        and os_version !~ '[[:cntrl:]]'
      )
    )
);

create unique index mobile_auth_transactions_handoff_digest_idx
  on private.mobile_auth_transactions (handoff_digest)
  where handoff_digest is not null;

create index mobile_auth_transactions_browser_expiry_idx
  on private.mobile_auth_transactions (browser_expires_at)
  where status in ('created', 'authenticating', 'verifying');

create index mobile_auth_transactions_handoff_expiry_idx
  on private.mobile_auth_transactions (handoff_expires_at)
  where status = 'completed';

create index mobile_auth_transactions_terminal_retention_idx
  on private.mobile_auth_transactions (updated_at)
  where status in ('consumed', 'failed', 'expired', 'cancelled', 'revoked');

create index mobile_auth_transactions_verified_user_idx
  on private.mobile_auth_transactions (verified_user_id)
  where verified_user_id is not null;

create index mobile_auth_rate_limit_counters_expiry_idx
  on private.mobile_auth_rate_limit_counters (expires_at);

create index mobile_auth_audit_events_trace_created_idx
  on private.mobile_auth_audit_events (trace_id, created_at);

create index mobile_auth_audit_events_created_idx
  on private.mobile_auth_audit_events (created_at);

alter table private.mobile_auth_transactions enable row level security;
alter table private.mobile_auth_transactions force row level security;
alter table private.mobile_auth_rate_limit_counters enable row level security;
alter table private.mobile_auth_rate_limit_counters force row level security;
alter table private.mobile_auth_audit_events enable row level security;
alter table private.mobile_auth_audit_events force row level security;

revoke all on private.mobile_auth_transactions
  from public, anon, authenticated, service_role;
revoke all on private.mobile_auth_rate_limit_counters
  from public, anon, authenticated, service_role;
revoke all on private.mobile_auth_audit_events
  from public, anon, authenticated, service_role;
revoke all on sequence private.mobile_auth_audit_events_id_seq
  from public, anon, authenticated, service_role;

create or replace function public.api_mobile_auth_create_transaction(
  p_transaction_id uuid,
  p_trace_id uuid,
  p_contract_version smallint,
  p_crypto_key_version integer,
  p_state_digest text,
  p_state_envelope text,
  p_code_challenge text,
  p_browser_binding_digest text,
  p_csrf_digest text,
  p_ceremony_storage_key text,
  p_provider_callback_path text,
  p_callback_origin text,
  p_callback_path text,
  p_return_to text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_browser_expires_at timestamptz := v_now + interval '10 minutes';
begin
  insert into private.mobile_auth_transactions (
    id,
    trace_id,
    contract_version,
    status,
    row_version,
    crypto_key_version,
    state_digest,
    state_envelope,
    code_challenge,
    code_challenge_method,
    browser_binding_digest,
    csrf_digest,
    ceremony_storage_key,
    provider_callback_path,
    callback_origin,
    callback_path,
    return_to,
    created_at,
    updated_at,
    browser_expires_at
  )
  values (
    p_transaction_id,
    p_trace_id,
    p_contract_version,
    'authenticating',
    1,
    p_crypto_key_version,
    p_state_digest,
    p_state_envelope,
    p_code_challenge,
    'S256',
    p_browser_binding_digest,
    p_csrf_digest,
    p_ceremony_storage_key,
    p_provider_callback_path,
    p_callback_origin,
    p_callback_path,
    p_return_to,
    v_now,
    v_now,
    v_browser_expires_at
  );

  return jsonb_build_object(
    'created', true,
    'transactionId', p_transaction_id,
    'traceId', p_trace_id,
    'rowVersion', 1,
    'browserExpiresAt', v_browser_expires_at
  );
end;
$$;

create or replace function public.api_mobile_auth_get_browser_transaction(
  p_transaction_id uuid,
  p_browser_binding_digests text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.mobile_auth_transactions%rowtype;
begin
  if p_browser_binding_digests is null
    or cardinality(p_browser_binding_digests) not between 1 and 8
    or exists (
      select 1
      from unnest(p_browser_binding_digests) candidate(digest)
      where candidate.digest is null
        or candidate.digest !~ '^[A-Za-z0-9_-]{43}$'
    )
  then
    raise exception 'Mobile authentication browser lookup candidates are invalid.';
  end if;

  select transaction_row.*
  into v_row
  from private.mobile_auth_transactions transaction_row
  where transaction_row.id = p_transaction_id
    and transaction_row.browser_binding_digest = any(p_browser_binding_digests)
    and transaction_row.status in ('created', 'authenticating')
    and transaction_row.browser_expires_at > statement_timestamp();

  if v_row.id is null then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'transactionId', v_row.id,
    'traceId', v_row.trace_id,
    'rowVersion', v_row.row_version,
    'contractVersion', v_row.contract_version,
    'cryptoKeyVersion', v_row.crypto_key_version,
    'browserBindingDigest', v_row.browser_binding_digest,
    'stateEnvelope', v_row.state_envelope,
    'codeChallenge', v_row.code_challenge,
    'codeChallengeMethod', v_row.code_challenge_method,
    'csrfDigest', v_row.csrf_digest,
    'ceremonyStorageKey', v_row.ceremony_storage_key,
    'providerCallbackPath', v_row.provider_callback_path,
    'callbackOrigin', v_row.callback_origin,
    'callbackPath', v_row.callback_path,
    'returnTo', v_row.return_to,
    'browserExpiresAt', v_row.browser_expires_at
  );
end;
$$;

create or replace function public.api_mobile_auth_claim_completion(
  p_transaction_id uuid,
  p_expected_version bigint,
  p_browser_binding_digest text,
  p_csrf_digest text,
  p_crypto_key_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_row private.mobile_auth_transactions%rowtype;
begin
  update private.mobile_auth_transactions transaction_row
  set
    status = 'verifying',
    row_version = transaction_row.row_version + 1,
    updated_at = v_now
  where transaction_row.id = p_transaction_id
    and transaction_row.row_version = p_expected_version
    and transaction_row.browser_binding_digest = p_browser_binding_digest
    and transaction_row.csrf_digest = p_csrf_digest
    and transaction_row.crypto_key_version = p_crypto_key_version
    and transaction_row.status in ('created', 'authenticating')
    and transaction_row.browser_expires_at > v_now
  returning transaction_row.* into v_row;

  if v_row.id is null then
    return jsonb_build_object('claimed', false);
  end if;

  return jsonb_build_object(
    'claimed', true,
    'transactionId', v_row.id,
    'traceId', v_row.trace_id,
    'rowVersion', v_row.row_version
  );
end;
$$;

create or replace function public.api_mobile_auth_complete_transaction(
  p_transaction_id uuid,
  p_expected_version bigint,
  p_browser_binding_digest text,
  p_csrf_digest text,
  p_crypto_key_version integer,
  p_handoff_digest text,
  p_session_envelope text,
  p_verified_user_id uuid,
  p_source_session_id uuid,
  p_handoff_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_row private.mobile_auth_transactions%rowtype;
begin
  if p_handoff_expires_at <= v_now
    or p_handoff_expires_at > v_now + interval '120 seconds'
  then
    raise exception 'Mobile authentication handoff expiry is outside the allowed window.';
  end if;

  update private.mobile_auth_transactions transaction_row
  set
    status = 'completed',
    row_version = transaction_row.row_version + 1,
    state_envelope = null,
    handoff_digest = p_handoff_digest,
    session_envelope = p_session_envelope,
    verified_user_id = p_verified_user_id,
    source_session_id = p_source_session_id,
    completed_at = v_now,
    handoff_expires_at = p_handoff_expires_at,
    updated_at = v_now
  where transaction_row.id = p_transaction_id
    and transaction_row.row_version = p_expected_version
    and transaction_row.browser_binding_digest = p_browser_binding_digest
    and transaction_row.csrf_digest = p_csrf_digest
    and transaction_row.crypto_key_version = p_crypto_key_version
    and transaction_row.status = 'verifying'
    and transaction_row.browser_expires_at > v_now
  returning transaction_row.* into v_row;

  if v_row.id is null then
    return jsonb_build_object('completed', false);
  end if;

  return jsonb_build_object(
    'completed', true,
    'transactionId', v_row.id,
    'traceId', v_row.trace_id,
    'rowVersion', v_row.row_version,
    'callbackOrigin', v_row.callback_origin,
    'callbackPath', v_row.callback_path,
    'returnTo', v_row.return_to,
    'handoffExpiresAt', v_row.handoff_expires_at
  );
end;
$$;

create or replace function public.api_mobile_auth_prepare_bootstrap(
  p_handoff_digests text[],
  p_state_digests text[],
  p_code_challenge text,
  p_callback_origin text,
  p_callback_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.mobile_auth_transactions%rowtype;
begin
  if p_handoff_digests is null
    or cardinality(p_handoff_digests) not between 1 and 8
    or p_state_digests is null
    or cardinality(p_state_digests) not between 1 and 8
    or exists (
      select 1
      from unnest(p_handoff_digests || p_state_digests) candidate(digest)
      where candidate.digest is null
        or candidate.digest !~ '^[A-Za-z0-9_-]{43}$'
    )
  then
    raise exception 'Mobile authentication bootstrap lookup candidates are invalid.';
  end if;

  select transaction_row.*
  into v_row
  from private.mobile_auth_transactions transaction_row
  where transaction_row.handoff_digest = any(p_handoff_digests)
    and transaction_row.state_digest = any(p_state_digests)
    and transaction_row.code_challenge = p_code_challenge
    and transaction_row.callback_origin = p_callback_origin
    and transaction_row.callback_path = p_callback_path
    and transaction_row.status = 'completed'
    and transaction_row.handoff_expires_at > statement_timestamp()
    and transaction_row.revoked_at is null;

  if v_row.id is null then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'transactionId', v_row.id,
    'traceId', v_row.trace_id,
    'rowVersion', v_row.row_version,
    'contractVersion', v_row.contract_version,
    'cryptoKeyVersion', v_row.crypto_key_version,
    'handoffDigest', v_row.handoff_digest,
    'stateDigest', v_row.state_digest,
    'sessionEnvelope', v_row.session_envelope,
    'verifiedUserId', v_row.verified_user_id,
    'sourceSessionId', v_row.source_session_id,
    'codeChallenge', v_row.code_challenge,
    'callbackOrigin', v_row.callback_origin,
    'callbackPath', v_row.callback_path,
    'returnTo', v_row.return_to,
    'handoffExpiresAt', v_row.handoff_expires_at
  );
end;
$$;

create or replace function public.api_mobile_auth_consume_transaction(
  p_transaction_id uuid,
  p_expected_version bigint,
  p_handoff_digest text,
  p_state_digest text,
  p_code_challenge text,
  p_callback_origin text,
  p_callback_path text,
  p_verified_user_id uuid,
  p_source_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_row private.mobile_auth_transactions%rowtype;
begin
  update private.mobile_auth_transactions transaction_row
  set
    status = 'consumed',
    row_version = transaction_row.row_version + 1,
    session_envelope = null,
    consumed_at = v_now,
    updated_at = v_now
  where transaction_row.id = p_transaction_id
    and transaction_row.row_version = p_expected_version
    and transaction_row.handoff_digest = p_handoff_digest
    and transaction_row.state_digest = p_state_digest
    and transaction_row.code_challenge = p_code_challenge
    and transaction_row.callback_origin = p_callback_origin
    and transaction_row.callback_path = p_callback_path
    and transaction_row.verified_user_id = p_verified_user_id
    and transaction_row.source_session_id = p_source_session_id
    and transaction_row.status = 'completed'
    and transaction_row.handoff_expires_at > v_now
    and transaction_row.revoked_at is null
    and exists (
      select 1
      from auth.sessions source_session
      where source_session.id = transaction_row.source_session_id
        and source_session.user_id = transaction_row.verified_user_id
        and (
          source_session.not_after is null
          or source_session.not_after > v_now
        )
    )
  returning transaction_row.* into v_row;

  if v_row.id is null then
    return jsonb_build_object('consumed', false);
  end if;

  return jsonb_build_object(
    'consumed', true,
    'transactionId', v_row.id,
    'traceId', v_row.trace_id,
    'rowVersion', v_row.row_version,
    'returnTo', v_row.return_to
  );
end;
$$;

create or replace function public.api_mobile_auth_terminate_transaction(
  p_transaction_id uuid,
  p_expected_version bigint,
  p_target_status text,
  p_failure_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_row private.mobile_auth_transactions%rowtype;
begin
  if p_target_status not in ('failed', 'cancelled', 'revoked') then
    raise exception 'Unsupported mobile authentication terminal status.';
  end if;

  update private.mobile_auth_transactions transaction_row
  set
    status = p_target_status,
    row_version = transaction_row.row_version + 1,
    state_envelope = null,
    session_envelope = null,
    failure_code = p_failure_code,
    revoked_at = case when p_target_status = 'revoked' then v_now else null end,
    updated_at = v_now
  where transaction_row.id = p_transaction_id
    and transaction_row.row_version = p_expected_version
    and (
      (
        transaction_row.status in ('created', 'authenticating', 'verifying')
        and p_target_status in ('failed', 'cancelled')
      )
      or (
        transaction_row.status = 'completed'
        and p_target_status = 'revoked'
      )
    )
  returning transaction_row.* into v_row;

  if v_row.id is null then
    return jsonb_build_object('terminated', false);
  end if;

  return jsonb_build_object(
    'terminated', true,
    'transactionId', v_row.id,
    'traceId', v_row.trace_id,
    'rowVersion', v_row.row_version,
    'status', v_row.status
  );
end;
$$;

create or replace function public.api_mobile_auth_take_rate_limit(
  p_scope text,
  p_key_version integer,
  p_key_digest text,
  p_window_seconds integer,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_window_started_at timestamptz;
  v_expires_at timestamptz;
  v_attempt_count integer;
  v_limit_value integer;
begin
  if p_window_seconds not between 1 and 86400 then
    raise exception 'Mobile authentication rate-limit window is invalid.';
  end if;

  if p_limit not between 1 and 10000 then
    raise exception 'Mobile authentication rate-limit threshold is invalid.';
  end if;

  v_window_started_at := to_timestamp(
    floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds
  );
  v_expires_at := v_window_started_at + make_interval(secs => p_window_seconds);

  insert into private.mobile_auth_rate_limit_counters (
    scope,
    key_version,
    key_digest,
    window_started_at,
    window_seconds,
    limit_value,
    attempt_count,
    expires_at
  )
  values (
    p_scope,
    p_key_version,
    p_key_digest,
    v_window_started_at,
    p_window_seconds,
    p_limit,
    1,
    v_expires_at
  )
  on conflict (scope, key_version, key_digest, window_started_at, window_seconds)
  do update
  set
    limit_value = least(
      private.mobile_auth_rate_limit_counters.limit_value,
      excluded.limit_value
    ),
    attempt_count = least(
      private.mobile_auth_rate_limit_counters.attempt_count + 1,
      least(
        private.mobile_auth_rate_limit_counters.limit_value,
        excluded.limit_value
      ) + 1
    ),
    expires_at = excluded.expires_at
  returning attempt_count, limit_value
  into v_attempt_count, v_limit_value;

  return jsonb_build_object(
    'allowed', v_attempt_count <= v_limit_value,
    'attemptCount', v_attempt_count,
    'limit', v_limit_value,
    'remaining', greatest(v_limit_value - v_attempt_count, 0),
    'retryAfterSeconds', greatest(
      ceil(extract(epoch from v_expires_at - v_now))::integer,
      0
    )
  );
end;
$$;

create or replace function public.api_mobile_auth_log_audit_event(
  p_trace_id uuid,
  p_event_type text,
  p_contract_version smallint,
  p_environment text,
  p_failure_code text default null,
  p_duration_bucket text default null,
  p_app_version text default null,
  p_os_version text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id bigint;
begin
  insert into private.mobile_auth_audit_events (
    trace_id,
    event_type,
    contract_version,
    environment,
    failure_code,
    duration_bucket,
    app_version,
    os_version
  )
  values (
    p_trace_id,
    p_event_type,
    p_contract_version,
    p_environment,
    p_failure_code,
    p_duration_bucket,
    p_app_version,
    p_os_version
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

create or replace function public.api_mobile_auth_cleanup(
  p_batch_size integer default 250,
  p_terminal_retention_seconds integer default 604800
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_expired_count integer := 0;
  v_pruned_count integer := 0;
  v_rate_limit_count integer := 0;
  v_audit_count integer := 0;
begin
  if p_batch_size not between 1 and 1000 then
    raise exception 'Mobile authentication cleanup batch size is invalid.';
  end if;

  if p_terminal_retention_seconds not between 0 and 31536000 then
    raise exception 'Mobile authentication terminal retention is invalid.';
  end if;

  with candidates as (
    select transaction_row.id
    from private.mobile_auth_transactions transaction_row
    where (
      transaction_row.status in ('created', 'authenticating', 'verifying')
      and transaction_row.browser_expires_at <= v_now
    )
    or (
      transaction_row.status = 'completed'
      and transaction_row.handoff_expires_at <= v_now
    )
    order by
      coalesce(
        transaction_row.handoff_expires_at,
        transaction_row.browser_expires_at
      ),
      transaction_row.id
    limit p_batch_size
    for update skip locked
  ),
  expired as (
    update private.mobile_auth_transactions transaction_row
    set
      status = 'expired',
      row_version = transaction_row.row_version + 1,
      state_envelope = null,
      session_envelope = null,
      failure_code = 'mobile_auth_expired',
      updated_at = v_now
    from candidates
    where transaction_row.id = candidates.id
    returning 1
  )
  select count(*)::integer
  into v_expired_count
  from expired;

  with candidates as (
    select transaction_row.id
    from private.mobile_auth_transactions transaction_row
    where transaction_row.status in (
      'consumed',
      'failed',
      'expired',
      'cancelled',
      'revoked'
    )
      and transaction_row.updated_at
        <= v_now - make_interval(secs => p_terminal_retention_seconds)
    order by transaction_row.updated_at, transaction_row.id
    limit p_batch_size
    for update skip locked
  ),
  pruned as (
    delete from private.mobile_auth_transactions transaction_row
    using candidates
    where transaction_row.id = candidates.id
    returning 1
  )
  select count(*)::integer
  into v_pruned_count
  from pruned;

  with candidates as (
    select
      counter.scope,
      counter.key_version,
      counter.key_digest,
      counter.window_started_at,
      counter.window_seconds
    from private.mobile_auth_rate_limit_counters counter
    where counter.expires_at <= v_now
    order by counter.expires_at, counter.scope, counter.key_digest
    limit p_batch_size
    for update skip locked
  ),
  pruned as (
    delete from private.mobile_auth_rate_limit_counters counter
    using candidates
    where counter.scope = candidates.scope
      and counter.key_version = candidates.key_version
      and counter.key_digest = candidates.key_digest
      and counter.window_started_at = candidates.window_started_at
      and counter.window_seconds = candidates.window_seconds
    returning 1
  )
  select count(*)::integer
  into v_rate_limit_count
  from pruned;

  with candidates as (
    select event_row.id
    from private.mobile_auth_audit_events event_row
    where event_row.created_at <= v_now - interval '30 days'
    order by event_row.created_at, event_row.id
    limit p_batch_size
    for update skip locked
  ),
  pruned as (
    delete from private.mobile_auth_audit_events event_row
    using candidates
    where event_row.id = candidates.id
    returning 1
  )
  select count(*)::integer
  into v_audit_count
  from pruned;

  return jsonb_build_object(
    'expiredTransactions', v_expired_count,
    'prunedTransactions', v_pruned_count,
    'prunedRateLimitCounters', v_rate_limit_count,
    'prunedAuditEvents', v_audit_count
  );
end;
$$;

revoke all on function public.api_mobile_auth_create_transaction(
  uuid,
  uuid,
  smallint,
  integer,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function public.api_mobile_auth_get_browser_transaction(uuid, text[])
  from public, anon, authenticated, service_role;
revoke all on function public.api_mobile_auth_claim_completion(
  uuid,
  bigint,
  text,
  text,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.api_mobile_auth_complete_transaction(
  uuid,
  bigint,
  text,
  text,
  integer,
  text,
  text,
  uuid,
  uuid,
  timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.api_mobile_auth_prepare_bootstrap(
  text[],
  text[],
  text,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function public.api_mobile_auth_consume_transaction(
  uuid,
  bigint,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid
) from public, anon, authenticated, service_role;
revoke all on function public.api_mobile_auth_terminate_transaction(
  uuid,
  bigint,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function public.api_mobile_auth_take_rate_limit(
  text,
  integer,
  text,
  integer,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.api_mobile_auth_log_audit_event(
  uuid,
  text,
  smallint,
  text,
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function public.api_mobile_auth_cleanup(integer, integer)
  from public, anon, authenticated, service_role;

grant execute on function public.api_mobile_auth_create_transaction(
  uuid,
  uuid,
  smallint,
  integer,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) to service_role;
grant execute on function public.api_mobile_auth_get_browser_transaction(uuid, text[])
  to service_role;
grant execute on function public.api_mobile_auth_claim_completion(
  uuid,
  bigint,
  text,
  text,
  integer
) to service_role;
grant execute on function public.api_mobile_auth_complete_transaction(
  uuid,
  bigint,
  text,
  text,
  integer,
  text,
  text,
  uuid,
  uuid,
  timestamptz
) to service_role;
grant execute on function public.api_mobile_auth_prepare_bootstrap(
  text[],
  text[],
  text,
  text,
  text
) to service_role;
grant execute on function public.api_mobile_auth_consume_transaction(
  uuid,
  bigint,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid
) to service_role;
grant execute on function public.api_mobile_auth_terminate_transaction(
  uuid,
  bigint,
  text,
  text
) to service_role;
grant execute on function public.api_mobile_auth_take_rate_limit(
  text,
  integer,
  text,
  integer,
  integer
) to service_role;
grant execute on function public.api_mobile_auth_log_audit_event(
  uuid,
  text,
  smallint,
  text,
  text,
  text,
  text,
  text
) to service_role;
grant execute on function public.api_mobile_auth_cleanup(integer, integer)
  to service_role;

notify pgrst, 'reload schema';
