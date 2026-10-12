#!/usr/bin/env python3
"""Emit inert rollback SQL for an EXISTING exclusively-owned qualified fixture.
No connection, credential lookup, SQL execution or network access occurs.
"""
import argparse
import json
import uuid
import re
from pathlib import Path

p = argparse.ArgumentParser()
for name in ('task', 'attempt', 'evidence'):
    p.add_argument('--' + name, type=uuid.UUID)
p.add_argument('--filesystem-json', required=True)
p.add_argument('--canonical-fixture', '--dynamic-first-loop', action='store_true', help='Use fixed pg_temp.task/attempt/first_loop_evidence helpers')
p.add_argument('--fragment', action='store_true', help='Append inside builder-owned transaction; omit BEGIN/ROLLBACK')
a = p.parse_args()
if a.canonical_fixture:
    if any((a.task,a.attempt,a.evidence)):
        p.error('canonical fixture and explicit identities are mutually exclusive')
    task_sql,attempt_sql,evidence_sql = 'pg_temp.task()', 'pg_temp.attempt()', 'pg_temp.first_loop_evidence()'
else:
    if not all((a.task,a.attempt,a.evidence)):
        p.error('provide task, attempt, evidence or --canonical-fixture')
    task_sql,attempt_sql,evidence_sql = ("'" + str(value) + "'::uuid" for value in (a.task,a.attempt,a.evidence))
begin_sql = '' if a.fragment else 'begin;'
end_sql = '' if a.fragment else "rollback;\nselect not exists(select 1 from engineering_private.native_result_read_bindings where attempt_id="+attempt_sql+") as rollback_removed_fixture_binding;"
fs = json.loads(a.filesystem_json)
assert isinstance(fs, dict) and set(fs) == {'input', 'candidate'}
# Dollar delimiter cannot be injected by data; JSON becomes a quoted SQL literal.
literal = json.dumps(fs, separators=(',', ':')).replace("'", "''")
source = (Path(__file__).resolve().parents[1] / 'server/engineering/native-result-reader.ts').read_text()
def exported_sql(name):
    match = re.search(r'export const ' + name + r' = `([\s\S]*?)`;', source)
    if match is None:
        raise ValueError('SQL export missing: ' + name)
    return match.group(1)
