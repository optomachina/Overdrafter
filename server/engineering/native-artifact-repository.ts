/** Source-only private queries. No connections or credentials are created.
 * Requires docs/release/private-artifact-forward.sql and staged OVD-560.
 * The eventual SQL executor must possess the existing owner-only registration
 * capability; a service-role PostgREST client cannot substitute for it. */
export const ARTIFACT_AUTHORITY_SQL = `
select jsonb_build_object(
  'organizationId',a.organization_id,'projectId',a.project_id,
  'workerId',a.worker_id,'installationId',a.installation_id,
  'bootId',a.boot_id,'sessionId',a.session_id,'taskId',a.task_id,
  'attemptId',a.id,'fence',a.fence,'inputSnapshotId',a.input_snapshot_id,
  'candidateSnapshotId',a.output_snapshot_id,'predecessorAttemptId',i.producer_attempt_id
) as scope, a.input_admission_id as "inputAdmissionId",
  engineering_private.native_attempt_reason(a,w,clock_timestamp()) = 'eligible' as "inputEligible",
  (a.phase='awaiting_result' and a.result_eligible and a.stop_admission_id is not null
    and a.stopped_at is not null and t.verification_state in ('unverified','checking')) as "outputEligible"
from public.engineering_execution_attempts a
join public.engineering_workers w on w.id=a.worker_id
join public.engineering_worker_sessions s on s.id=a.session_id
join public.engineering_task_execution tx on tx.task_id=a.task_id and tx.current_attempt_id=a.id
join public.engineering_tasks t on t.id=a.task_id
join engineering_private.native_input_admissions i on i.id=a.input_admission_id
where a.id=$1::uuid and a.task_id=$2::uuid
  and exists (select 1 from engineering_private.worker_credentials c
    where c.worker_id=w.id and c.credential_sha256=$3::text)
  and w.revoked_at is null and w.installation_id=a.installation_id
  and w.current_boot_id=a.boot_id and w.current_session_id=a.session_id
  and s.worker_id=w.id and s.boot_id=a.boot_id and s.installation_id=a.installation_id
  and s.paused_at is null and clock_timestamp()<s.expires_at
  and w.organization_id=a.organization_id and w.project_id=a.project_id
  and w.owner_user_id=a.owner_user_id and s.owner_user_id=a.owner_user_id
  and s.organization_id=a.organization_id and s.project_id=a.project_id
  and engineering_private.engineering_actor_access(a.owner_user_id,a.organization_id,a.project_id)
  and not exists (select 1 from engineering_private.native_admission_revocations r
    where r.runtime_admission_id=a.runtime_admission_id or r.input_admission_id=a.input_admission_id)`;

// Each ordinal must agree with the frozen job, not merely a worker-supplied hash.
export const ARTIFACT_INPUT_SQL = `
select m.id, m.byte_length as bytes, m.sha256, o.id as "storageObjectId",
 o.bucket_id as "bucketId",o.name as "objectName",o.version as "storageVersion",
 o.updated_at::text as "storageUpdatedAt"
from engineering_private.native_artifact_inputs m
join public.engineering_execution_attempts a on a.input_admission_id=m.input_admission_id
join storage.objects o on o.id=m.storage_object_id and o.version=m.storage_version
  and o.updated_at=m.storage_updated_at
join storage.buckets b on b.id=o.bucket_id and not b.public
where a.id=$1::uuid and m.id=$2::uuid
  and (select count(*) from engineering_private.native_artifact_inputs all_inputs
       where all_inputs.input_admission_id=a.input_admission_id)=3
  and jsonb_array_length(a.job_text::jsonb->'inputFiles')=3
  and not exists (select 1 from engineering_private.native_artifact_inputs mapped
    where mapped.input_admission_id=a.input_admission_id
    and ((a.job_text::jsonb->'inputFiles'->mapped.ordinal->>'sha256') is distinct from mapped.sha256
      or (a.job_text::jsonb->'inputFiles'->mapped.ordinal->>'bytes') is distinct from mapped.byte_length::text))`;

