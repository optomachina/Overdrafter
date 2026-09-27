-- OVD-575: retain source observer evidence without admitting a stop.
-- No profile, actor, evidence, credential or production principal is seeded.
-- Rollback: revoke the executor's function grant first; retain these immutable
-- records for audit. A later, separately authorized migration may retire them.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'ovd575_observer_validator') then
    create role ovd575_observer_validator nologin noinherit;
  end if;
  if exists (select 1 from pg_catalog.pg_roles
             where rolname = 'ovd575_observer_validator' and
               (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole
                or rolreplication or rolbypassrls))
    or pg_catalog.pg_has_role('service_role','ovd575_observer_validator','member')
    or pg_catalog.pg_has_role('anon','ovd575_observer_validator','member')
    or pg_catalog.pg_has_role('authenticated','ovd575_observer_validator','member') then
    raise exception 'OVD-575 validator role has unsafe attributes or membership';
  end if;
end;
$$;
grant usage on schema engineering_private to ovd575_observer_validator;

-- These rows are written only by the database owner after a separate runtime
-- qualification. A source certificate's own flags cannot create a profile.
create table engineering_private.native_observer_profiles (
  id uuid primary key,
  runtime_admission_id uuid not null references engineering_private.native_runtime_admissions(id),
  observer_schema text not null check (observer_schema = 'overdrafter.native-stop-observer.v1'),
  observer_version text not null check (observer_version = 'windows-job-observer/1'),
  boundary text not null check (boundary = 'trusted-user-direct-createprocess-job-v1'),
  profile_version text not null check (profile_version = 'observer-ingest-v1'),
  observer_source_sha256 text not null check (observer_source_sha256 ~ '^[0-9a-f]{64}$'),
  qualification_sha256 text not null check (qualification_sha256 ~ '^[0-9a-f]{64}$'),
  native_qualification boolean not null check (not native_qualification),
  stop_admission boolean not null check (not stop_admission),
  admitted_by uuid not null references auth.users(id),
  admitted_at timestamptz not null default clock_timestamp(),
  unique (id, runtime_admission_id)
);

-- The database owner chooses the auth.users identity for this exact executor.
-- The ingestion function never accepts an actor, authority or trust flag.
create table engineering_private.native_observer_validator_actors (
  executor_role name primary key check (executor_role = 'ovd575_observer_validator'),
  admitted_by uuid not null references auth.users(id),
  enabled boolean not null default false
);

