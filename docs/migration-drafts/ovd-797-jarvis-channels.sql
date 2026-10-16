-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-797: Jarvis channels data model (DRAFT) + RLS.
--
-- This is a DRAFT. It must not be copied into supabase/migrations/ or applied
-- to any database outside a Blaine-approved migration window (a separate
-- approval card). When approved, it ships as ONE migration (next timestamp
-- from `npm run migration:new`), and
-- supabase/tests/pending/ovd797_jarvis_channels.sql.pending is renamed to
-- supabase/tests/ovd797_jarvis_channels.sql in the same change.
-- Rollback: docs/migration-drafts/ovd-797-jarvis-channels.rollback.sql.
-- Notes and fixture log: docs/migration-drafts/ovd-797-notes.md.
--
-- Requires (already applied): auth.users, auth.uid(), auth.jwt(),
-- public.is_platform_admin(), public.current_user_has_aal2().
--
-- Transaction: no begin/commit of its own. The migration runner wraps it in
-- one transaction. By hand:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f <file>
--
-- Access model:
--   * RLS is enabled on every table. anon has no grant on any table.
--   * authenticated has SELECT only, and only on its own rows: its
--     conversation, that conversation's messages and decisions, its channel
--     identities, and control commands filed under its conversation.
--     Grants and channel settings are readable by a platform admin at AAL2.
--     Link codes, inbound events and outbound deliveries are server only.
--   * There is no INSERT, UPDATE or DELETE grant or policy for any client
--     role. Every write goes through the service role in server code.
--   * One function: public.jarvis_control_command_guard(uuid, text). It is
--     read only, SECURITY DEFINER (justified in the notes), search_path '',
--     and EXECUTE is granted to authenticated only.
--
-- Additive only: one domain (public.jarvis_tier), new tables, one new function, seed rows for four channels
-- (all disabled). No existing object changes.

-- =====================================================================
-- Access tiers and channel switches (admin only)
-- =====================================================================
create domain public.jarvis_tier as text
  check (value in ('owner', 'beta', 'paid'));
comment on domain public.jarvis_tier is
  'OVD-797: Jarvis rollout tier (owner = Blaine, beta = allowlist, paid).';

create table public.jarvis_access_grants (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tier public.jarvis_tier not null,
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default pg_catalog.now(),
  revoked_at timestamptz,
  constraint jarvis_access_grants_revoked_after_granted
    check (revoked_at is null or revoked_at >= granted_at)
);
comment on table public.jarvis_access_grants is
  'OVD-797: Jarvis access tier per user. Active when revoked_at is null. Service role writes only.';

create table public.jarvis_channel_settings (
  channel text primary key check (channel ~ '^[a-z][a-z0-9_]{0,31}$'),
  enabled boolean not null default false,
  min_tier public.jarvis_tier not null default 'owner',
  updated_at timestamptz not null default pg_catalog.now()
);
comment on table public.jarvis_channel_settings is
  'OVD-797: per-channel off switch (default off) and minimum tier. Checked on inbound and before every send.';

insert into public.jarvis_channel_settings (channel) values
  ('web'), ('slack'), ('telegram'), ('imessage');

-- =====================================================================
-- Conversation, identities, link codes
-- =====================================================================
create table public.jarvis_conversations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now()
);
comment on table public.jarvis_conversations is
  'OVD-797: the single Jarvis conversation per user, shared by every channel.';

create table public.jarvis_channel_identities (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  channel text not null references public.jarvis_channel_settings (channel),
  -- HMAC-SHA256 of the external id (hex). The plain id is never stored.
  external_id_hash text not null check (external_id_hash ~ '^[0-9a-f]{64}$'),
  linked_at timestamptz not null default pg_catalog.now(),
  revoked_at timestamptz,
  constraint jarvis_channel_identities_channel_external_id_hash_key
    unique (channel, external_id_hash),
  constraint jarvis_channel_identities_revoked_after_linked
    check (revoked_at is null or revoked_at >= linked_at)
);
create index jarvis_channel_identities_user_id_idx
  on public.jarvis_channel_identities (user_id);
comment on table public.jarvis_channel_identities is
  'OVD-797: channel identity link. external_id_hash is an HMAC hash; one external id links at most one user.';