export const ARTIFACT_OUTPUT_SQL = `
select m.bucket_id as "bucketId",m.object_name as "objectName",
 o.id as "storageObjectId",o.version as "storageVersion",o.updated_at::text as "storageUpdatedAt"
from engineering_private.native_artifact_outputs m
join storage.buckets b on b.id=m.bucket_id and not b.public
left join storage.objects o on o.bucket_id=m.bucket_id and o.name=m.object_name
where m.attempt_id=$1::uuid and m.role=$2::text
  and (select count(*) from engineering_private.native_artifact_outputs targets
       where targets.attempt_id=m.attempt_id)=7`;

// Guard again in the actual registration statement, after every blocking lock.
// Parameter replacement is over this constant SQL only, never caller text.
const finalAuthority = ARTIFACT_AUTHORITY_SQL.replace(/\$([123])::/g,
  (_, number: string) => `$${Number(number) + 15}::`);
export const ARTIFACT_REGISTER_SQL = `with authority as (${finalAuthority})
select engineering_private.register_native_result_object(
 $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::uuid,$7::uuid,$8::text,
 $9::text,$10::text,$11::uuid,$12::text,$13::timestamptz,$14::bigint,$15::text) as registered
from authority where scope=$19::jsonb and "outputEligible"`;

export const ARTIFACT_ISOLATION_SQL = `select current_setting('transaction_isolation') as isolation`;
export const ARTIFACT_ATTEMPT_LOCK_SQL = `select id from public.engineering_execution_attempts
where id=$1::uuid and task_id=$2::uuid for update`;
export const ARTIFACT_AUTHORITY_LOCK_SQL = `lock table engineering_private.native_admission_revocations,
 engineering_private.engineering_operators, public.organization_memberships,
 public.project_memberships, public.projects in share mode`;
export const ARTIFACT_STORAGE_LOCK_SQL = `select o.id from storage.objects o
join storage.buckets b on b.id=o.bucket_id and not b.public
where o.id=$1::uuid and o.bucket_id=$2::text and o.name=$3::text
  and o.version=$4::text and o.updated_at=$5::timestamptz for share of o,b`;

export const ARTIFACT_LOCK_SQL = `select id from engineering_private.lock_native_task($1::uuid,$2::text,$3::uuid,false)`;

export type PrivateArtifactSql = {
  /** Same connection, READ COMMITTED, rollback on error; no automatic transaction retry. */
  transaction: <T>(work: (sql: PrivateArtifactSql) => Promise<T>, options: { signal: AbortSignal; timeoutMs: 30000; isolation: "read committed" }) => Promise<T>;
  query: (text: string, values: readonly unknown[], options: { signal: AbortSignal; timeoutMs: 30000 }) => Promise<readonly Record<string, unknown>[]>;
};
export type ArtifactStorageObject = Readonly<{
  storageObjectId: string; bucketId: string; objectName: string;
  storageVersion: string; storageUpdatedAt: string;
}>;
/** GET must enforce exact Storage generation; ifMatch is the expected database
 * version, NOT an HTTP ETag. Supabase REST uses versionId plus SQL pre/post
 * identity checks. PUT means atomic create-only (REST POST x-upsert:false),
 * never upsert/overwrite. Conflict is explicit; timeouts are
 * thrown as unknown outcomes, not converted into conflict or retried. No URLs,
 * paths, bucket names or credentials come from the worker request. */
export type PrivateArtifactStorage = {
  read: (operation: ArtifactStorageObject & { method: "GET"; ifMatch: string }, signal: AbortSignal) => Promise<Response>;
  create: (operation: { method: "PUT"; bucketId: string; objectName: string;
    ifNoneMatch: "*"; contentType: "application/octet-stream"; bytes: Uint8Array }, signal: AbortSignal) => Promise<"created" | "conflict">;
};
