-- Synthetic metadata uses exact targets admitted by the real mapping writer.
insert into storage.objects(bucket_id,name,version)
select bucket_id,object_name,'pinned-result-v1'
from engineering_private.native_artifact_outputs where attempt_id=pg_temp.attempt();
select ok(engineering_private.register_native_result_object(a.organization_id,a.project_id,a.task_id,a.id,a.fence,
 a.input_snapshot_id,a.output_snapshot_id,target.role,obj.bucket_id,obj.name,obj.id,obj.version,obj.updated_at,100,pg_temp.h(30)),
 'real registry accepts mapped synthetic metadata: '||target.role)
from public.engineering_execution_attempts a
join engineering_private.native_artifact_outputs target on target.attempt_id=a.id
join storage.objects obj on obj.bucket_id=target.bucket_id and obj.name=target.object_name
where a.id=pg_temp.attempt();
select is((select count(*) from engineering_private.native_verifier_registered_objects where attempt_id=pg_temp.attempt()),
 7::bigint,'all seven actual registry rows retained');
