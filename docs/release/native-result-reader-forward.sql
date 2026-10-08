-- STAGED SOURCE ONLY. Purpose: independently admitted filesystem handles bound
-- to existing qualified observer evidence, for the seven-role result verifier.
-- Prerequisites: OVD575/576/577, staged OVD558/560. No grants, roles or seeds.
-- Owner must obtain filesystem identities independently; worker reports are NOT
-- admission inputs. qualification_sha256 names that retained independent proof.
begin;
create table engineering_private.native_result_read_bindings (
 attempt_id uuid primary key references public.engineering_execution_attempts(id),
 evidence_id uuid not null unique references engineering_private.native_stop_qualifications(evidence_id),
 process jsonb not null,
 filesystem jsonb not null,
 qualification_sha256 text not null check (qualification_sha256 ~ '^[0-9a-f]{64}$'),
 admitted_at timestamptz not null default clock_timestamp()
);
alter table engineering_private.native_result_read_bindings enable row level security;
revoke all on engineering_private.native_result_read_bindings from public,anon,authenticated,service_role;
create trigger native_result_read_binding_immutable before update or delete
 on engineering_private.native_result_read_bindings for each row
 execute function engineering_private.reject_engineering_history_mutation();
create function engineering_private.admit_native_result_read_binding(
 p_task uuid,p_attempt uuid,p_evidence uuid,p_filesystem jsonb,p_qualification_sha256 text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 a public.engineering_execution_attempts%rowtype;
 e engineering_private.native_observer_evidence%rowtype;
 q engineering_private.native_stop_qualifications%rowtype;
 prior engineering_private.native_result_read_bindings%rowtype;
 records jsonb; native_process jsonb; helper_process jsonb; process jsonb; directory jsonb;
begin
 if current_user<>'postgres' then raise exception 'native_result_binding_owner_required' using errcode='42501'; end if;
 select * into a from public.engineering_execution_attempts where id=p_attempt and task_id=p_task for update;
 lock table engineering_private.native_admission_revocations, engineering_private.engineering_operators,
  public.organization_memberships,public.project_memberships,public.projects in share mode;
 select * into e from engineering_private.native_observer_evidence where id=p_evidence and attempt_id=p_attempt;
 select * into q from engineering_private.native_stop_qualifications where evidence_id=p_evidence and attempt_id=p_attempt;
 if a.id is null or e.id is null or q.evidence_id is null
  or not exists(select 1 from public.engineering_workers w where w.id=a.worker_id and w.revoked_at is null and w.current_boot_id=a.boot_id)
  or not exists(select 1 from engineering_private.native_stop_admissions stop where stop.id=a.stop_admission_id
   and stop.attempt_id=a.id and stop.authority='qualified_worker_validator' and stop.execution_outcome='native_exit_succeeded'
   and stop.evidence_sha256=e.manifest_sha256 and stop.journal_sha256=e.journal_sha256)
  or a.phase<>'awaiting_result' or not a.result_eligible or a.stop_admission_id is null
  or clock_timestamp()>=a.deadline_at
  or not engineering_private.engineering_actor_access(a.owner_user_id,a.organization_id,a.project_id)
  or exists(select 1 from engineering_private.native_admission_revocations r
   where r.runtime_admission_id=a.runtime_admission_id or r.input_admission_id=a.input_admission_id)
  or not exists(select 1 from public.engineering_task_execution x where x.task_id=p_task and x.current_attempt_id=a.id)
  or q.scope<>'prepared_native_exact_attempt_v1' or q.job_sha256<>a.job_sha256
  or q.context_sha256 is distinct from a.job_text::jsonb->>'contextSha256'
  or q.manifest_sha256<>e.manifest_sha256 or q.journal_sha256<>e.journal_sha256
  or e.execution_outcome<>'native_exit_succeeded'
  or p_qualification_sha256 is null or p_qualification_sha256 !~ '^[0-9a-f]{64}$'
  then raise exception 'native_result_binding_unqualified' using errcode='42501'; end if;
 if not engineering_private.native_observer_has_keys(p_filesystem,array['input','candidate']) then
  raise exception 'native_result_binding_filesystem' using errcode='22023'; end if;
 foreach directory in array array[p_filesystem->'input',p_filesystem->'candidate'] loop
  if not engineering_private.native_observer_has_keys(directory,array['path','volumeSerial','fileId'])
   or jsonb_typeof(directory->'path') is distinct from 'string'
   or not engineering_private.native_observer_valid_windows_path(directory->>'path',false)
   or jsonb_typeof(directory->'volumeSerial') is distinct from 'string'
   or directory->>'volumeSerial' !~ '^[0-9a-f]{16}$'
   or jsonb_typeof(directory->'fileId') is distinct from 'string'
   or directory->>'fileId' !~ '^[0-9a-f]{32}$' or directory->>'fileId'=repeat('0',32)
   then raise exception 'native_result_binding_filesystem' using errcode='22023'; end if;
 end loop;
 if lower(p_filesystem#>>'{input,path}')=lower(p_filesystem#>>'{candidate,path}')
  or (p_filesystem#>>'{input,volumeSerial}'=p_filesystem#>>'{candidate,volumeSerial}'
   and p_filesystem#>>'{input,fileId}'=p_filesystem#>>'{candidate,fileId}') then
  raise exception 'native_result_binding_alias' using errcode='22023'; end if;
 -- These retained journal bytes were independently validated by OVD575 and
 -- separately qualified by OVD576. The caller supplies no PID or role mapping.
 records := convert_from(e.journal_bytes,'UTF8')::jsonb->'records';
 select started->'data' into strict native_process from jsonb_array_elements(records) intent
 join jsonb_array_elements(records) started on started->'data'->>'launchId'=intent->'data'->>'launchId'
 where intent->>'kind'='launch_intent' and intent->'data'->>'role'='native' and started->>'kind'='process_started';
 select started->'data' into strict helper_process from jsonb_array_elements(records) intent
 join jsonb_array_elements(records) started on started->'data'->>'launchId'=intent->'data'->>'launchId'
 where intent->>'kind'='launch_intent' and intent->'data'->>'role'='operation' and started->>'kind'='process_started';
 process:=jsonb_build_object('nativePid',native_process->'pid','nativeStartTicks',native_process->>'creationTicks',
  'helperPid',helper_process->'pid','candidateRoot',p_filesystem#>>'{candidate,path}');
 select * into prior from engineering_private.native_result_read_bindings where attempt_id=p_attempt;
 if prior.attempt_id is not null then
  if prior.evidence_id=p_evidence and prior.process=process and prior.filesystem=p_filesystem
   and prior.qualification_sha256=p_qualification_sha256 then return prior.process; end if;
  raise exception 'native_result_binding_conflict' using errcode='23505';
 end if;
 insert into engineering_private.native_result_read_bindings(attempt_id,evidence_id,process,filesystem,qualification_sha256)
 values(p_attempt,p_evidence,process,p_filesystem,p_qualification_sha256);
 return process;
end $$;
revoke all on function engineering_private.admit_native_result_read_binding(uuid,uuid,uuid,jsonb,text)
 from public,anon,authenticated,service_role;
commit;
