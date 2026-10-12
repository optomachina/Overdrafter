// @vitest-environment node
import { describe,it,expect,vi } from "vitest";
import { storedNativeFixture } from "./native-result-fixture";
import { createNativeResultReader, RESULT_READER_LOAD_SQL, RESULT_READER_OBJECT_SQL } from "./native-result-reader";
import { produceNativeVerificationReceipt } from "./native-result-receipt";
import type { PrivateArtifactSql, PrivateArtifactStorage } from "./native-artifact-repository";
function setup(enabled=true) {
 const fixture=storedNativeFixture();
 const query=vi.fn(async(text:string,values:readonly unknown[])=>{
  if(text===RESULT_READER_LOAD_SQL) return [{admission:fixture.admission}];
  if(text===RESULT_READER_OBJECT_SQL && fixture.objects.some(o=>o.id===values[2])) return [{storageObjectId:values[2],bucketId:'private',objectName:String(values[2]),storageVersion:'version',storageUpdatedAt:'2026-10-03T00:00:00Z'}];
  return [];
 });
 const sql={query,transaction:async(work)=>work(sql)} as PrivateArtifactSql;
 const storage:PrivateArtifactStorage={read:vi.fn(async operation=>fixture.reader(operation.storageObjectId)),create:vi.fn()};
 const config={sql,storage,enabled,taskId:fixture.admission.taskId,attemptId:fixture.admission.active.attemptId};
 return {fixture,query,sql,storage,config,reader:createNativeResultReader(config)};
}
describe('registered result reader',()=>{
 it('default off produces no SQL or storage activity',async()=>{const s=setup(false);await expect(s.reader.loadAdmission(s.config.taskId,s.config.attemptId)).rejects.toThrow('disabled');expect(s.query).not.toHaveBeenCalled();});
 it('verifies seven registered bytes then fresh authority using fixed SQL',async()=>{
  const s=setup();const receipt=await produceNativeVerificationReceipt({...s.config,repository:s.reader,key:new Uint8Array(32)});
  expect(receipt.payload.objects).toHaveLength(7);expect(s.storage.read).toHaveBeenCalledTimes(7);
  expect(s.query.mock.calls.filter(c=>c[0]===RESULT_READER_LOAD_SQL)).toHaveLength(2);
  expect(s.storage.read).toHaveBeenCalledWith(expect.objectContaining({method:'GET',ifMatch:'version',bucketId:'private'}),expect.any(AbortSignal));
 });
 it('rejects a foreign invocation before SQL',async()=>{const s=setup();expect(await s.reader.loadAdmission('foreign',s.config.attemptId)).toBeNull();expect(s.query).not.toHaveBeenCalled();});
 it('rejects missing exact registry generation before storage',async()=>{const s=setup();s.query.mockResolvedValueOnce([]);await expect(s.reader.readRegisteredObject(s.fixture.objects[0].id,new AbortController().signal)).rejects.toThrow('unavailable');expect(s.storage.read).not.toHaveBeenCalled();});
 it('rejects incomplete seven-role admission before reads',async()=>{const s=setup();s.query.mockResolvedValueOnce([{admission:{...s.fixture.admission,objects:s.fixture.objects.slice(1)}}]);await expect(s.reader.loadAdmission(s.config.taskId,s.config.attemptId)).rejects.toThrow('Incomplete');expect(s.storage.read).not.toHaveBeenCalled();});
 it('returns false when fresh authority has disappeared',async()=>{const s=setup();s.query.mockResolvedValueOnce([]);expect(await s.reader.isCurrent(s.fixture.admission)).toBe(false);});
 it('compares the complete fresh immutable admission',async()=>{const s=setup();const old=structuredClone(s.fixture.admission);Object.assign(s.fixture.objects[0],{sha256:'f'.repeat(64)});expect(await s.reader.isCurrent(old)).toBe(false);});
 it('rejects filesystem alias before any bytes',async()=>{const s=setup();Object.assign(s.fixture.admission.filesystem.candidate,{fileId:s.fixture.admission.filesystem.input.fileId});await expect(s.reader.loadAdmission(s.config.taskId,s.config.attemptId)).rejects.toThrow('private input');});
 it('does not accept arbitrary URLs as registry IDs',async()=>{const s=setup();await expect(s.reader.readRegisteredObject('https://example.invalid',new AbortController().signal)).rejects.toThrow('identity');expect(s.query).not.toHaveBeenCalled();});
 it('does not start storage after the read signal aborts during SQL',async()=>{
  const s=setup(),controller=new AbortController();
  s.query.mockImplementationOnce(async()=>{controller.abort();return [{storageObjectId:s.fixture.objects[0].id,bucketId:'private',objectName:'x',storageVersion:'v',storageUpdatedAt:'now'}];});
  await expect(s.reader.readRegisteredObject(s.fixture.objects[0].id,controller.signal)).rejects.toThrow('interrupted');
  expect(s.storage.read).not.toHaveBeenCalled();
 });
 it('cancels a storage body arriving after cancellation',async()=>{
  const s=setup(),controller=new AbortController(),cancel=vi.fn();
  vi.mocked(s.storage.read).mockImplementationOnce(async()=>{controller.abort();return new Response(new ReadableStream({cancel}));});
  await expect(s.reader.readRegisteredObject(s.fixture.objects[0].id,controller.signal)).rejects.toThrow('interrupted');
  expect(cancel).toHaveBeenCalledOnce();
 });

});