create table public.jarvis_link_codes (
  -- Hash of the one-time code (hex). The plain code is never stored.
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  channel text not null references public.jarvis_channel_settings (channel),
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint jarvis_link_codes_expiry_window
    check (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
  constraint jarvis_link_codes_consumed_after_created
    check (consumed_at is null or consumed_at >= created_at)
);
create index jarvis_link_codes_user_id_idx on public.jarvis_link_codes (user_id);
comment on table public.jarvis_link_codes is
  'OVD-797: one-time identity link codes (hashed), issued from an AAL2 web session, valid at most 10 minutes.';

-- =====================================================================
-- Messages, decisions, run control
-- =====================================================================
create table public.jarvis_messages (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  conversation_id uuid not null references public.jarvis_conversations (id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  channel text not null references public.jarvis_channel_settings (channel),
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  body jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(body) = 'object'),
  graph_run_id uuid,
  created_at timestamptz not null default pg_catalog.now()
);
create index jarvis_messages_conversation_id_created_at_idx
  on public.jarvis_messages (conversation_id, created_at);
create index jarvis_messages_graph_run_id_idx
  on public.jarvis_messages (graph_run_id) where graph_run_id is not null;
comment on table public.jarvis_messages is
  'OVD-797: messages and graph events in a conversation, in both directions.';

create table public.jarvis_decisions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  message_id uuid not null unique references public.jarvis_messages (id) on delete cascade,
  graph_run_id uuid not null,
  graph_node text not null check (pg_catalog.char_length(graph_node) between 1 and 200),
  options jsonb not null check (pg_catalog.jsonb_typeof(options) = 'array'),
  best_guess jsonb not null,
  resolution text check (resolution in ('chosen', 'skipped_best_guess', 'timeout_best_guess')),
  chosen jsonb,
  rationale text,
  resolved_by uuid references auth.users (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  constraint jarvis_decisions_resolution_shape check (
    (resolution is null and resolved_at is null and chosen is null and resolved_by is null)
    or (resolution is not null and resolved_at is not null and chosen is not null)
  )
);
create index jarvis_decisions_graph_run_id_idx on public.jarvis_decisions (graph_run_id);
comment on table public.jarvis_decisions is
  'OVD-797: decision cards. Every card carries best_guess; a skip or timeout records it as chosen.';

create table public.jarvis_control_commands (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  conversation_id uuid not null references public.jarvis_conversations (id) on delete cascade,
  graph_run_id uuid not null,
  kind text not null check (kind in ('pause', 'resume', 'cancel', 'steer')),
  payload jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(payload) = 'object'),
  actor_user_id uuid not null references auth.users (id) on delete cascade,
  idempotency_key text not null check (pg_catalog.char_length(idempotency_key) between 1 and 200),
  status text not null default 'queued' check (status in ('queued', 'applied', 'rejected')),
  applied_at_checkpoint text,
  created_at timestamptz not null default pg_catalog.now(),
  constraint jarvis_control_commands_graph_run_id_idempotency_key_key
    unique (graph_run_id, idempotency_key),
  constraint jarvis_control_commands_checkpoint_when_applied
    check ((status = 'applied') = (applied_at_checkpoint is not null))
);
create index jarvis_control_commands_conversation_id_idx
  on public.jarvis_control_commands (conversation_id);
comment on table public.jarvis_control_commands is
  'OVD-797: run control (pause/resume/cancel/steer), idempotent per (graph_run_id, idempotency_key). Applied at safe checkpoints. conversation_id is the run owner''s conversation, filled by the server after the guard says ok.';

-- =====================================================================
-- Webhook idempotency and outbound delivery (server only)
-- =====================================================================
create table public.jarvis_inbound_events (
  channel text not null references public.jarvis_channel_settings (channel),
  idempotency_key text not null check (pg_catalog.char_length(idempotency_key) between 1 and 200),
  received_at timestamptz not null default pg_catalog.now(),
  primary key (channel, idempotency_key)
);
comment on table public.jarvis_inbound_events is
  'OVD-797: inbound idempotency claim. A replayed (channel, idempotency_key) is a no-op.';

create table public.jarvis_outbound_deliveries (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  message_id uuid not null references public.jarvis_messages (id) on delete cascade,
  channel text not null references public.jarvis_channel_settings (channel),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint jarvis_outbound_deliveries_message_id_channel_key unique (message_id, channel)
);
comment on table public.jarvis_outbound_deliveries is
  'OVD-797: one delivery row per (message, channel), so a retry never sends twice.';

-- =====================================================================
-- Privileges: no anon, authenticated SELECT only where a policy allows it,
-- service_role full access (it bypasses RLS).
-- =====================================================================
revoke all on table
  public.jarvis_access_grants,
  public.jarvis_channel_settings,
  public.jarvis_conversations,
  public.jarvis_channel_identities,
  public.jarvis_link_codes,
  public.jarvis_messages,
  public.jarvis_decisions,
  public.jarvis_control_commands,
  public.jarvis_inbound_events,
  public.jarvis_outbound_deliveries
from public, anon, authenticated;

grant select on table
  public.jarvis_access_grants,
  public.jarvis_channel_settings,
  public.jarvis_conversations,
  public.jarvis_channel_identities,
  public.jarvis_messages,
  public.jarvis_decisions,
  public.jarvis_control_commands
to authenticated;

