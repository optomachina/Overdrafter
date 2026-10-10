// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminOperationsRuntime } from "./runtime";
import { projectOperations } from "./projection";
const now = Date.parse("2026-10-02T12:00:00.000Z");
const envelope = { provider:"xometry",route:"quote_home",surface:"account_quote_modal",revision:"xometry-account-quote-modal.v1",extensions:["step","stp"],policyRevision:"xometry-controlled-beta-2026-08-17.v1",evidenceReference:"OVD-373" };
const metadata = { provider:envelope.provider,route:envelope.route,surface:envelope.surface,surfaceRevision:envelope.revision,policyRevision:envelope.policyRevision,adapterRevision:null,workerBuild:null };
const admission = {policy_present:true,provider_admitted:true,generically_dispatchable:false,provider:"xometry",admission_state:"controlled_beta_only",policy_revision:envelope.policyRevision,evidence_reference:envelope.evidenceReference,permission_basis:"existing_controlled_beta_path",supported_processes:["cnc_milling"],accepted_file_extensions:["step","stp"],session_owner:"overdrafter_managed",reviewed_at:"2026-08-17T00:00:00.000Z",expires_at:null,reason_code:"controlled_beta_only"};
const observation = { provider:"xometry",capability:"provider_upload",route:envelope.route,surface:envelope.surface,surface_revision:envelope.revision,contract_version:"provider-upload-capability.v1",observation_state:"fresh",observed_extensions:["step","stp"],observed_mime_types:["model/step"],accept_attribute_present:true,observed_at:"2026-10-02T11:59:00.000000+00:00",expires_at:"2026-10-02T12:01:00.000000+00:00",freshness:"current",observation_revision:1 };
const env = {SUPABASE_URL:"https://database.invalid",SUPABASE_SERVICE_ROLE_KEY:"synthetic-only"};
afterEach(()=>vi.restoreAllMocks());
describe("read-only capability binding seam (synthetic policies only)",()=>{
  it.each(["provider","route","surface","revision","policyRevision"])("rejects envelope %s mismatch before any source read",async(field)=>{
    const send=vi.fn();const readCapabilityAdmission=vi.fn(async()=>admission);
    const runtime=createAdminOperationsRuntime(env,{fetch:send,now:()=>now,readCapabilityAdmission,approvedCapabilities:[{envelope:{...envelope,[field]:"other"},metadata,reviewedMetadata:[metadata]}]});
    await expect(runtime.read("capability","unused",new AbortController().signal)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();expect(readCapabilityAdmission).not.toHaveBeenCalled();
  });
  it("requires full independently reviewed metadata before admission or observation I/O",async()=>{
    const send=vi.fn();const readCapabilityAdmission=vi.fn(async()=>admission);
    const runtime=createAdminOperationsRuntime(env,{fetch:send,now:()=>now,readCapabilityAdmission,approvedCapabilities:[{envelope,metadata,reviewedMetadata:[{...metadata,adapterRevision:"different.v1"}]}]});
    await expect(runtime.read("capability","unused",new AbortController().signal)).rejects.toThrow();expect(send).not.toHaveBeenCalled();expect(readCapabilityAdmission).not.toHaveBeenCalled();
  });
  it("reuses persisted classifier and attention projector with normalized offset timestamps",async()=>{
    vi.spyOn(Date,"now").mockReturnValue(now);
    const send=vi.fn(async()=>Response.json([observation]));const readCapabilityAdmission=vi.fn(async()=>admission);
    const runtime=createAdminOperationsRuntime(env,{fetch:send,now:()=>now,readCapabilityAdmission,approvedCapabilities:[{envelope,metadata,reviewedMetadata:[metadata]}]});
    const source=await runtime.read("capability","unused",new AbortController().signal);
    expect(projectOperations({capability:source},now).items.find(i=>i.category==="upload_capability")).toMatchObject({provider:"xometry",severity:"healthy",reasonCode:"matches_policy",lastSeenAt:"2026-10-02T11:59:00.000Z"});
    expect(send).toHaveBeenCalledTimes(1);expect(readCapabilityAdmission).toHaveBeenCalledTimes(1);
  });
  it("keeps production registry absent and requires fresh admission binding even if metadata supplied",async()=>{
    const send=vi.fn();const runtime=createAdminOperationsRuntime(env,{fetch:send,now:()=>now,approvedCapabilities:[{envelope,metadata,reviewedMetadata:[metadata]}]});
    const source=await runtime.read("capability","unused",new AbortController().signal);
    expect(projectOperations({capability:source},now).items.find(i=>i.category==="upload_capability")?.severity).toBe("unknown");expect(send).not.toHaveBeenCalled();
  });
});
