import { isDeepStrictEqual } from "node:util";
import type { NativeResultRepository } from "./native-result-receipt";
import type { ResultReadAdmission } from "./native-result-bytes";
import type { PrivateArtifactSql, PrivateArtifactStorage, ArtifactStorageObject } from "./native-artifact-repository";
import { validateAdmittedReportProcess, validateNativeFilesystemAdmission } from "./native-reports";

/** Private owner connection only. No worker credential or request-supplied path
 * participates in these queries. OVD561 repeats authority checks under locks. */
export const RESULT_READER_AUTHORITY_SQL = `
select a.*, s.context_text from public.engineering_execution_attempts a
join public.engineering_tasks t on t.id=a.task_id
join public.engineering_task_execution x on x.task_id=t.id and x.current_attempt_id=a.id
join public.engineering_conversations c on c.id=a.conversation_id and c.head_snapshot_id=a.input_snapshot_id
join public.engineering_snapshots s on s.id=a.input_snapshot_id
join public.engineering_workers w on w.id=a.worker_id
join engineering_private.native_result_read_bindings b on b.attempt_id=a.id
join engineering_private.native_observer_evidence e on e.id=b.evidence_id and e.attempt_id=a.id
join engineering_private.native_stop_qualifications q on q.evidence_id=e.id and q.attempt_id=a.id
join engineering_private.native_stop_admissions stop on stop.id=a.stop_admission_id and stop.attempt_id=a.id
where a.task_id=$1::uuid and a.id=$2::uuid
and a.phase='awaiting_result' and a.result_eligible and clock_timestamp()<a.deadline_at
and t.execution_state='running' and t.verification_state in ('unverified','checking')
and w.revoked_at is null and w.current_boot_id=a.boot_id
and engineering_private.engineering_actor_access(t.owner_user_id,t.organization_id,t.project_id)
and not exists (select 1 from engineering_private.native_admission_revocations r
 where r.runtime_admission_id=a.runtime_admission_id or r.input_admission_id=a.input_admission_id)
and stop.authority='qualified_worker_validator' and stop.execution_outcome='native_exit_succeeded'
and stop.evidence_sha256=e.manifest_sha256 and stop.journal_sha256=e.journal_sha256
and q.manifest_sha256=e.manifest_sha256 and q.journal_sha256=e.journal_sha256
and q.job_sha256=a.job_sha256 and q.context_sha256=s.context_sha256
and q.scope='prepared_native_exact_attempt_v1'`;
export const RESULT_READER_LOAD_SQL = `with authority as (${RESULT_READER_AUTHORITY_SQL})
select jsonb_build_object('taskId',a.task_id,'contextText',a.context_text,'jobText',a.job_text,
 'active',jsonb_build_object('scope',jsonb_build_object('organizationId',a.organization_id,'projectId',a.project_id),
 'jobId',a.job_text::jsonb->>'jobId','attemptId',a.id,'fence',a.fence,'inputSnapshotId',a.input_snapshot_id,
 'contextSha256',a.job_text::jsonb->>'contextSha256','outputSnapshotId',a.output_snapshot_id),
 'process',b.process,'filesystem',b.filesystem,'objects',(
 select jsonb_agg(jsonb_build_object('id',r.storage_object_id,'scope',jsonb_build_object('organizationId',r.organization_id,'projectId',r.project_id),
 'taskId',r.task_id,'attemptId',r.attempt_id,'fence',r.fence,'inputSnapshotId',r.input_snapshot_id,
 'candidateSnapshotId',r.candidate_snapshot_id,'role',r.artifact_role,'bytes',r.byte_length,'sha256',r.sha256) order by r.artifact_role)
 from engineering_private.native_verifier_registered_objects r
 join storage.objects o on o.id=r.storage_object_id and o.bucket_id=r.bucket_id and o.name=r.object_name
 and o.version=r.storage_version and o.updated_at=r.storage_updated_at
 join storage.buckets bucket on bucket.id=o.bucket_id and not bucket.public where r.attempt_id=a.id)) as admission
from authority a join engineering_private.native_result_read_bindings b on b.attempt_id=a.id`;
export const RESULT_READER_OBJECT_SQL = `with authority as (${RESULT_READER_AUTHORITY_SQL})
select o.id as "storageObjectId",o.bucket_id as "bucketId",o.name as "objectName",
 o.version as "storageVersion",o.updated_at::text as "storageUpdatedAt"
from authority a join engineering_private.native_verifier_registered_objects r on r.attempt_id=a.id
join storage.objects o on o.id=r.storage_object_id and o.bucket_id=r.bucket_id and o.name=r.object_name
 and o.version=r.storage_version and o.updated_at=r.storage_updated_at
join storage.buckets b on b.id=o.bucket_id and not b.public where r.storage_object_id=$3::uuid`;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const validId = (value: unknown): value is string => typeof value === "string" && uuid.test(value);

/** One repository per exact verification invocation. No cross-request cache or
 * ambient identities. Registered bytes are fetched through private generation GET. */
export function createNativeResultReader(config: {
 sql: PrivateArtifactSql; storage: PrivateArtifactStorage; taskId: string; attemptId: string;
 enabled?: boolean; signal?: AbortSignal;
}): NativeResultRepository {
 const { sql, storage, taskId, attemptId } = config, enabled = config.enabled === true;
 if (!validId(taskId) || !validId(attemptId)) throw new TypeError("Invalid result reader identity.");
 const signal = config.signal ?? new AbortController().signal;
 const guard = () => { if (!enabled || signal.aborted) throw new Error("Native result reader disabled or interrupted."); };
 const load = async (): Promise<ResultReadAdmission | null> => {
  guard();
  const rows = await sql.query(RESULT_READER_LOAD_SQL,[taskId,attemptId],{signal,timeoutMs:30000}); guard();
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new TypeError("Ambiguous native result admission.");
  const admission = structuredClone(rows[0].admission) as ResultReadAdmission;
  if (!admission || admission.taskId !== taskId || admission.active?.attemptId !== attemptId
   || !Array.isArray(admission.objects) || admission.objects.length !== 7) throw new TypeError("Incomplete native result admission.");
  validateAdmittedReportProcess(admission.process);
  validateNativeFilesystemAdmission(admission.filesystem,admission.process.candidateRoot);
  return admission;
 };
 return Object.freeze({
  async loadAdmission(task,attempt) { guard(); if (task!==taskId || attempt!==attemptId) return null; return load(); },
  async readRegisteredObject(id,readSignal) {
   guard(); if (!validId(id) || readSignal.aborted) throw new TypeError("Invalid registered object identity.");
   const rows=await sql.query(RESULT_READER_OBJECT_SQL,[taskId,attemptId,id],{signal:readSignal,timeoutMs:30000}); guard();
   if (readSignal.aborted) throw new Error("Native result read interrupted.");
   if (rows.length!==1) throw new TypeError("Registered object unavailable.");
   const object=rows[0] as ArtifactStorageObject;
   if (object.storageObjectId!==id || ![object.bucketId,object.objectName,object.storageVersion,object.storageUpdatedAt]
    .every(value=>typeof value==='string' && value.length>0)) throw new TypeError("Invalid registered storage binding.");
   const response=await storage.read({...object,method:"GET",ifMatch:object.storageVersion},readSignal);
   if (readSignal.aborted || signal.aborted) {
    void response.body?.cancel().catch(()=>undefined);
    throw new Error("Native result read interrupted.");
   }
   return response;
  },
  async isCurrent(admission) { const current=await load(); return current!==null && isDeepStrictEqual(current,admission); },
 });
}