authority = exported_sql('RESULT_READER_AUTHORITY_SQL')
load_sql = exported_sql('RESULT_READER_LOAD_SQL').replace('${RESULT_READER_AUTHORITY_SQL}', authority)
object_sql = exported_sql('RESULT_READER_OBJECT_SQL').replace('${RESULT_READER_AUTHORITY_SQL}', authority)
assert '${' not in load_sql + object_sql
print(f"""{begin_sql}
set local statement_timeout='30s';
set local lock_timeout='5s';
create function pg_temp.reader_load(uuid,uuid) returns setof jsonb language sql as $reader_load$
{load_sql}
$reader_load$;
create function pg_temp.reader_object(uuid,uuid,uuid) returns table("storageObjectId" uuid,"bucketId" text,"objectName" text,"storageVersion" text,"storageUpdatedAt" text) language sql as $reader_object$
{object_sql}
$reader_object$;
create temporary table result_reader_proof_input(task uuid,attempt uuid,evidence uuid,filesystem jsonb);
insert into result_reader_proof_input values({task_sql},{attempt_sql},{evidence_sql},'{literal}'::jsonb);
do $proof$
declare i record; answer jsonb; again jsonb; role_name text; admission jsonb; object jsonb; records jsonb; expected_native jsonb; expected_helper jsonb;
begin
 select * into strict i from result_reader_proof_input;
 if exists(select 1 from engineering_private.native_result_read_bindings where attempt_id=i.attempt) then raise exception 'fixture_binding_must_be_absent'; end if;
 answer:=engineering_private.admit_native_result_read_binding(i.task,i.attempt,i.evidence,i.filesystem,repeat('a',64));
 again:=engineering_private.admit_native_result_read_binding(i.task,i.attempt,i.evidence,i.filesystem,repeat('a',64));
 if answer is distinct from again then raise exception 'exact_replay_failed'; end if;
 select * into strict admission from pg_temp.reader_load(i.task,i.attempt);
 if admission->>'taskId'<>i.task::text or admission#>>'{{active,attemptId}}'<>i.attempt::text
  or admission->'process'<>answer or admission->'filesystem'<>i.filesystem
  or jsonb_array_length(admission->'objects')<>7 then raise exception 'reader_exact_admission_failed'; end if;
 if (select array_agg(o->>'role' order by o->>'role') from jsonb_array_elements(admission->'objects') o)
  is distinct from array['assembly','companion','identity','native','preservation','result','target'] then raise exception 'reader_roles_failed'; end if;
 select convert_from(journal_bytes,'UTF8')::jsonb->'records' into records from engineering_private.native_observer_evidence where id=i.evidence;
 select started->'data' into strict expected_native from jsonb_array_elements(records) intent
 join jsonb_array_elements(records) started on started#>>'{{data,launchId}}'=intent#>>'{{data,launchId}}'
 where intent->>'kind'='launch_intent' and intent#>>'{{data,role}}'='native' and started->>'kind'='process_started';
 select started->'data' into strict expected_helper from jsonb_array_elements(records) intent
 join jsonb_array_elements(records) started on started#>>'{{data,launchId}}'=intent#>>'{{data,launchId}}'
 where intent->>'kind'='launch_intent' and intent#>>'{{data,role}}'='operation' and started->>'kind'='process_started';
 if answer->'nativePid' is distinct from expected_native->'pid'
  or answer->>'nativeStartTicks' is distinct from expected_native->>'creationTicks'
  or answer->'helperPid' is distinct from expected_helper->'pid' then raise exception 'reader_process_derivation_failed'; end if;
 for object in select value from jsonb_array_elements(admission->'objects') loop
  if object->>'taskId'<>i.task::text or object->>'attemptId'<>i.attempt::text
   or object->'scope'<>admission#>'{{active,scope}}' or object->'fence'<>admission#>'{{active,fence}}'
   or (select count(*) from pg_temp.reader_object(i.task,i.attempt,(object->>'id')::uuid))<>1 then raise exception 'reader_object_scope_failed'; end if;
 end loop;
 if exists(select 1 from pg_temp.reader_object(i.task,i.attempt,'00000000-0000-4000-8000-000000000001')) then raise exception 'reader_foreign_object'; end if;
 -- Each negative subtransaction rolls its fixture change back independently.
 begin
  update storage.objects set version='result-reader-proof-replaced' where id=(admission#>>'{{objects,0,id}}')::uuid;
  if exists(select 1 from pg_temp.reader_object(i.task,i.attempt,(admission#>>'{{objects,0,id}}')::uuid)) then raise exception 'reader_generation_replacement_accepted'; end if;
  select * into strict again from pg_temp.reader_load(i.task,i.attempt);
  if jsonb_array_length(again->'objects')<>6 or again=admission then raise exception 'reader_generation_freshness_failed'; end if;
  raise exception using errcode='ZX001';
 exception when sqlstate 'ZX001' then null; end;
 begin
  update storage.buckets set public=true where id in(select bucket_id from engineering_private.native_verifier_registered_objects where attempt_id=i.attempt);
  if exists(select 1 from pg_temp.reader_object(i.task,i.attempt,(admission#>>'{{objects,0,id}}')::uuid)) then raise exception 'reader_public_bucket_accepted'; end if;
  raise exception using errcode='ZX001';
 exception when sqlstate 'ZX001' then null; end;
 begin
  update public.engineering_task_execution set current_attempt_id=null,revision=revision+1,retry_mode=null,retry_boot_id=null,retry_session_id=null where task_id=i.task;
  if exists(select 1 from pg_temp.reader_load(i.task,i.attempt)) then raise exception 'reader_stale_attempt_accepted'; end if;
  raise exception using errcode='ZX001';
 exception when sqlstate 'ZX001' then null; end;
 begin
  insert into engineering_private.native_admission_revocations(input_admission_id,revoked_by,reason)
   select input_admission_id,owner_user_id,'owned disposable result reader proof' from public.engineering_execution_attempts where id=i.attempt;
  if exists(select 1 from pg_temp.reader_load(i.task,i.attempt)) then raise exception 'reader_revocation_accepted'; end if;
  raise exception using errcode='ZX001';
 exception when sqlstate 'ZX001' then null; end;
 if (select value from pg_temp.reader_load(i.task,i.attempt) value) is distinct from admission then raise exception 'reader_subtransaction_restore_failed'; end if;

 begin
  perform engineering_private.admit_native_result_read_binding(i.task,i.attempt,i.evidence,i.filesystem,repeat('b',64));
  raise exception 'changed_replay_accepted';
 exception when unique_violation then null; end;
 begin
  perform engineering_private.admit_native_result_read_binding(i.task,i.attempt,i.evidence,jsonb_build_object('input',i.filesystem->'input','candidate',i.filesystem->'input'),repeat('a',64));
  raise exception 'filesystem_alias_accepted';
 exception when invalid_parameter_value then null; end;
 begin
  perform engineering_private.admit_native_result_read_binding(i.task,i.attempt,'00000000-0000-4000-8000-000000000001',i.filesystem,repeat('a',64));
  raise exception 'foreign_evidence_accepted';
 exception when insufficient_privilege then null; end;
 begin
  update engineering_private.native_result_read_bindings set qualification_sha256=repeat('b',64) where attempt_id=i.attempt;
  raise exception 'immutable_update_accepted';
 exception when sqlstate '55000' then null; end;
 foreach role_name in array array['anon','authenticated','service_role'] loop
  if has_table_privilege(role_name,'engineering_private.native_result_read_bindings','SELECT,INSERT,UPDATE,DELETE')
   or has_function_privilege(role_name,'engineering_private.admit_native_result_read_binding(uuid,uuid,uuid,jsonb,text)','EXECUTE') then raise exception 'unexpected_grant_%',role_name; end if;
 end loop;
end $proof$;
{end_sql}
""")
