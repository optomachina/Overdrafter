-- OVD-576 follow-up: the original exact-attempt contract omitted the caller's
-- fence. Keep the admitted implementation private behind a checked wrapper.
-- No principal, credential, qualification, table grant or endpoint is added.
create function engineering_private.admit_qualified_native_stop(
  p_worker uuid,p_credential text,p_boot uuid,p_task uuid,p_attempt uuid,
  p_fence bigint,p_evidence uuid,p_revision bigint,p_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_task public.engineering_tasks%rowtype;
  v_attempt public.engineering_execution_attempts%rowtype;
begin
  if current_setting('role') <> 'ovd576_stop_validator' then
    raise exception using errcode='42501',message='Stop validator executor required.';
  end if;
  -- Preserve slot -> worker -> conversation -> task -> attempt order. The
  -- internal implementation re-enters these same transaction-held locks.
  v_task := engineering_private.lock_native_task(p_worker,p_credential,p_task,false);
  select * into v_attempt from public.engineering_execution_attempts
    where id=p_attempt for update;
  if v_attempt.id is null or v_attempt.task_id<>v_task.id
    or v_attempt.worker_id<>p_worker or v_attempt.boot_id is distinct from p_boot then
    raise exception using errcode='42501',message='Native attempt access denied.';
  end if;
  -- Check on EVERY call, including an exact-key retry after occupancy release.
  -- The caller must present the original attempt fence, not a later slot fence.
  if p_fence is null or p_fence not between 1 and 9007199254740991
    or p_fence<>v_attempt.fence then
    raise exception using errcode='PT409',message='Exact native attempt fence required.';
  end if;
  -- SECURITY DEFINER changes current_user, not the selected role checked by
  -- the internal function. It still checks current actor/worker authority,
  -- evidence qualification, revocations and atomic idempotent transition.
  return engineering_private.admit_qualified_native_stop(
    p_worker,p_credential,p_boot,p_task,p_attempt,p_evidence,p_revision,p_key);
end;
$$;
revoke all on function engineering_private.admit_qualified_native_stop(
  uuid,text,uuid,uuid,uuid,bigint,uuid,bigint,uuid)
  from public,anon,authenticated,service_role;
revoke all on function engineering_private.admit_qualified_native_stop(
  uuid,text,uuid,uuid,uuid,uuid,bigint,uuid)
  from public,anon,authenticated,service_role,ovd576_stop_validator;
grant execute on function engineering_private.admit_qualified_native_stop(
  uuid,text,uuid,uuid,uuid,bigint,uuid,bigint,uuid)
  to ovd576_stop_validator;
-- Roll forward to revoke the checked grant if containment is needed. Never
-- restore unchecked execute or delete immutable qualification/stop history.
