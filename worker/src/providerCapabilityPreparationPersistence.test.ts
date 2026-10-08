// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { projectCapabilityAttention } from "./providerCapabilityAttention.js";
import { claimCapabilityWindow, completeCapabilityWindow, commitCapabilityAttention, type CapabilityWindowCompletion, type CapabilityAttentionCommit } from "./providerCapabilityRuntimePersistence.js";
import { prepareCapabilityClaim, readPreparedCapabilityClaim, listPreparedCapabilityClaims, prepareCapabilityCompletion, readPreparedCapabilityCompletion,
  prepareCapabilityAttention, readPreparedCapabilityAttention, listPreparedCapabilityAttention, type PreparedClaim } from "./providerCapabilityPreparationPersistence.js";
const uuid = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const claim: PreparedClaim = {completionKey:uuid(2),request:{windowKey:`canary:${"a".repeat(64)}`,resourceKey:"b".repeat(64),configDigest:"c".repeat(64),requestKey:uuid(),provider:"xometry",route:"route",surface:"modal",surfaceRevision:"v1",windowStart:"2026-10-02T00:00:00.000Z",windowEnd:"2026-10-02T01:00:00.000Z",leaseSeconds:60}};
const completion: CapabilityWindowCompletion = {windowKey:claim.request.windowKey,requestKey:uuid(),completionKey:uuid(2),fence:uuid(3),resourceReleased:true,candidate:{provider:"xometry",route:"route",surface:"modal",revision:"v1",state:"fresh",extensions:["step"],mimeTypes:["application/step"],acceptAttributePresent:true,observedAt:claim.request.windowStart,expiresAt:claim.request.windowEnd,actorKind:"scheduled_canary",sourceKind:"scheduled_canary",sourceVersion:"v1",evidenceReference:"issue:OVD-591",idempotencyKey:claim.request.windowKey}};
function attention(n=1): CapabilityAttentionCommit {
 const m={provider:"xometry",route:"route",surface:"modal",surfaceRevision:"v1",policyRevision:"v1",adapterRevision:null,workerBuild:null};
 const p=projectCapabilityAttention({metadata:m,reviewedMetadata:[m],evidence:null,previous:null,now:claim.request.windowStart});
 if(p.state!=="projected")throw Error("fixture");
 return {expectedVersion:0,evaluationKey:uuid(n),cursor:p.cursor,item:p.item,intent:p.intent,evidence:null};
}
function mock(data:unknown,error:unknown=null){const rpc=vi.fn().mockResolvedValue({data,error});return {rpc,db:{rpc} as unknown as SupabaseClient};}
let sdkInstance=0;
function sdk(data:unknown,status=200){const send=vi.fn(async()=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}}));return {send,db:createClient("https://synthetic.invalid","synthetic-unused",{auth:{storageKey:`synthetic-${++sdkInstance}`,persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:send}})};}
const scope=attention().cursor.scopeKey;
function page(cursors:string[],hasMore=false){return {entries:cursors.map((cursor,i)=>({cursor,input:attention(i+1)})),nextCursor:cursors.at(-1)??null,hasMore};}
const attentionArgs=(limit=100,afterCursor:string|null=null)=>({scopeKey:scope,afterCursor,limit});
const claimArgs=(limit=100,afterCursor:string|null=null)=>({windowKey:claim.request.windowKey,afterCursor,limit});
function claims(cursors:string[],hasMore=false){return {...page(cursors,hasMore),entries:cursors.map((cursor,i)=>({cursor,input:{...claim,completionKey:uuid(1000+i),request:{...claim.request,requestKey:uuid(i+1)}}}))};}