grant select, insert, update, delete on table
  public.jarvis_access_grants,
  public.jarvis_channel_settings,
  public.jarvis_conversations,
  public.jarvis_channel_identities,
  public.jarvis_link_codes,
  public.jarvis_messages,
  public.jarvis_decisions,
  public.jarvis_control_commands,
  public.jarvis_inbound_events,
  public.jarvis_outbound_deliveries
to service_role;

alter table public.jarvis_access_grants enable row level security;
alter table public.jarvis_channel_settings enable row level security;
alter table public.jarvis_conversations enable row level security;
alter table public.jarvis_channel_identities enable row level security;
alter table public.jarvis_link_codes enable row level security;
alter table public.jarvis_messages enable row level security;
alter table public.jarvis_decisions enable row level security;
alter table public.jarvis_control_commands enable row level security;
alter table public.jarvis_inbound_events enable row level security;
alter table public.jarvis_outbound_deliveries enable row level security;

-- =====================================================================
-- RLS policies (SELECT only; no client write policy exists)
-- =====================================================================
create policy jarvis_access_grants_select_admin_aal2
on public.jarvis_access_grants
for select
to authenticated
using (public.is_platform_admin() and public.current_user_has_aal2());

create policy jarvis_channel_settings_select_admin_aal2
on public.jarvis_channel_settings
for select
to authenticated
using (public.is_platform_admin() and public.current_user_has_aal2());

create policy jarvis_conversations_select_own
on public.jarvis_conversations
for select
to authenticated
using (user_id = (select auth.uid()));

create policy jarvis_channel_identities_select_own
on public.jarvis_channel_identities
for select
to authenticated
using (user_id = (select auth.uid()));

create policy jarvis_messages_select_own
on public.jarvis_messages
for select
to authenticated
using (
  exists (
    select 1
    from public.jarvis_conversations conversation
    where conversation.id = jarvis_messages.conversation_id
      and conversation.user_id = (select auth.uid())
  )
);

create policy jarvis_decisions_select_own
on public.jarvis_decisions
for select
to authenticated
using (
  exists (
    select 1
    from public.jarvis_messages message
    join public.jarvis_conversations conversation
      on conversation.id = message.conversation_id
    where message.id = jarvis_decisions.message_id
      and conversation.user_id = (select auth.uid())
  )
);

-- A command is visible only in the conversation it was filed under, never
-- through whichever messages happen to carry its graph_run_id.
create policy jarvis_control_commands_select_own
on public.jarvis_control_commands
for select
to authenticated
using (
  exists (
    select 1
    from public.jarvis_conversations conversation
    where conversation.id = jarvis_control_commands.conversation_id
      and conversation.user_id = (select auth.uid())
  )
);

-- =====================================================================
-- Control command guard (read only; the server enqueues on 'ok')
-- =====================================================================
-- Verdict for the calling user (auth.uid()) issuing a control command on a
-- run. It writes nothing. Server code calls it with the user's session, then
-- inserts into jarvis_control_commands with the service role only on 'ok',
-- setting conversation_id to the conversation that carries the run (on the
-- owner path that is the caller's own conversation, since 'ok' means every
-- message carrying the run is in it).
--   'ok'                the caller owns the run and holds an active grant,
--                       or the caller is a platform admin at AAL2
--   'not_authenticated' no auth.uid()
--   'invalid_command'   unknown kind or null run id
--   'aal2_required'     a platform admin without AAL2, on a run it does not own
--   'no_access'         the caller owns the run but has no active grant
--   'not_owner'         anything else (an unknown run gives the same answer)
-- A run is owned when every message that carries it is in the caller's
-- conversation. Seeing every conversation needs SECURITY DEFINER; see notes.
create function public.jarvis_control_command_guard(
  p_graph_run_id uuid,
  p_kind text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_owner boolean;
begin
  if v_user_id is null then
    return 'not_authenticated';
  end if;

  if p_graph_run_id is null
    or p_kind is null
    or p_kind not in ('pause', 'resume', 'cancel', 'steer') then
    return 'invalid_command';
  end if;

  select pg_catalog.bool_and(conversation.user_id = v_user_id)
  into v_owner
  from public.jarvis_messages message
  join public.jarvis_conversations conversation
    on conversation.id = message.conversation_id
  where message.graph_run_id = p_graph_run_id;

  if coalesce(v_owner, false) then
    if exists (
      select 1
      from public.jarvis_access_grants access_grant
      where access_grant.user_id = v_user_id
        and access_grant.revoked_at is null
    ) then
      return 'ok';
    end if;
    return 'no_access';
  end if;

  if public.is_platform_admin() then
    if public.current_user_has_aal2() then
      return 'ok';
    end if;
    return 'aal2_required';
  end if;

  return 'not_owner';
end;
$$;

revoke all on function public.jarvis_control_command_guard(uuid, text) from public, anon, service_role;
grant execute on function public.jarvis_control_command_guard(uuid, text) to authenticated;
