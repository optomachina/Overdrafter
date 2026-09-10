import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { createEngineeringWorkerHandler, createWorkerSecret, hashWorkerSecret, WORKER_GATEWAY_SCHEMA, type WorkerGatewayRuntime } from "./index.ts";

const worker = "49900000-0000-4000-8000-000000000001";
const installation = "49900000-0000-4000-8000-000000000002";
const boot = "49900000-0000-4000-8000-000000000003";
const session = "49900000-0000-4000-8000-000000000004";
const key = "49900000-0000-4000-8000-000000000005";
const token = createWorkerSecret("worker");
const code = createWorkerSecret("pairing");
const pairedAt = "2026-09-10T07:00:00.123456+00:00";
const expiresAt = "2026-09-10T15:00:00.123456+00:00";
const base = { schema: WORKER_GATEWAY_SCHEMA, workerId: worker };
const pair = { ...base, action: "pair", expectedRevision: 1, idempotencyKey: key, installationId: installation, pairingCode: code };
const startup = { ...base, action: "boot", expectedRevision: 2, idempotencyKey: key, bootId: boot };
const status = { ...base, action: "session", bootId: boot };
const pairResult = { workerId: worker, installationId: installation, revision: 2, pairedAt };
const bootResult = { workerId: worker, bootId: boot, revision: 3, enabled: false };
const sessionResult = { workerId: worker, installationId: installation, bootId: boot, sessionId: session, revision: 4, sessionEligible: true, reason: "enabled", expiresAt };
function request(body: unknown = pair, headers: Record<string,string> = {}) {
  return new Request("https://example.test/functions/v1/engineering-worker", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
}
function setup(data: unknown = pairResult, error: {code?:string} | null = null) {
  const calls: { name: string; args: Record<string,unknown>; signal: AbortSignal }[] = [];
  const rpc: WorkerGatewayRuntime["rpc"] = (name,args,signal) => { calls.push({name,args,signal}); return Promise.resolve({data,error}); };
  return { handler: createEngineeringWorkerHandler({enabled:()=>true,rpc}), calls };
}
Deno.test("disabled gate precedes body access, credentials and RPC", async () => {
  let called = false;
  const handler = createEngineeringWorkerHandler({enabled:()=>false,rpc:()=>{called=true;throw new Error("must not call");}});
  const response = await handler(new Request("https://example.test",{method:"POST",body:"invalid"}));
  assertEquals(response.status,503); assertEquals(called,false);
  assertEquals(await response.json(),{schema:WORKER_GATEWAY_SCHEMA,error:"gateway_disabled",outcome:"not_applied",retrySameRequest:false});
});
Deno.test("default environment gate requires literal true", async () => {
  const previous = Deno.env.get("ENGINEERING_WORKER_GATEWAY_ENABLED");
  try {
    Deno.env.set("ENGINEERING_WORKER_GATEWAY_ENABLED","1");
    assertEquals((await createEngineeringWorkerHandler()(request())).status,503);
  } finally {
    if (previous === undefined) Deno.env.delete("ENGINEERING_WORKER_GATEWAY_ENABLED");
    else Deno.env.set("ENGINEERING_WORKER_GATEWAY_ENABLED",previous);
  }
});
Deno.test("purpose-bound independent random secrets and full raw-value hashing", async () => {
  assertEquals(token.length,68); assertEquals(code.length,68); assertNotEquals(token,createWorkerSecret("worker"));
  const bytes = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
  const expected = Array.from(new Uint8Array(bytes),(n)=>n.toString(16).padStart(2,"0")).join("");
  assertEquals(await hashWorkerSecret(token),expected); assertNotEquals(expected,token);
});
Deno.test("pair maps exact subject and hashes raw secrets; response excludes private fields", async () => {
  const {handler,calls} = setup({...pairResult,credentialSha256:await hashWorkerSecret(token),secret:token,serviceKey:code});
  const response = await handler(request()); const body = await response.json();
  assertEquals(response.status,200); assertEquals(response.headers.get("cache-control"),"no-store");
  assertEquals(response.headers.get("access-control-allow-origin"),null);
  assertEquals(body,{schema:WORKER_GATEWAY_SCHEMA,action:"pair",receipt:pairResult});
  assertEquals(calls.length,1); assertEquals(calls[0].name,"api_consume_worker_pairing");
  assertEquals(calls[0].args,{p_worker_id:worker,p_credential_sha256:await hashWorkerSecret(token),p_expected_revision:1,p_key:key,p_installation_id:installation,p_code_sha256:await hashWorkerSecret(code)});
  assertEquals(JSON.stringify(body).includes(token),false); assertEquals(JSON.stringify(body).includes(code),false);
});
Deno.test("boot maps to boot registration and cannot enable itself", async () => {
  const {handler,calls}=setup(bootResult); const response=await handler(request(startup));
  assertEquals(response.status,200); assertEquals((await response.json()).receipt,bootResult);
  assertEquals(calls[0].name,"api_register_worker_boot");
  assertEquals(calls[0].args,{p_worker_id:worker,p_credential_sha256:await hashWorkerSecret(token),p_expected_revision:2,p_key:key,p_boot_id:boot});
});
Deno.test("session maps to read-only eligibility without an owner action", async () => {
  const {handler,calls}=setup(sessionResult); const response=await handler(request(status));
  assertEquals(response.status,200); assertEquals((await response.json()).receipt,sessionResult);
  assertEquals(calls[0].name,"api_worker_session_eligibility");
  assertEquals(calls[0].args,{p_worker_id:worker,p_credential_sha256:await hashWorkerSecret(token),p_boot_id:boot});
});
for (const [name,body] of Object.entries({
  schema:{...pair,schema:"v0"},action:{...pair,action:"enabled"},rpc:{...pair,rpc:"api_control_worker_session"},
  digest:{...pair,credentialSha256:"a".repeat(64)},scope:{...pair,organizationId:worker},
  revision:{...pair,expectedRevision:-1},unsafeRevision:{...pair,expectedRevision:Number.MAX_SAFE_INTEGER},
  fractionalRevision:{...pair,expectedRevision:1.5},nullKey:{...pair,idempotencyKey:null},
  uuid:{...pair,workerId:"x"},nilUuid:{...pair,workerId:"00000000-0000-0000-0000-000000000000"},
  wrongCodePurpose:{...pair,pairingCode:token},missingBoot:{...status,bootId:undefined},array:[],null:null,
})) {
  Deno.test(`reject malformed ${name} before RPC`,async()=>{
    const {handler,calls}=setup();assertEquals((await handler(request(body))).status,400);assertEquals(calls.length,0);
  });
}
for (const authorization of ["",`Bearer ${code}`,`Bearer ${"a".repeat(64)}`,"Bearer sb_secret_fake","Basic fake",`Bearer ${token} extra`]) {
  Deno.test(`reject invalid bearer form ${authorization.length}`,async()=>{
    const {handler,calls}=setup();assertEquals((await handler(request(pair,{Authorization:authorization}))).status,401);assertEquals(calls.length,0);
  });
}
Deno.test("GET, browser Origin, query parameters and unsupported media are refused",async()=>{
  const {handler,calls}=setup();
  assertEquals((await handler(new Request("https://example.test"))).status,405);
  assertEquals((await handler(request(pair,{Origin:"https://example.test"}))).status,403);
  assertEquals((await handler(new Request(`https://example.test/?secret=${token}`,{method:"POST"}))).status,403);
  assertEquals((await handler(request(pair,{"Content-Type":"text/plain"}))).status,415);
  assertEquals((await handler(request(pair,{"Content-Encoding":"gzip"}))).status,415);
  assertEquals(calls.length,0);
});
Deno.test("body length is enforced even when the declared length lies",async()=>{
  const {handler,calls}=setup();
  assertEquals((await handler(request(pair,{"Content-Length":"9000"}))).status,413);
  assertEquals((await handler(request("x".repeat(9000),{"Content-Length":"1"}))).status,413);
  assertEquals(calls.length,0);
});
Deno.test("invalid JSON and invalid UTF-8 do not reach RPC",async()=>{
  const {handler,calls}=setup();
  const headers={"Content-Type":"application/json",Authorization:`Bearer ${token}`};
  assertEquals((await handler(new Request("https://example.test",{method:"POST",headers,body:"{"}))).status,400);
  assertEquals((await handler(new Request("https://example.test",{method:"POST",headers,body:new Uint8Array([255])}))).status,400);
  assertEquals(calls.length,0);
});
Deno.test("stalled request body has a finite deadline even if cancellation stalls",async()=>{
  let canceled=false,called=false;
  const stream=new ReadableStream({cancel(){canceled=true;return new Promise(()=>{});}});
  const handler=createEngineeringWorkerHandler({enabled:()=>true,deadlineMs:10,rpc:()=>{called=true;throw new Error("not reached");}});
  const response=await handler(new Request("https://example.test",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:stream}));
  assertEquals(response.status,504);assertEquals(canceled,true);assertEquals(called,false);
  assertEquals((await response.json()).outcome,"not_applied");
});
Deno.test("stalled mutation RPC aborts transport and reports unknown result for exact retry",async()=>{
  let signal:AbortSignal|undefined;
  const handler=createEngineeringWorkerHandler({enabled:()=>true,deadlineMs:10,rpc:(_n,_a,s)=>{signal=s;return new Promise(()=>{});}});
  const response=await handler(request());assertEquals(response.status,504);assertEquals(signal?.aborted,true);
  assertEquals(await response.json(),{schema:WORKER_GATEWAY_SCHEMA,error:"deadline_exceeded",outcome:"unknown",retrySameRequest:true});
});
Deno.test("already-disconnected input never reaches the database",async()=>{
  const {handler,calls}=setup(); const controller=new AbortController();controller.abort(token);
  const response=await handler(new Request(request(),{signal:controller.signal}));
  assertEquals(response.status,504);assertEquals(calls.length,0);assertEquals((await response.text()).includes(token),false);
});
for (const [code,statusCode] of [["42501",401],["PT409",409],["23505",409],["22023",400],["unknown",503]] as const) {
  Deno.test(`database ${code} gets a finite redacted response`,async()=>{
    const {handler}=setup({secret:token},{code,message:token} as {code:string});
    const response=await handler(request());const text=await response.text();assertEquals(response.status,statusCode);assertEquals(text.includes(token),false);
    const body=JSON.parse(text);assertEquals(body.outcome,statusCode===503 ? "unknown" : "not_applied");
  });
}
Deno.test("unexpected upstream exception cannot expose secrets",async()=>{
  const handler=createEngineeringWorkerHandler({enabled:()=>true,rpc:()=>Promise.reject(new Error(token))});
  const response=await handler(request());assertEquals(response.status,503);assertEquals((await response.text()).includes(token),false);
});
for (const [name,value,payload] of [
  ["wrong worker",{...pairResult,workerId:installation},pair],
  ["wrong installation",{...pairResult,installationId:worker},pair],
  ["wrong revision",{...pairResult,revision:8},pair],
  ["secret timestamp",{...pairResult,pairedAt:token},pair],
  ["wrong boot",{...bootResult,bootId:worker},startup],
  ["self enable",{...bootResult,enabled:true},startup],
  ["status contradiction",{...sessionResult,reason:"paused"},status],
  ["missing grant",{...sessionResult,sessionId:null},status],
  ["wrong status boot",{...sessionResult,bootId:worker},status],
  ["invented status",{...sessionResult,reason:"verified"},status],
  ["nonobject",null,pair],
] as const) {
  Deno.test(`reject upstream ${name}`,async()=>{
    const {handler}=setup(value);const response=await handler(request(payload));assertEquals(response.status,502);assertEquals((await response.text()).includes(token),false);
  });
}
Deno.test("restart, pause and expiry stay ineligible without implying stopped native work",async()=>{
  for (const reason of ["paused","expired","owner_enablement_required","boot_mismatch"]) {
    const value={...sessionResult,reason,sessionEligible:false};
    if(reason==="owner_enablement_required"){Object.assign(value,{sessionId:null,expiresAt:null});}
    if(reason==="boot_mismatch"){Object.assign(value,{bootId:worker});}
    const response=await setup(value).handler(request(status));assertEquals(response.status,200);
    assertEquals((await response.json()).receipt.sessionEligible,false);
  }
});
Deno.test("largest valid receipt revision is preserved without unsafe input revision",async()=>{
  const {handler}=setup({...bootResult,revision:Number.MAX_SAFE_INTEGER});
  assertEquals((await handler(request({...startup,expectedRevision:Number.MAX_SAFE_INTEGER-1}))).status,200);
});
Deno.test("deadline injection cannot extend production's five-second bound",()=>{
  for(const deadlineMs of [0,-1,5001,1.5,NaN]) assertThrows(()=>createEngineeringWorkerHandler({deadlineMs}));
});
Deno.test("actual SDK bridge rejects redirects without losing request binding or redaction",async()=>{
  const previousUrl=Deno.env.get("SUPABASE_URL"), previousKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const previousFetch=globalThis.fetch;
  const serviceKey="synthetic-server-only-fixture-key";
  const calls:Request[]=[];
  let redirectTargetRequests=0;
  try {
    Deno.env.set("SUPABASE_URL","https://gateway-database.example.test");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY",serviceKey);
    globalThis.fetch=(input,init)=>{
      const outbound=new Request(input,init); calls.push(outbound);
      // Model a redirecting upstream at the fetch boundary. No network access.
      if(outbound.redirect==="error") return Promise.reject(new TypeError(serviceKey));
      redirectTargetRequests++;
      return Promise.resolve(new Response(JSON.stringify(pairResult),{headers:{"Content-Type":"application/json"}}));
    };
    const response=await createEngineeringWorkerHandler({enabled:()=>true})(request());
    assertEquals(response.status,503);
    assertEquals(await response.json(),{schema:WORKER_GATEWAY_SCHEMA,error:"upstream_unavailable",outcome:"unknown",retrySameRequest:true});
    assertEquals(redirectTargetRequests,0); assertEquals(calls.length,1);
    const outbound=calls[0];
    assertEquals(outbound.url,"https://gateway-database.example.test/rest/v1/rpc/api_consume_worker_pairing");
    assertEquals(outbound.redirect,"error"); assertEquals(outbound.method,"POST");
    assertEquals(outbound.headers.get("apikey"),serviceKey);
    assertEquals(outbound.headers.get("authorization"),`Bearer ${serviceKey}`);
    assertEquals(outbound.signal.aborted,false);
    assertEquals(await outbound.json(),{p_worker_id:worker,p_credential_sha256:await hashWorkerSecret(token),p_expected_revision:1,
      p_key:key,p_installation_id:installation,p_code_sha256:await hashWorkerSecret(code)});
  } finally {
    globalThis.fetch=previousFetch;
    if(previousUrl===undefined) Deno.env.delete("SUPABASE_URL"); else Deno.env.set("SUPABASE_URL",previousUrl);
    if(previousKey===undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY"); else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY",previousKey);
  }
});