describe("immutable preparation service transport; no SQL durability proof",()=>{
 it.each(["created","existing"] as const)("maps claim prepare %s through actual SDK",async state=>{const value={state,retained:claim},c=sdk(value);expect(await prepareCapabilityClaim(c.db,claim)).toEqual({ok:true,value});expect(c.send).toHaveBeenCalledOnce();const [url,init]=c.send.mock.calls[0] as unknown as [string,RequestInit];expect(String(url)).toBe("https://synthetic.invalid/rest/v1/rpc/api_prepare_capability_claim");expect(JSON.parse(init.body as string)).toEqual({p_input:claim});});
 it("maps all eight exact RPC argument shapes without generic kind wrappers",async()=>{
  const cases:[unknown,(db:SupabaseClient)=>Promise<unknown>,string,unknown][]=[
   [claim,db=>readPreparedCapabilityClaim(db,uuid()),"api_read_prepared_capability_claim",{p_request_key:uuid()}],
   [claims(["9","10"]),db=>listPreparedCapabilityClaims(db,claimArgs(2)),"api_list_prepared_capability_claims",{p_window_key:claim.request.windowKey,p_after_cursor:null,p_limit:2}],
   [{state:"created",retained:completion},db=>prepareCapabilityCompletion(db,completion),"api_prepare_capability_completion",{p_input:completion}],
   [completion,db=>readPreparedCapabilityCompletion(db,uuid(2)),"api_read_prepared_capability_completion",{p_completion_key:uuid(2)}],
   [{state:"existing",retained:attention()},db=>prepareCapabilityAttention(db,attention()),"api_prepare_capability_attention",{p_input:attention()}],
   [attention(),db=>readPreparedCapabilityAttention(db,uuid()),"api_read_prepared_capability_attention",{p_evaluation_key:uuid()}],
   [page(["9","10"]),db=>listPreparedCapabilityAttention(db,attentionArgs(2)),"api_list_prepared_capability_attention",{p_scope_key:scope,p_after_cursor:null,p_limit:2}],
   [{state:"existing",retained:claim},db=>prepareCapabilityClaim(db,claim),"api_prepare_capability_claim",{p_input:claim}],
  ];
  for(const [value,call,name,args] of cases){const c=sdk(value);expect(await call(c.db)).toEqual({ok:true,value});const [url,init]=c.send.mock.calls[0] as unknown as [string,RequestInit];expect(String(url).endsWith(`/rpc/${name}`)).toBe(true);expect(JSON.parse(init.body as string)).toEqual(args);}
 });
 it("permits nullable exact reads and canonical empty pages",async()=>{const c=mock(null);for(const result of [await readPreparedCapabilityClaim(c.db,uuid()),await readPreparedCapabilityCompletion(c.db,uuid()),await readPreparedCapabilityAttention(c.db,uuid())])expect(result).toEqual({ok:true,value:null});expect(await listPreparedCapabilityAttention(mock(page([])).db,attentionArgs())).toEqual({ok:true,value:page([])});expect(await listPreparedCapabilityClaims(mock(claims([])).db,claimArgs())).toEqual({ok:true,value:claims([])});});
 it("allows semantic property reorder on replay while preserving retained payload",async()=>{const reordered={...claim,request:Object.fromEntries(Object.entries(claim.request).reverse())};const c=mock({state:"existing",retained:reordered});expect(await prepareCapabilityClaim(c.db,claim)).toEqual({ok:true,value:{state:"existing",retained:reordered}});});
 it("binds acknowledgment to full semantic payload including timestamp spelling and arrays",async()=>{
  for(const retained of [{...claim,completionKey:uuid(8)},{...claim,request:{...claim.request,leaseSeconds:30}},{...claim,request:{...claim.request,windowStart:claim.request.windowStart.replace(".000Z","Z")}}])expect(await prepareCapabilityClaim(mock({state:"existing",retained}).db,claim)).toEqual({ok:false,reasonCode:"invalid_response"});
  const input={...completion,candidate:{...completion.candidate,extensions:["step","stp"]}},retained={...input,candidate:{...input.candidate,extensions:["stp","step"]}};expect((await prepareCapabilityCompletion(mock({state:"existing",retained}).db,input)).ok).toBe(false);
  expect((await prepareCapabilityAttention(mock({state:"existing",retained:attention(2)}).db,attention())).ok).toBe(false);
 });
 it("binds each read to requested immutable identity",async()=>{expect((await readPreparedCapabilityClaim(mock(claim).db,uuid(9))).ok).toBe(false);expect((await readPreparedCapabilityCompletion(mock(completion).db,uuid(9))).ok).toBe(false);expect((await readPreparedCapabilityAttention(mock(attention()).db,uuid(9))).ok).toBe(false);});
 it("captures dispatched input before awaiting caller mutation",async()=>{const input=structuredClone(claim),saved=structuredClone(input);let finish!:(v:unknown)=>void;const rpc=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));const pending=prepareCapabilityClaim({rpc} as unknown as SupabaseClient,input);input.request.leaseSeconds=1;finish({data:{state:"existing",retained:saved},error:null});expect(await pending).toEqual({ok:true,value:{state:"existing",retained:saved}});expect(rpc.mock.calls[0]).toEqual(["api_prepare_capability_claim",{p_input:saved}]);});
 it("rejects accessors, polluted prototypes, cycles, non-JSON and sparse arrays before dispatch",async()=>{
  const getter=vi.fn(()=>claim.request),accessor={...claim};Object.defineProperty(accessor,"request",{get:getter,enumerable:true});
  const sparse=structuredClone(completion);const array=new Array(1);Object.assign(array,{extra:"step"});sparse.candidate.extensions=array;
  const cyclic:Record<string,unknown>={...claim};cyclic.extra=cyclic;
  for(const bad of [accessor,Object.assign(Object.create({secret:true}),claim),{...claim,extra:undefined},{...claim,extra:1n},{...claim,extra:Symbol()},cyclic]){const c=mock(null);expect(await prepareCapabilityClaim(c.db,bad as never)).toEqual({ok:false,reasonCode:"invalid_input"});expect(c.rpc).not.toHaveBeenCalled();}
  const c=mock(null);expect((await prepareCapabilityCompletion(c.db,sparse)).ok).toBe(false);expect(c.rpc).not.toHaveBeenCalled();expect(getter).not.toHaveBeenCalled();
  const args=Object.defineProperty({...attentionArgs()},"scopeKey",{get:getter,enumerable:true});expect((await listPreparedCapabilityAttention(c.db,args)).ok).toBe(false);expect(getter).not.toHaveBeenCalled();
 });
 it("rejects response payload/envelope accessors without invoking them",async()=>{const getter=vi.fn(()=>claim),data={state:"created"};Object.defineProperty(data,"retained",{get:getter,enumerable:true});expect((await prepareCapabilityClaim(mock(data).db,claim)).ok).toBe(false);const c=mock(null);c.rpc.mockResolvedValue(Object.defineProperty({error:null},"data",{get:getter}));expect((await prepareCapabilityClaim(c.db,claim)).ok).toBe(false);expect(getter).not.toHaveBeenCalled();});
 it.each(["0","01","-1","1.0","1e2"," 1","9223372036854775808",1,null])("rejects noncanonical returned cursor %s",async cursor=>{const value=page(["1"]);value.entries[0].cursor=cursor as never;value.nextCursor=cursor as never;expect((await listPreparedCapabilityAttention(mock(value).db,attentionArgs(1))).ok).toBe(false);});
 it("orders bigint cursors beyond JS safe range numerically",async()=>{const value=page(["9007199254740992","9223372036854775807"]);expect(await listPreparedCapabilityAttention(mock(value).db,attentionArgs(2,"9007199254740991"))).toEqual({ok:true,value});expect((await listPreparedCapabilityAttention(mock(page(["10","9"])).db,attentionArgs(2))).ok).toBe(false);});
 it("requires exact scope, increasing cursor, continuation, unique identity and caps",async()=>{
  const wrongScope=page(["1"]);wrongScope.entries[0].input.cursor.scopeKey="e".repeat(64);wrongScope.entries[0].input.item.key=`capability:${"e".repeat(64)}`;
  const duplicate=page(["1","2"]);duplicate.entries[1].input=duplicate.entries[0].input;
  for(const value of [page(["1","1"]),{...page(["1"]),nextCursor:null},{...page([]),nextCursor:"1"},{...page(["1"]),nextCursor:"2"},wrongScope,duplicate,page(["1","2","3"]),page(["1"],true),page([],true),{...page(["1"]),hasMore:"false"}])expect((await listPreparedCapabilityAttention(mock(value).db,attentionArgs(2))).ok).toBe(false);
  expect((await listPreparedCapabilityAttention(mock(page(["2"])).db,attentionArgs(1,"2"))).ok).toBe(false);
 });
 it("supports full nonterminal and terminal pages with last delivered cursor",async()=>{for(const hasMore of [true,false]){const value=page(["9","10"],hasMore);expect(await listPreparedCapabilityAttention(mock(value).db,attentionArgs(2))).toEqual({ok:true,value});}});
 it("discovers multiple requests for same window without recreating probe authority",async()=>{const value=claims(["9007199254740992","9007199254740993"],true);expect(await listPreparedCapabilityClaims(mock(value).db,claimArgs(2,"9007199254740991"))).toEqual({ok:true,value});value.entries[1].input.request.windowKey=`canary:${"e".repeat(64)}`;expect((await listPreparedCapabilityClaims(mock(value).db,claimArgs(2))).ok).toBe(false);});
 it("accepts exactly100 retained entries, without rounded cursors",async()=>{const cursors=Array.from({length:100},(_,i)=>String(9007199254740992n+BigInt(i)));for(const [value,call] of [[page(cursors),(db:SupabaseClient)=>listPreparedCapabilityAttention(db,attentionArgs())],[claims(cursors),(db:SupabaseClient)=>listPreparedCapabilityClaims(db,claimArgs())]] as const)expect(await call(mock(value).db)).toEqual({ok:true,value});});
 it.each([0,101,1.5,NaN,Infinity])("rejects invalid page limit %s before dispatch",async limit=>{const c=mock(null);expect((await listPreparedCapabilityAttention(c.db,attentionArgs(limit))).ok).toBe(false);expect((await listPreparedCapabilityClaims(c.db,claimArgs(limit))).ok).toBe(false);expect(c.rpc).not.toHaveBeenCalled();});
 it("rejects malformed input cursor/scope and excessive untrusted strings",async()=>{const c=mock(null);for(const after of ["0","01","9223372036854775808"])expect((await listPreparedCapabilityAttention(c.db,attentionArgs(1,after))).ok).toBe(false);expect((await listPreparedCapabilityAttention(c.db,{...attentionArgs(),scopeKey:"secret"})).ok).toBe(false);expect((await prepareCapabilityCompletion(c.db,{...completion,candidate:{...completion.candidate,sourceVersion:"x".repeat(2000000)}})).ok).toBe(false);expect(c.rpc).not.toHaveBeenCalled();});
 it("scrubs denied/malformed/thrown errors and never retries",async()=>{const c=sdk({message:"secret"},403);expect(await prepareCapabilityClaim(c.db,claim)).toEqual({ok:false,reasonCode:"rpc_denied"});expect(c.send).toHaveBeenCalledOnce();const d=mock({secret:"customer"});expect(await prepareCapabilityClaim(d.db,claim)).toEqual({ok:false,reasonCode:"invalid_response"});d.rpc.mockRejectedValue(new Error("secret"));expect(await prepareCapabilityClaim(d.db,claim)).toEqual({ok:false,reasonCode:"transport_error"});});
 it("cross-checks valid prepared payloads against unchanged canonical helper types",async()=>{const c=mock({status:"busy"});expect((await claimCapabilityWindow(c.db,claim.request)).ok).toBe(true);c.rpc.mockResolvedValue({data:{status:"completed",windowKey:claim.request.windowKey,observationRevision:1},error:null});expect((await completeCapabilityWindow(c.db,completion)).ok).toBe(true);c.rpc.mockResolvedValue({data:{status:"committed",version:1},error:null});expect((await commitCapabilityAttention(c.db,attention())).ok).toBe(true);});
 it.each([
  {leaseSeconds:0},{leaseSeconds:301},{leaseSeconds:1.1},{resourceKey:"/private/profile"},{provider:"https://private.invalid"},
  {windowStart:"2026-02-30T00:00:00.000Z"},{requestKey:"private"},
 ])("rejects malformed canonical claim %j without RPC",async patch=>{const c=mock(null);expect(await prepareCapabilityClaim(c.db,{...claim,request:{...claim.request,...patch}})).toEqual({ok:false,reasonCode:"invalid_input"});expect(c.rpc).not.toHaveBeenCalled();});
 it("rejects malformed completion disposal, binding and token caps without canonical effects",async()=>{
  for(const bad of [{...completion,resourceReleased:false},{...completion,candidate:{...completion.candidate,idempotencyKey:`canary:${"e".repeat(64)}`}},{...completion,candidate:{...completion.candidate,extensions:Array(33).fill("step")}}, {kind:"completion",input:completion}]){
   const c=mock(null);expect(await prepareCapabilityCompletion(c.db,bad as never)).toEqual({ok:false,reasonCode:"invalid_input"});expect(c.rpc).not.toHaveBeenCalled();
  }
 });
 it("rejects unsafe CAS values, fabricated scope and intent inconsistency",async()=>{
  const original=attention();
  for(const input of [{...original,expectedVersion:Number.MAX_SAFE_INTEGER},{...original,expectedVersion:-1},{...original,item:{...original.item,metadata:{...original.item.metadata,route:"other"}}},{...original,intent:{...original.intent,generation:99}},{...original,evidence:{secret:"private"}}]){
   const c=mock(null);expect(await prepareCapabilityAttention(c.db,input as never)).toEqual({ok:false,reasonCode:"invalid_input"});expect(c.rpc).not.toHaveBeenCalled();
  }
 });
 it("rejects duplicate immutable claim request or reserved completion identities within discovery",async()=>{
  for(const field of ["request","completionKey"] as const){const value=claims(["1","2"]);value.entries[1].input[field]=value.entries[0].input[field] as never;expect((await listPreparedCapabilityClaims(mock(value).db,claimArgs(2))).ok).toBe(false);}
 });
 it("rejects over100 rows and an oversized untrusted response without exposing it",async()=>{
  expect((await listPreparedCapabilityAttention(mock(page(Array.from({length:101},(_,i)=>String(i+1)))).db,attentionArgs())).ok).toBe(false);
  expect(await prepareCapabilityClaim(mock({state:"existing",retained:claim,diagnostic:"x".repeat(2000001)}).db,claim)).toEqual({ok:false,reasonCode:"invalid_response"});
 });

 it("rejects custom array prototype serialization accessor without invoking it or dispatching",async()=>{
  const getter=vi.fn(()=>()=>["https://unsanitized.invalid/customer"]);
  const input=structuredClone(completion);
  Object.setPrototypeOf(input.candidate.extensions,Object.defineProperty(Object.create(Array.prototype),"toJSON",{get:getter}));
  const c=sdk({state:"created",retained:completion}),rpc=vi.spyOn(c.db,"rpc");
  expect(await prepareCapabilityCompletion(c.db,input)).toEqual({ok:false,reasonCode:"invalid_input"});
  expect(getter).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();expect(c.send).not.toHaveBeenCalled();
 });
 it("rejects own array serialization hooks including nonenumerable properties",async()=>{
  const getter=vi.fn(()=>()=>["step"]),input=structuredClone(completion);
  Object.defineProperty(input.candidate.extensions,"toJSON",{get:getter});const c=mock(null);
  expect(await prepareCapabilityCompletion(c.db,input)).toEqual({ok:false,reasonCode:"invalid_input"});expect(getter).not.toHaveBeenCalled();expect(c.rpc).not.toHaveBeenCalled();
 });
 it.each([Object.prototype,Array.prototype])("rejects inherited global serialization hooks without executing them",async prototype=>{
  const before=Object.getOwnPropertyDescriptor(prototype,"toJSON"),getter=vi.fn(()=>()=>"unsanitized");const c=mock(null);
  let result:unknown;
  try {Object.defineProperty(prototype,"toJSON",{get:getter,configurable:true});result=await prepareCapabilityCompletion(c.db,completion);}
  finally {if(before)Object.defineProperty(prototype,"toJSON",before);else Reflect.deleteProperty(prototype,"toJSON");}
  expect(result).toEqual({ok:false,reasonCode:"invalid_input"});expect(getter).not.toHaveBeenCalled();expect(c.rpc).not.toHaveBeenCalled();
 });
 it("rejects array-coerced evidence reference on both input and retained/read responses",async()=>{
  const bad={...completion,candidate:{...completion.candidate,evidenceReference:["issue:OVD-591"]}};
  const c=mock({state:"existing",retained:bad});expect(await prepareCapabilityCompletion(c.db,bad as never)).toEqual({ok:false,reasonCode:"invalid_input"});expect(c.rpc).not.toHaveBeenCalled();
  expect(await prepareCapabilityCompletion(c.db,completion)).toEqual({ok:false,reasonCode:"invalid_response"});
  expect(await readPreparedCapabilityCompletion(mock(bad).db,completion.completionKey)).toEqual({ok:false,reasonCode:"invalid_response"});
 });
 it.each(["fingerprint","lastEvidenceHash","scopeKey"] as const)("rejects array-coerced cursor hash %s before dispatch and on reads",async field=>{
  const input=attention();
  if(field==="lastEvidenceHash") {input.cursor.lastObservationRevision=1;input.cursor.lastObservedAt=claim.request.windowStart;}
  Object.assign(input.cursor,{[field]:["a".repeat(64)]});const c=mock(null);
  expect(await prepareCapabilityAttention(c.db,input)).toEqual({ok:false,reasonCode:"invalid_input"});expect(c.rpc).not.toHaveBeenCalled();
  expect(await readPreparedCapabilityAttention(mock(input).db,input.evaluationKey)).toEqual({ok:false,reasonCode:"invalid_response"});
 });
 it("rejects response custom-array serialization hooks before returning a typed completion",async()=>{
  const bad=structuredClone(completion),getter=vi.fn(()=>()=>["step"]);
  Object.setPrototypeOf(bad.candidate.extensions,Object.defineProperty(Object.create(Array.prototype),"toJSON",{get:getter}));
  expect(await readPreparedCapabilityCompletion(mock(bad).db,bad.completionKey)).toEqual({ok:false,reasonCode:"invalid_response"});expect(getter).not.toHaveBeenCalled();
 });

});
