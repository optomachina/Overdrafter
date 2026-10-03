import type { PrivateArtifactSql, PrivateArtifactStorage } from "./native-artifact-repository";
import type { NativeOwnerSqlPool } from "./native-result-executor";
import { createNativeResultReader } from "./native-result-reader";
import { createNativeResultRepository } from "./native-result-repository";
import { createNativeResultFinalizer, type NativeFinalizationOptions } from "./native-result-finalization";
import { validateAdmittedReportProcess, validateNativeFilesystemAdmission, type NativeFilesystemAdmission, type AdmittedReportProcess } from "./native-reports";

export const RESULT_BINDING_WRITE_SQL = "select engineering_private.admit_native_result_read_binding($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::text) as process";
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** Internal owner service, never a worker/public HTTP handler. Filesystem input
 * must be measured independently by an authorized operator and retained with
 * the proof digest; accepting worker JSON here would violate this contract. */
export function createNativeResultBindingWriter(config: {sql:PrivateArtifactSql;enabled?:boolean}) {
 const sql=config.sql, enabled=config.enabled===true;
 return async (input:{taskId:string;attemptId:string;evidenceId:string;filesystem:NativeFilesystemAdmission;
  qualificationSha256:string},signal:AbortSignal) => {
  if(!enabled || signal.aborted) throw new Error("Native result binding disabled or interrupted.");
  const value=structuredClone(input);
  if(![value.taskId,value.attemptId,value.evidenceId].every(id=>typeof id==='string' && uuid.test(id))
   || typeof value.qualificationSha256!=='string' || !/^[0-9a-f]{64}$/.test(value.qualificationSha256)) throw new TypeError("Invalid result binding identity.");
  validateNativeFilesystemAdmission(value.filesystem,value.filesystem.candidate.path);
  return sql.transaction(async tx=>{
   const rows=await tx.query(RESULT_BINDING_WRITE_SQL,[value.taskId,value.attemptId,value.evidenceId,JSON.stringify(value.filesystem),value.qualificationSha256],{signal,timeoutMs:30000});
   if(signal.aborted || rows.length!==1) throw new Error("Native result binding outcome unknown; reconcile exact binding.");
   const process=structuredClone(rows[0].process) as AdmittedReportProcess;
   validateAdmittedReportProcess(process);
   validateNativeFilesystemAdmission(value.filesystem,process.candidateRoot);
   return process;
  },{signal,timeoutMs:30000,isolation:"read committed"});
 };
}
/** Concrete internal dispatch. Existing owner pool supplies SQL authority;
 * signing key comes only from trusted explicit configuration. No environment,
 * credential lookup, public route or new authentication mechanism is added. */
export function createNativeResultRuntime(config:{sql:PrivateArtifactSql;storage:PrivateArtifactStorage;
 pool:NativeOwnerSqlPool;key:Uint8Array;enabled?:boolean;now?:()=>Date}) {
 const {sql,storage,pool,now}=config, enabled=config.enabled===true,key=Buffer.from(config.key);
 const invoke=(taskId:string,attemptId:string,replay:boolean,options:NativeFinalizationOptions={})=>{
  if(!enabled) throw new Error("Native result runtime disabled.");
  const results=createNativeResultReader({sql,storage,taskId,attemptId,enabled,signal:options.signal});
  const repository=createNativeResultRepository({results,pool,enabled});
  const service=createNativeResultFinalizer({repository,key,enabled,now});
  return replay?service.replay(taskId,attemptId,options):service.finalize(taskId,attemptId,options);
 };
 return Object.freeze({finalize:(task:string,attempt:string,options?:NativeFinalizationOptions)=>invoke(task,attempt,false,options),
  replay:(task:string,attempt:string,options?:NativeFinalizationOptions)=>invoke(task,attempt,true,options)});
}