create table engineering_private.native_observer_evidence (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  runtime_admission_id uuid not null,
  observer_run_id uuid not null unique,
  attempt_id uuid not null unique,
  task_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  worker_id uuid not null,
  installation_id uuid not null,
  boot_id uuid not null,
  session_id uuid not null,
  fence bigint not null check (fence between 1 and 9007199254740991),
  job_id uuid not null,
  job_sha256 text not null check (job_sha256 ~ '^[0-9a-f]{64}$'),
  context_sha256 text not null check (context_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_bytes bytea not null check (octet_length(manifest_bytes) between 1 and 131072),
  manifest_sha256 text not null check (manifest_sha256 = encode(extensions.digest(manifest_bytes,'sha256'),'hex')),
  journal_bytes bytea not null check (octet_length(journal_bytes) between 1 and 1048576),
  journal_sha256 text not null check (journal_sha256 = encode(extensions.digest(journal_bytes,'sha256'),'hex')),
  journal_head_sha256 text not null check (journal_head_sha256 ~ '^[0-9a-f]{64}$'),
  observer_schema text not null check (observer_schema = 'overdrafter.native-stop-observer.v1'),
  observer_version text not null check (observer_version = 'windows-job-observer/1'),
  boundary text not null check (boundary = 'trusted-user-direct-createprocess-job-v1'),
  profile_version text not null check (profile_version = 'observer-ingest-v1'),
  verdict text not null check (verdict = 'complete_in_job_envelope'),
  terminal_processes jsonb not null check (jsonb_typeof(terminal_processes) = 'array'),
  execution_outcome text not null check (execution_outcome in ('native_exit_succeeded','native_failed')),
  observed_at timestamptz not null,
  validator_version text not null check (validator_version = 'observer-registry-validator/1'),
  admitted_by uuid not null references auth.users(id),
  stored_at timestamptz not null default clock_timestamp(),
  foreign key (profile_id,runtime_admission_id)
    references engineering_private.native_observer_profiles(id,runtime_admission_id),
  foreign key (attempt_id,organization_id,project_id)
    references public.engineering_execution_attempts(id,organization_id,project_id)
);

do $$
declare n text;
begin
  foreach n in array array['native_observer_profiles','native_observer_validator_actors','native_observer_evidence'] loop
    execute format('alter table engineering_private.%I enable row level security',n);
    execute format('revoke all on engineering_private.%I from public,anon,authenticated,service_role,ovd575_observer_validator',n);
  end loop;
end;
$$;
create trigger native_observer_profile_immutable before update or delete
  on engineering_private.native_observer_profiles for each row
  execute function engineering_private.reject_engineering_history_mutation();
create trigger native_observer_evidence_immutable before update or delete
  on engineering_private.native_observer_evidence for each row
  execute function engineering_private.reject_engineering_history_mutation();

-- Match the observer's ordinal-key, ASCII, UTF-16-escaped JSON wire format.
-- Byte comparison rejects whitespace, duplicate keys, BOM, alternate Unicode
-- spelling and JSONB round trips. The schema below uses ASCII object keys.
create function engineering_private.native_observer_json_string(p_text text)
returns text language plpgsql immutable strict set search_path = '' as $$
declare v_out text := '"'; v_code integer; v_high integer; v_low integer; v_i integer;
begin
  for v_i in 1..char_length(p_text) loop
    v_code := ascii(substr(p_text,v_i,1));
    if v_code = 34 then v_out := v_out || '\"';
    elsif v_code = 92 then v_out := v_out || '\\';
    elsif v_code < 32 or v_code > 126 then
      if v_code <= 65535 then
        v_out := v_out || '\u' || lpad(to_hex(v_code),4,'0');
      else
        v_code := v_code - 65536;
        v_high := 55296 + (v_code / 1024);
        v_low := 56320 + (v_code % 1024);
        v_out := v_out || '\u' || to_hex(v_high) || '\u' || to_hex(v_low);
      end if;
    else v_out := v_out || chr(v_code);
    end if;
  end loop;
  return v_out || '"';
end;
$$;

create function engineering_private.native_observer_canonical_json(p_value jsonb,p_depth integer default 0)
returns text language plpgsql immutable set search_path = '' as $$
declare v_type text; v_entry record; v_out text := ''; v_first boolean := true;
begin
  if p_depth > 12 then raise exception using errcode='22023',message='Observer JSON depth exceeded.'; end if;
  v_type := jsonb_typeof(p_value);
  if v_type = 'null' then return 'null'; end if;
  if v_type = 'boolean' then return p_value::text; end if;
  if v_type = 'number' then
    if p_value::text !~ '^(0|-?[1-9][0-9]*)$' then
      raise exception using errcode='22023',message='Observer JSON requires integer numbers.';
    end if;
    return p_value::text;
  end if;
  if v_type = 'string' then
    return engineering_private.native_observer_json_string(p_value #>> '{}');
  end if;
  if v_type = 'array' then
    for v_entry in select value from jsonb_array_elements(p_value) loop
      if not v_first then v_out := v_out || ','; end if;
      v_out := v_out || engineering_private.native_observer_canonical_json(v_entry.value,p_depth+1);
      v_first := false;
    end loop;
    return '[' || v_out || ']';
  end if;
  if v_type = 'object' then
    for v_entry in select key,value from jsonb_each(p_value) order by key collate "C" loop
      if not v_first then v_out := v_out || ','; end if;
      v_out := v_out || engineering_private.native_observer_json_string(v_entry.key) || ':' ||
        engineering_private.native_observer_canonical_json(v_entry.value,p_depth+1);
      v_first := false;
    end loop;
    return '{' || v_out || '}';
  end if;
  raise exception using errcode='22023',message='Unsupported observer JSON value.';
end;
$$;
revoke all on function engineering_private.native_observer_json_string(text) from public,anon,authenticated,service_role,ovd575_observer_validator;
revoke all on function engineering_private.native_observer_canonical_json(jsonb,integer) from public,anon,authenticated,service_role,ovd575_observer_validator;

create function engineering_private.native_observer_has_keys(p_value jsonb,p_keys text[])
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_value) = 'object' and
    (select array_agg(key order by key collate "C") from jsonb_object_keys(p_value) as key) =
    (select array_agg(key order by key collate "C") from unnest(p_keys) as key);
$$;
revoke all on function engineering_private.native_observer_has_keys(jsonb,text[])
  from public,anon,authenticated,service_role,ovd575_observer_validator;

create function engineering_private.native_observer_valid_windows_path(p_path text,p_root boolean default false)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_parts text[]; v_part text; v_index integer;
begin
  if p_path is null or char_length(p_path) > 260
    or left(p_path,1) !~ '^[A-Za-z]$' or substr(p_path,2,2) <> ':'||chr(92) then
    return false;
  end if;
  if char_length(p_path)=3 then return p_root; end if;
  if char_length(p_path)<4 or substr(p_path,4) ~ '[[:cntrl:]<>:"/|?*]' then return false; end if;
  v_parts := string_to_array(p_path,chr(92));
  for v_index in 2..array_length(v_parts,1) loop
    v_part := v_parts[v_index];
    if v_part is null or v_part='' or v_part in ('.','..')
      or right(v_part,1) in ('.',' ') then return false; end if;
  end loop;
  return true;
end;
$$;
revoke all on function engineering_private.native_observer_valid_windows_path(text,boolean)
  from public,anon,authenticated,service_role,ovd575_observer_validator;

create function engineering_private.native_observer_valid_process(p_process jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_identity jsonb := p_process->'identity'; v_path text;
begin
  if not engineering_private.native_observer_has_keys(p_process,array[
      'identity','executableSha256','parentPid','observedAt','exitCode','exitedAt'])
    or not engineering_private.native_observer_has_keys(v_identity,array[
      'pid','creationTicks','sessionId','executablePath']) then return false; end if;
  if jsonb_typeof(v_identity->'pid') is distinct from 'number'
    or jsonb_typeof(v_identity->'creationTicks') is distinct from 'string'
    or jsonb_typeof(v_identity->'sessionId') is distinct from 'number'
    or jsonb_typeof(v_identity->'executablePath') is distinct from 'string'
    or jsonb_typeof(p_process->'executableSha256') is distinct from 'string'
    or jsonb_typeof(p_process->'parentPid') is distinct from 'number'
    or jsonb_typeof(p_process->'observedAt') is distinct from 'string'
    or jsonb_typeof(p_process->'exitCode') is distinct from 'number'
    or jsonb_typeof(p_process->'exitedAt') is distinct from 'string' then return false; end if;
  v_path := v_identity->>'executablePath';
  if (v_identity->>'pid')::bigint not between 1 and 2147483647
    or (v_identity->>'sessionId')::bigint not between 0 and 2147483647
    or (p_process->>'parentPid')::bigint not between 0 and 2147483647
    or (p_process->>'exitCode')::bigint not between -2147483648 and 2147483647
    or v_identity->>'creationTicks' !~ '^[1-9][0-9]{0,18}$'
    or (v_identity->>'creationTicks')::numeric > 3155378975999999999
    or not engineering_private.native_observer_valid_windows_path(v_path)
    or p_process->>'executableSha256' !~ '^[0-9a-f]{64}$'
    or p_process->>'observedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    or p_process->>'exitedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then return false; end if;
  return true;
end;
$$;
revoke all on function engineering_private.native_observer_valid_process(jsonb)
  from public,anon,authenticated,service_role,ovd575_observer_validator;

create function engineering_private.store_native_observer_evidence(
  p_profile uuid,p_manifest bytea,p_journal bytea
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_profile engineering_private.native_observer_profiles%rowtype;
  v_attempt public.engineering_execution_attempts%rowtype;
  v_worker public.engineering_workers%rowtype;
  v_manifest jsonb; v_journal jsonb; v_binding jsonb; v_job jsonb;
  v_id uuid; v_now timestamptz := clock_timestamp(); v_terminal jsonb; v_slot_attempt uuid;
  v_record jsonb; v_body jsonb; v_prior text; v_sequence integer := 0;
  v_binding_sha text; v_started timestamptz; v_observed timestamptz;
  v_record_at timestamptz; v_last_at timestamptz;
  v_launches jsonb := '{}'::jsonb; v_launch jsonb; v_launch_id text;
  v_role text; v_phase text := 'preflight'; v_failure text;
  v_native_id text; v_process jsonb; v_identity jsonb; v_seen_pids integer[] := array[]::integer[];
  v_observed_pids integer[] := array[]::integer[]; v_expected_terminals jsonb;
  v_success boolean;
begin
  -- SET ROLE is restricted by PostgreSQL membership. This fixed NOLOGIN role
  -- has no API/service_role membership and no direct table DML.
  if current_setting('role') <> 'ovd575_observer_validator' then
    raise exception using errcode='42501',message='Observer validator executor required.';
  end if;
  select admitted_by into v_actor from engineering_private.native_observer_validator_actors
    where executor_role='ovd575_observer_validator' and enabled;
  if v_actor is null then raise exception using errcode='42501',message='Observer validator attribution unavailable.'; end if;
  if p_manifest is null or p_journal is null or octet_length(p_manifest) not between 1 and 131072
    or octet_length(p_journal) not between 1 and 1048576 then
    raise exception using errcode='22023',message='Observer evidence size invalid.';
  end if;
  v_manifest := convert_from(p_manifest,'UTF8')::jsonb;
  v_journal := convert_from(p_journal,'UTF8')::jsonb;
  if convert_from(p_manifest,'UTF8') <> engineering_private.native_observer_canonical_json(v_manifest)
    or convert_from(p_journal,'UTF8') <> engineering_private.native_observer_canonical_json(v_journal) then
    raise exception using errcode='22023',message='Observer evidence is not canonical.';
  end if;
  if not engineering_private.native_observer_has_keys(v_manifest,array[
      'schema','observerVersion','observerRunId','binding','contextSha256','deadline',
      'startedAt','observedAt','journalSha256','journalHeadSha256','boundary','verdict',
      'root','observedProcesses','totalProcesses','activeProcesses','limitedProcesses',
      'terminalProcesses','executionOutcome','failureCode','stopAdmission','nativeQualification'])
    or not engineering_private.native_observer_has_keys(v_journal,array[
      'schema','binding','records','headSha256'])
    or v_manifest->>'schema' is null or v_manifest->>'observerVersion' is null
    or v_manifest->>'boundary' is null or v_manifest->>'verdict' is null
    or v_manifest->>'observerRunId' is null or v_manifest->>'journalSha256' is null
    or v_manifest->>'journalHeadSha256' is null or v_manifest->>'contextSha256' is null
    or v_manifest->>'startedAt' is null or v_manifest->>'observedAt' is null
    or v_manifest->>'deadline' is null or v_journal->>'schema' is null
    or v_journal->>'headSha256' is null
    or v_manifest->>'schema' <> 'overdrafter.native-stop-observer.v1'
    or v_manifest->>'observerVersion' <> 'windows-job-observer/1'
    or v_manifest->>'boundary' <> 'trusted-user-direct-createprocess-job-v1'
    or v_manifest->>'verdict' <> 'complete_in_job_envelope'
    or v_manifest->'stopAdmission' is distinct from 'false'::jsonb
    or v_manifest->'nativeQualification' is distinct from 'false'::jsonb
    or v_journal->>'schema' <> 'overdrafter.native-attempt-journal.v1'
    or v_manifest->'binding' is null or v_manifest->'binding' <> v_journal->'binding'
    or v_manifest->>'journalSha256' <> encode(extensions.digest(p_journal,'sha256'),'hex')
    or v_manifest->>'journalHeadSha256' <> v_journal->>'headSha256'
    or v_manifest->'activeProcesses' <> '0'::jsonb
    or v_manifest->'limitedProcesses' <> '0'::jsonb
    or v_manifest->>'executionOutcome' not in ('native_exit_succeeded','native_failed')
    or jsonb_typeof(v_manifest->'observedProcesses') <> 'array'
    or jsonb_typeof(v_manifest->'terminalProcesses') <> 'array'
    or jsonb_typeof(v_journal->'records') <> 'array'
    or jsonb_array_length(v_journal->'records') > 2048
    or not engineering_private.native_observer_has_keys(v_manifest->'root',array[
      'identity','executableSha256','parentPid','observedAt','exitCode','exitedAt'])
    or not engineering_private.native_observer_has_keys(v_manifest->'root'->'identity',array[
      'pid','creationTicks','sessionId','executablePath']) then
    raise exception using errcode='22023',message='Unsupported observer certificate.';
  end if;
  v_binding := v_manifest->'binding';
  v_binding_sha := encode(extensions.digest(convert_to(
    engineering_private.native_observer_canonical_json(v_binding),'UTF8'),'sha256'),'hex');
  v_prior := v_binding_sha;
  for v_record in select value from jsonb_array_elements(v_journal->'records') loop
    v_sequence := v_sequence + 1;
    if not engineering_private.native_observer_has_keys(v_record,array[
        'sequence','previousSha256','bindingSha256','at','kind','data','sha256'])
      or v_record->>'at' is null or v_record->>'kind' is null
    or v_record->>'sha256' is null or v_record->>'previousSha256' is null
    or v_record->>'bindingSha256' is null
    or jsonb_typeof(v_record->'sequence') is distinct from 'number'
    or jsonb_typeof(v_record->'at') is distinct from 'string'
    or jsonb_typeof(v_record->'kind') is distinct from 'string'
    or jsonb_typeof(v_record->'data') is distinct from 'object'
    or jsonb_typeof(v_record->'sha256') is distinct from 'string'
    or jsonb_typeof(v_record->'previousSha256') is distinct from 'string'
    or jsonb_typeof(v_record->'bindingSha256') is distinct from 'string'
      or v_record->'sequence' <> to_jsonb(v_sequence)
      or v_record->>'previousSha256' <> v_prior
      or v_record->>'bindingSha256' <> v_binding_sha
      or v_record->>'kind' not in ('launch_intent','process_started','process_exited','phase','failure','uncertain') then
      raise exception using errcode='22023',message='Observer journal chain invalid.';
    end if;
    v_body := v_record - 'sha256';
    v_prior := encode(extensions.digest(convert_to(
      engineering_private.native_observer_canonical_json(v_body),'UTF8'),'sha256'),'hex');
    if v_record->>'sha256' <> v_prior then
      raise exception using errcode='22023',message='Observer journal record digest invalid.';
    end if;
    if v_record->>'at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then
      raise exception using errcode='22023',message='Journal record time invalid.';
    end if;
    v_record_at := (v_record->>'at')::timestamptz;
    if v_last_at is not null and v_record_at < v_last_at then
      raise exception using errcode='22023',message='Journal clock moved backwards.';
    end if;
    v_last_at := v_record_at;
    if v_record->>'kind' = 'uncertain' then
      raise exception using errcode='22023',message='Uncertain journal cannot yield a complete certificate.';
    end if;
    if v_failure is not null and v_record->>'kind' not in ('process_exited') then
      raise exception using errcode='22023',message='Failed journal continued work.';
    end if;
    if v_record->>'kind' = 'launch_intent' then
      if not engineering_private.native_observer_has_keys(v_record->'data',array[
          'launchId','role','executablePath','executableSha256','workingDirectory',
          'argumentsSha256','parentLaunchId'])
        or v_record->'data'->'parentLaunchId' <> 'null'::jsonb
        or jsonb_typeof(v_record->'data'->'launchId') is distinct from 'string'
        or jsonb_typeof(v_record->'data'->'role') is distinct from 'string'
        or jsonb_typeof(v_record->'data'->'executablePath') is distinct from 'string'
        or jsonb_typeof(v_record->'data'->'executableSha256') is distinct from 'string'
        or jsonb_typeof(v_record->'data'->'workingDirectory') is distinct from 'string'
        or jsonb_typeof(v_record->'data'->'argumentsSha256') is distinct from 'string'
        or jsonb_typeof(v_record->'data'->'parentLaunchId') is distinct from 'null'
        or v_record->'data'->>'role' not in ('compiler','native','lifecycle','operation')
        or v_record->'data'->>'executableSha256' !~ '^[0-9a-f]{64}$'
        or v_record->'data'->>'argumentsSha256' !~ '^[0-9a-f]{64}$' then
        raise exception using errcode='22023',message='Journal launch intent invalid.';
      end if;
      v_launch_id := v_record->'data'->>'launchId';
      v_role := v_record->'data'->>'role';
      if v_launch_id is null or v_role is null
        or not engineering_private.native_observer_valid_windows_path(v_record->'data'->>'executablePath')
        or not engineering_private.native_observer_valid_windows_path(v_record->'data'->>'workingDirectory',true)
        or v_launch_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or v_launches ? v_launch_id
        or (v_role in ('compiler','native') and v_native_id is not null)
        or (v_role in ('lifecycle','operation') and
          (v_native_id is null or not (v_launches->v_native_id ? 'start')
            or v_launches->v_native_id ? 'exit'))
        or (v_role = 'operation' and
          (v_phase <> 'operation_started' or exists (
            select 1 from jsonb_each(v_launches) l where l.value->>'role'='operation')))
        or exists(select 1 from jsonb_each(v_launches) l
          where l.value->>'role'<>'native' and not (l.value ? 'exit')) then
        raise exception using errcode='22023',message='Journal launch order invalid.';
      end if;
      if v_role = 'native' then
        if not exists(select 1 from jsonb_each(v_launches) l where l.value->>'role'='compiler')
          or exists(select 1 from jsonb_each(v_launches) l
            where l.value->>'role'='compiler' and (not (l.value ? 'exit') or l.value->'exit'->>'exitCode'<>'0')) then
          raise exception using errcode='22023',message='Compiler exit required before native launch.';
        end if;
        v_native_id := v_launch_id;
      end if;
      v_launches := jsonb_set(v_launches,array[v_launch_id],jsonb_build_object(
        'role',v_role,'intent',v_record->'data'));
    elsif v_record->>'kind' = 'process_started' then
      if not engineering_private.native_observer_has_keys(v_record->'data',array[
          'launchId','pid','creationTicks','sessionId','executablePath','executableSha256']) then
        raise exception using errcode='22023',message='Journal process start malformed.';
      end if;
      v_launch_id := v_record->'data'->>'launchId';
      v_launch := v_launches->v_launch_id;
      if v_launch_id is null or v_record->'data'->>'pid' is null
        or jsonb_typeof(v_record->'data'->'launchId') is distinct from 'string'
        or jsonb_typeof(v_record->'data'->'pid') is distinct from 'number'
        or jsonb_typeof(v_record->'data'->'creationTicks') is distinct from 'string'
        or jsonb_typeof(v_record->'data'->'sessionId') is distinct from 'number'
        or jsonb_typeof(v_record->'data'->'executablePath') is distinct from 'string'
        or jsonb_typeof(v_record->'data'->'executableSha256') is distinct from 'string'
        or v_record->'data'->>'creationTicks' is null
        or v_record->'data'->>'sessionId' is null
        or v_record->'data'->>'executablePath' is null
        or v_record->'data'->>'executableSha256' is null
        or not engineering_private.native_observer_valid_windows_path(v_record->'data'->>'executablePath')
        or v_launch is null or v_launch ? 'start'
        or v_record->'data'->>'executableSha256' <> v_launch->'intent'->>'executableSha256'
        or lower(v_record->'data'->>'executablePath') <> lower(v_launch->'intent'->>'executablePath')
        or (v_record->'data'->>'creationTicks')::numeric >
          extract(epoch from v_record_at)*10000000+621355968000000000
        or (v_record->'data'->>'pid')::integer = any(v_seen_pids) then
        raise exception using errcode='22023',message='Journal process start lacks unique intent.';
      end if;
      v_seen_pids := array_append(v_seen_pids,(v_record->'data'->>'pid')::integer);
      v_launches := jsonb_set(v_launches,array[v_launch_id,'start'],v_record->'data');
    elsif v_record->>'kind' = 'process_exited' then
      if not engineering_private.native_observer_has_keys(v_record->'data',array[
          'launchId','pid','creationTicks','sessionId','exitCode','terminationRequested']) then
        raise exception using errcode='22023',message='Journal process exit malformed.';
      end if;
      v_launch_id := v_record->'data'->>'launchId';
      v_launch := v_launches->v_launch_id;
      if v_launch_id is null or v_record->'data'->>'pid' is null
        or jsonb_typeof(v_record->'data'->'launchId') is distinct from 'string'
        or jsonb_typeof(v_record->'data'->'pid') is distinct from 'number'
        or jsonb_typeof(v_record->'data'->'creationTicks') is distinct from 'string'
        or jsonb_typeof(v_record->'data'->'sessionId') is distinct from 'number'
        or jsonb_typeof(v_record->'data'->'exitCode') is distinct from 'number'
        or v_record->'data'->>'creationTicks' is null
        or v_record->'data'->>'sessionId' is null
        or v_record->'data'->>'exitCode' is null
        or v_launch is null or not (v_launch ? 'start') or v_launch ? 'exit'
        or v_record->'data'->'terminationRequested' is distinct from 'false'::jsonb
        or v_record->'data'->>'pid' <> v_launch->'start'->>'pid'
        or v_record->'data'->>'creationTicks' <> v_launch->'start'->>'creationTicks'
        or v_record->'data'->>'sessionId' <> v_launch->'start'->>'sessionId' then
        raise exception using errcode='22023',message='Journal process exit lacks exact start.';
      end if;
      v_launches := jsonb_set(v_launches,array[v_launch_id,'exit'],v_record->'data');
    elsif v_record->>'kind' = 'phase' then
      if not engineering_private.native_observer_has_keys(v_record->'data',array['phase'])
        or jsonb_typeof(v_record->'data'->'phase') is distinct from 'string'
        or v_record->'data'->>'phase' is null
        or v_native_id is null or not (v_launches->v_native_id ? 'start')
        or v_launches->v_native_id ? 'exit'
        or v_record->'data'->>'phase' is distinct from (case v_phase
          when 'preflight' then 'startup_wait'
          when 'startup_wait' then 'startup_ready'
          when 'startup_ready' then 'operation_started'
          when 'operation_started' then 'operation_completed'
          when 'operation_completed' then 'outputs_saved' end) then
        raise exception using errcode='22023',message='Journal native phase invalid.';
      end if;
      if v_record->'data'->>'phase' = 'operation_completed' and not exists (
        select 1 from jsonb_each(v_launches) l where l.value->>'role'='operation'
          and l.value->'exit'->>'exitCode'='0') then
        raise exception using errcode='22023',message='Operation completion lacks successful exit.';
      end if;
      v_phase := v_record->'data'->>'phase';
    elsif v_record->>'kind' = 'failure' then
      if not engineering_private.native_observer_has_keys(v_record->'data',array['code','evidenceSha256'])
        or jsonb_typeof(v_record->'data'->'code') is distinct from 'string'
        or jsonb_typeof(v_record->'data'->'evidenceSha256') is distinct from 'string'
        or v_record->'data'->>'code' is null
        or v_record->'data'->>'evidenceSha256' is null
        or v_record->'data'->>'code' not in ('native_startup_timeout','input_invalid',
          'runtime_mismatch','native_operation_failed','artifact_invalid','deadline_exceeded',
          'authority_lost','process_uncertain','unclassified')
        or v_record->'data'->>'evidenceSha256' !~ '^[0-9a-f]{64}$'
        or (v_record->'data'->>'code'='native_startup_timeout' and v_phase<>'startup_wait') then
        raise exception using errcode='22023',message='Journal failure invalid.';
      end if;
      v_failure := v_record->'data'->>'code';
    end if;
  end loop;
  if v_sequence = 0 or v_journal->>'headSha256' <> v_prior then
    raise exception using errcode='22023',message='Observer journal head invalid.';
  end if;
  if (select count(*) from jsonb_each(v_launches)) <> jsonb_array_length(v_manifest->'observedProcesses')
    or exists(select 1 from jsonb_each(v_launches) l
      where not (l.value ? 'start') or not (l.value ? 'exit')) then
    raise exception using errcode='22023',message='Journal launches are unresolved.';
  end if;
  -- Match the native slot -> worker -> attempt lock order. Holding these row
  -- locks through insertion prevents a concurrent slot/boot/phase transition
  -- from making an already checked certificate stale before it is retained.
  select * into v_attempt from public.engineering_execution_attempts
    where id=(v_binding->>'attemptId')::uuid;
  select active_attempt_id into v_slot_attempt from engineering_private.native_slots
    where organization_id=v_attempt.organization_id for share;
  select * into v_worker from public.engineering_workers where id=v_attempt.worker_id for share;
  select * into v_attempt from public.engineering_execution_attempts
    where id=(v_binding->>'attemptId')::uuid for share;
  select * into v_profile from engineering_private.native_observer_profiles where id=p_profile for share;
  v_now := clock_timestamp();
  if v_profile.id is null or v_attempt.id is null or
    v_worker.id is null or v_worker.revoked_at is not null or
    v_worker.current_boot_id is distinct from v_attempt.boot_id or
    v_profile.runtime_admission_id <> v_attempt.runtime_admission_id or
    v_profile.observer_schema <> v_manifest->>'schema' or
    v_profile.observer_version <> v_manifest->>'observerVersion' or
    v_profile.boundary <> v_manifest->>'boundary' or
    exists(select 1 from engineering_private.native_admission_revocations
      where runtime_admission_id=v_attempt.runtime_admission_id
        or input_admission_id=v_attempt.input_admission_id) or
    v_slot_attempt is distinct from v_attempt.id or
    not v_attempt.result_eligible or v_attempt.stopped_at is not null or
    v_attempt.phase not in ('claimed','running') or
    v_now >= v_attempt.deadline_at or v_now >= v_attempt.lease_expires_at then
    raise exception using errcode='PT409',message='Observer profile or attempt is stale.';
  end if;
  v_job := v_attempt.job_text::jsonb;
  if v_binding <> jsonb_build_object(
      'organizationId',v_attempt.organization_id,'projectId',v_attempt.project_id,
      'workerId',v_attempt.worker_id,'installationId',v_attempt.installation_id,
      'bootId',v_attempt.boot_id,'taskId',v_attempt.task_id,'attemptId',v_attempt.id,
      'jobId',v_job->'jobId','runtimeAdmissionId',v_attempt.runtime_admission_id,
      'fence',v_attempt.fence,'jobSha256',v_attempt.job_sha256)
    or v_manifest->>'contextSha256' <> v_job->>'contextSha256'
    or v_manifest->>'deadline' <> to_char(v_attempt.deadline_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    or v_manifest->'totalProcesses' <> to_jsonb(jsonb_array_length(v_manifest->'observedProcesses')+1)
    or jsonb_array_length(v_manifest->'observedProcesses') <> jsonb_array_length(v_manifest->'terminalProcesses')
    or jsonb_array_length(v_manifest->'observedProcesses') < 1
    or jsonb_array_length(v_manifest->'observedProcesses') > 128
    or v_manifest->>'observerRunId' is null
    or v_manifest->>'journalHeadSha256' !~ '^[0-9a-f]{64}$'
    or v_manifest->>'journalSha256' !~ '^[0-9a-f]{64}$'
    or v_manifest->>'contextSha256' !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='Observer identity or process count differs.';
  end if;
  v_started := (v_manifest->>'startedAt')::timestamptz;
  v_observed := (v_manifest->>'observedAt')::timestamptz;
  if v_started < v_attempt.claimed_at
    or v_observed >= v_attempt.deadline_at
    or v_observed > v_now
    or v_observed < v_started
    or (v_manifest->>'deadline')::timestamptz - v_started > interval '10 minutes'
    or (v_manifest->>'observedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    or (v_manifest->>'startedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    or exists(select 1 from jsonb_array_elements(v_journal->'records') r
      where (r->>'at')::timestamptz < v_started or (r->>'at')::timestamptz > v_observed)
    or (v_manifest->>'executionOutcome'='native_exit_succeeded' and v_manifest->'failureCode'<>'null'::jsonb)
    or (v_manifest->>'executionOutcome'='native_failed' and v_manifest->'failureCode'='null'::jsonb) then
    raise exception using errcode='22023',message='Observer time or outcome invalid.';
  end if;
  v_process := v_manifest->'root';
  v_identity := v_process->'identity';
  if not engineering_private.native_observer_valid_process(v_process)
    or v_identity->>'pid' is null or v_identity->>'creationTicks' is null
    or v_identity->>'sessionId' is null or v_identity->>'executablePath' is null
    or v_process->>'executableSha256' is null or v_process->>'exitCode' is null
    or v_process->>'observedAt' is null or v_process->>'exitedAt' is null
    or v_identity->>'creationTicks' !~ '^[1-9][0-9]{0,18}$'
    or v_process->>'executableSha256' !~ '^[0-9a-f]{64}$'
    or (v_identity->>'pid')::integer not between 1 and 2147483647
    or (v_identity->>'sessionId')::integer not between 0 and 2147483647
    or (v_identity->>'creationTicks')::numeric <
      extract(epoch from v_started)*10000000+621355968000000000
    or (v_identity->>'creationTicks')::numeric >
      extract(epoch from (v_process->>'observedAt')::timestamptz)*10000000+621355968000009999
    or (v_process->>'observedAt')::timestamptz < v_started
    or (v_process->>'observedAt')::timestamptz > (v_process->>'exitedAt')::timestamptz
    or (v_process->>'exitedAt')::timestamptz > v_observed then
    raise exception using errcode='22023',message='Observer root process invalid.';
  end if;
  v_observed_pids := array_append(v_observed_pids,(v_identity->>'pid')::integer);
  for v_process in select value from jsonb_array_elements(v_manifest->'observedProcesses') loop
    v_identity := v_process->'identity';
    if not engineering_private.native_observer_valid_process(v_process)
      or not engineering_private.native_observer_has_keys(v_process,array[
        'identity','executableSha256','parentPid','observedAt','exitCode','exitedAt'])
      or not engineering_private.native_observer_has_keys(v_identity,array[
        'pid','creationTicks','sessionId','executablePath'])
      or v_identity->>'pid' is null or v_identity->>'creationTicks' is null
      or v_identity->>'sessionId' is null or v_identity->>'executablePath' is null
      or v_process->>'executableSha256' is null or v_process->>'exitCode' is null
      or v_process->>'parentPid' is null or v_process->>'observedAt' is null
      or v_process->>'exitedAt' is null
      or v_identity->>'creationTicks' !~ '^[1-9][0-9]{0,18}$'
      or v_process->>'executableSha256' !~ '^[0-9a-f]{64}$'
      or (v_identity->>'pid')::integer not between 1 and 2147483647
      or (v_identity->>'sessionId')::integer not between 0 and 2147483647
      or (v_identity->>'creationTicks')::numeric <
        (v_manifest->'root'->'identity'->>'creationTicks')::numeric
      or (v_identity->>'creationTicks')::numeric <
        extract(epoch from v_started)*10000000+621355968000000000
      or (v_identity->>'creationTicks')::numeric >
        extract(epoch from (v_process->>'observedAt')::timestamptz)*10000000+621355968000009999
      or (v_identity->>'pid')::integer = any(v_observed_pids)
      or v_process->>'parentPid' <> v_manifest->'root'->'identity'->>'pid'
      or v_identity->>'sessionId' <> v_manifest->'root'->'identity'->>'sessionId'
      or (v_process->>'observedAt')::timestamptz < v_started
      or (v_process->>'observedAt')::timestamptz > (v_process->>'exitedAt')::timestamptz
      or (v_process->>'exitedAt')::timestamptz > v_observed
      or not exists(select 1 from jsonb_each(v_launches) l
        where l.value->'start'->>'pid'=v_identity->>'pid'
          and l.value->'start'->>'creationTicks'=v_identity->>'creationTicks'
          and l.value->'start'->>'sessionId'=v_identity->>'sessionId'
          and lower(l.value->'start'->>'executablePath')=lower(v_identity->>'executablePath')
          and l.value->'start'->>'executableSha256'=v_process->>'executableSha256'
          and l.value->'exit'->>'exitCode'=v_process->>'exitCode') then
      raise exception using errcode='22023',message='Observer child process invalid.';
    end if;
    v_observed_pids := array_append(v_observed_pids,(v_identity->>'pid')::integer);
  end loop;
  select jsonb_agg(jsonb_build_object('launchId',l.key,
    'pid',l.value->'start'->'pid','creationTicks',l.value->'start'->'creationTicks',
    'sessionId',l.value->'start'->'sessionId',
    'executableSha256',l.value->'start'->'executableSha256',
    'exitCode',l.value->'exit'->'exitCode','terminationRequested',false)
    order by l.key collate "C") into v_expected_terminals from jsonb_each(v_launches) l;
  if v_manifest->'terminalProcesses' is distinct from v_expected_terminals then
    raise exception using errcode='22023',message='Observer terminal set differs.';
  end if;
  v_success := v_phase='outputs_saved' and v_failure is null
    and v_manifest->'root'->>'exitCode'='0'
    and not exists(select 1 from jsonb_each(v_launches) l
      where l.value->'exit'->>'exitCode'<>'0');
  if (v_success and (v_manifest->>'executionOutcome'<>'native_exit_succeeded'
      or v_manifest->'failureCode' <> 'null'::jsonb))
    or (not v_success and (v_manifest->>'executionOutcome'<>'native_failed'
      or v_manifest->>'failureCode' <> coalesce(v_failure,'unclassified'))) then
    raise exception using errcode='22023',message='Observer outcome differs from journal and exits.';
  end if;
  if (select count(*) from jsonb_array_elements(v_journal->'records') r
      where r->>'kind'='launch_intent') <> jsonb_array_length(v_manifest->'observedProcesses')
    or (select count(*) from jsonb_array_elements(v_journal->'records') r
      where r->>'kind'='process_started') <> jsonb_array_length(v_manifest->'observedProcesses')
    or (select count(*) from jsonb_array_elements(v_journal->'records') r
      where r->>'kind'='process_exited') <> jsonb_array_length(v_manifest->'observedProcesses')
    or exists (
      select 1 from jsonb_array_elements(v_manifest->'terminalProcesses') t
      where t->'terminationRequested' is distinct from 'false'::jsonb
        or not exists (
          select 1 from jsonb_array_elements(v_journal->'records') r
          where r->>'kind'='process_exited' and r->'data'->>'launchId'=t->>'launchId'
            and r->'data'->>'pid'=t->>'pid'
            and r->'data'->>'creationTicks'=t->>'creationTicks'
            and r->'data'->>'sessionId'=t->>'sessionId'
            and r->'data'->>'exitCode'=t->>'exitCode'
            and r->'data'->'terminationRequested'='false'::jsonb))
    or exists (
      select 1 from jsonb_array_elements(v_manifest->'observedProcesses') p
      where p->>'parentPid' <> v_manifest->'root'->'identity'->>'pid'
        or not exists (
          select 1 from jsonb_array_elements(v_journal->'records') r
          where r->>'kind'='process_started' and r->'data'->>'pid'=p->'identity'->>'pid'
            and r->'data'->>'creationTicks'=p->'identity'->>'creationTicks'
            and r->'data'->>'sessionId'=p->'identity'->>'sessionId'
            and r->'data'->>'executableSha256'=p->>'executableSha256')) then
    raise exception using errcode='22023',message='Observer process/journal set differs.';
  end if;
  v_terminal := v_manifest->'terminalProcesses';
  insert into engineering_private.native_observer_evidence (
    profile_id,runtime_admission_id,observer_run_id,attempt_id,task_id,organization_id,
    project_id,worker_id,installation_id,boot_id,session_id,fence,job_id,job_sha256,
    context_sha256,manifest_bytes,manifest_sha256,journal_bytes,journal_sha256,
    journal_head_sha256,observer_schema,observer_version,boundary,profile_version,
    verdict,terminal_processes,execution_outcome,observed_at,validator_version,admitted_by
  ) values (
    v_profile.id,v_attempt.runtime_admission_id,(v_manifest->>'observerRunId')::uuid,
    v_attempt.id,v_attempt.task_id,v_attempt.organization_id,v_attempt.project_id,
    v_attempt.worker_id,v_attempt.installation_id,v_attempt.boot_id,v_attempt.session_id,
    v_attempt.fence,(v_job->>'jobId')::uuid,v_attempt.job_sha256,v_job->>'contextSha256',
    p_manifest,encode(extensions.digest(p_manifest,'sha256'),'hex'),
    p_journal,encode(extensions.digest(p_journal,'sha256'),'hex'),
    v_journal->>'headSha256',v_manifest->>'schema',v_manifest->>'observerVersion',
    v_manifest->>'boundary',v_profile.profile_version,v_manifest->>'verdict',
    v_terminal,v_manifest->>'executionOutcome',(v_manifest->>'observedAt')::timestamptz,
    'observer-registry-validator/1',v_actor
  ) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function engineering_private.store_native_observer_evidence(uuid,bytea,bytea)
  from public,anon,authenticated,service_role;
grant execute on function engineering_private.store_native_observer_evidence(uuid,bytea,bytea)
  to ovd575_observer_validator;
