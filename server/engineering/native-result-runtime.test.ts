// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import {storedNativeFixture} from './native-result-fixture';
import {createNativeResultRuntime,createNativeResultBindingWriter,RESULT_BINDING_WRITE_SQL} from './native-result-runtime';
import {RESULT_READER_LOAD_SQL} from './native-result-reader';
import {NATIVE_FINALIZATION_SQL} from './native-result-executor';
import type {PrivateArtifactSql,PrivateArtifactStorage} from './native-artifact-repository';
function setup(enabled=true){
 const f=storedNativeFixture();let pending:Record<string,unknown>|null=null;
 const ids=[f.admission.taskId,f.admission.active.attemptId] as const;
 const receipt={outcome:'finalized',taskId:ids[0],attemptId:ids[1],fence:f.admission.active.fence,snapshotId:f.admission.active.outputSnapshotId,inputAdmissionId:'44444444-4444-4444-8444-444444444444',successorTaskId:null};
 const query=vi.fn(async(text:string,values:readonly unknown[]):Promise<Record<string,unknown>[]>=>text===RESULT_READER_LOAD_SQL?[{admission:f.admission}]:[{storageObjectId:values[2],bucketId:'private',objectName:'owned',storageVersion:'v',storageUpdatedAt:'2026-10-03'}]);
 const sql={query,transaction:async(work)=>work(sql)} as PrivateArtifactSql;
 const storage:PrivateArtifactStorage={read:vi.fn(async o=>f.reader(o.storageObjectId)),create:vi.fn()};
 const db=vi.fn(async(text:string,values?:unknown[])=>{
  if(text===NATIVE_FINALIZATION_SQL.load)return{rows:[{value:pending}]};
  if(text===NATIVE_FINALIZATION_SQL.persist){pending??={p_payload_text:values![2],p_signature:values![3],p_candidate_context_text:values![4],p_key:values![5]};return{rows:[{value:pending}]};}
  if(text===NATIVE_FINALIZATION_SQL.finalize)return{rows:[{value:receipt}]};
  return {rows:[]};
 });
 const pool={connect:vi.fn(async()=>({query:db,release:vi.fn()}))};
 const config={sql,storage,pool,key:new Uint8Array(32),enabled};
 return{f,ids,receipt,query,sql,storage,db,pool,config,runtime:createNativeResultRuntime(config)};
}
describe('trusted result runtime',()=>{
 it('does no I/O by default',()=>{const s=setup(false);expect(()=>s.runtime.finalize(...s.ids)).toThrow('disabled');expect(s.query).not.toHaveBeenCalled();expect(s.pool.connect).not.toHaveBeenCalled();});
 it('composes reader, verifier, durable persistence and final transaction',async()=>{const s=setup();expect(await s.runtime.finalize(...s.ids)).toEqual(s.receipt);expect(s.storage.read).toHaveBeenCalledTimes(7);expect(s.db.mock.calls.filter(c=>c[0]===NATIVE_FINALIZATION_SQL.finalize)).toHaveLength(1);});
 it('explicit replay after fresh composition reads only stored envelope',async()=>{const s=setup();await s.runtime.finalize(...s.ids);s.query.mockClear();vi.mocked(s.storage.read).mockClear();expect(await createNativeResultRuntime(s.config).replay(...s.ids)).toEqual(s.receipt);expect(s.query).not.toHaveBeenCalled();expect(s.storage.read).not.toHaveBeenCalled();});
 it('does not persist or finalize when authority disappears after bytes',async()=>{const s=setup();let reads=0;s.query.mockImplementation(async(text,values)=>text===RESULT_READER_LOAD_SQL?(++reads===1?[{admission:s.f.admission}]:[]):[{storageObjectId:values[2],bucketId:'private',objectName:'owned',storageVersion:'v',storageUpdatedAt:'2026-10-03'}]);await expect(s.runtime.finalize(...s.ids)).rejects.toThrow('stale');expect(s.db.mock.calls.filter(c=>c[0]===NATIVE_FINALIZATION_SQL.persist)).toHaveLength(0);});
 it('binds only independently supplied filesystem through fixed owner SQL',async()=>{const s=setup();s.query.mockResolvedValueOnce([{process:s.f.admission.process}]);const writer=createNativeResultBindingWriter({sql:s.sql,enabled:true});expect(await writer({taskId:s.ids[0],attemptId:s.ids[1],evidenceId:'44444444-4444-4444-8444-444444444444',filesystem:s.f.admission.filesystem,qualificationSha256:'a'.repeat(64)},new AbortController().signal)).toEqual(s.f.admission.process);expect(s.query).toHaveBeenCalledWith(RESULT_BINDING_WRITE_SQL,[...s.ids,'44444444-4444-4444-8444-444444444444',JSON.stringify(s.f.admission.filesystem),'a'.repeat(64)],expect.anything());});
 it('binding default off cannot write',async()=>{const s=setup();const writer=createNativeResultBindingWriter({sql:s.sql});await expect(writer({taskId:s.ids[0],attemptId:s.ids[1],evidenceId:s.ids[0],filesystem:s.f.admission.filesystem,qualificationSha256:'a'.repeat(64)},new AbortController().signal)).rejects.toThrow('disabled');expect(s.query).not.toHaveBeenCalled();});
});
