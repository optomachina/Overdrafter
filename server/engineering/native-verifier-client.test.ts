// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeVerifier } from "./native-verifier-client";
import { storedNativeFixture } from "./native-result-fixture";

const principal = "22222222-2222-4222-8222-222222222222";
const manifest = "33333333-3333-4333-8333-333333333333";
const deliveryKey = "44444444-4444-4444-8444-444444444444";
const run = "55555555-5555-4555-8555-555555555555";
const token = (role = "engineering_native_verifier") => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role, sub: principal })).toString("base64url")}.test-signature`;
const config = { enabled: true, projectUrl: "https://project.example.test", apiKey: "test-publishable-key", verifierToken: token(), sourceSha256: "a".repeat(64) };
function fixture() {
  const f = storedNativeFixture();
  const delivery = { schema: "overdrafter.native-verification-delivery.v1", status: "ready", manifestId: manifest,
    runId: run, sourceSha256: config.sourceSha256, policy: "prepared-native-reports-v1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(), admission: f.admission };
  const result = { outcome: "finalized", snapshotId: f.data.job.outputSnapshotId, verification: "passed", adoption: "unadopted" };
  const complete = vi.fn();
  const reject = vi.fn();
  const rejectedResult = { outcome: "verification_failed", failureId: "66666666-6666-4666-8666-666666666666", verification: "failed", adoption: "unadopted" };
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    expect(init?.redirect).toBe("error"); expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${config.verifierToken}`);
    const path = new URL(String(url)).pathname;
    if (path.endsWith("api_load_native_verification")) return Response.json(delivery);
    if (path.endsWith("api_reject_native_verification")) {
      reject(JSON.parse(String(init?.body))); return Response.json(rejectedResult);
    }
    if (path.endsWith("api_complete_native_verification")) {
      const body = JSON.parse(String(init?.body)); complete(body);
      expect(body.p_run).toBe(run);
      expect(JSON.parse(body.p_context_text).producer.attemptId).toBe(f.data.job.attemptId);
      return Response.json(result);
    }
    const object = f.objects.find(o => path.endsWith(`/${o.id}`));
    expect(object).toBeDefined();
    expect(path).toBe(`/storage/v1/object/engineering-native-results/${object!.scope.organizationId}/${object!.scope.projectId}/${object!.attemptId}/${object!.id}`);
    expect(init?.method).toBe("GET");
    return new Response(f.bytes[object!.role]);
  });
  return { f, delivery, result, fetch, complete, reject, rejectedResult };
}
afterEach(() => vi.useRealTimers());

describe("native verifier delivery client", () => {
  it("loads admitted context, measures actual native bytes and sends only verified context", async () => {
    const f = fixture();
    expect(await createNativeVerifier(config, f.fetch).verify(manifest, deliveryKey)).toEqual(f.result);
    expect(f.fetch).toHaveBeenCalledTimes(9); expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0][1]?.body).toBe(JSON.stringify({ p_manifest: manifest, p_key: deliveryKey }));
  });
  it("stays off without making requests", async () => {
    const f = fixture();
    await expect(createNativeVerifier({ ...config, enabled: false }, f.fetch).verify(manifest, deliveryKey)).rejects.toThrow("disabled");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["service_role", "authenticated", "anon"])("rejects a %s credential at configuration", role => {
    expect(() => createNativeVerifier({ ...config, verifierToken: token(role) })).toThrow("verifier role");
  });
  it.each(["http://project.example.test", "https://secret@project.example.test", "https://project.example.test/other", "https://project.example.test/?redirect=elsewhere"])("rejects unpinned origin %s", projectUrl => {
    expect(() => createNativeVerifier({ ...config, projectUrl })).toThrow("project origin");
  });
  it("refuses malformed delivery IDs before fetching", async () => {
    const f = fixture();
    await expect(createNativeVerifier(config, f.fetch).verify("../../other", deliveryKey)).rejects.toThrow("delivery identity");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["sourceSha256", "manifestId", "policy"] as const)("rejects changed %s before reading stored bytes", async field => {
    const f = fixture(); f.delivery[field] = "changed";
    await expect(createNativeVerifier(config, f.fetch).verify(manifest, deliveryKey)).rejects.toThrow("admitted delivery");
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.complete).not.toHaveBeenCalled();
  });
  it("does not submit a successful verdict for altered stored bytes", async () => {
    const f = fixture(); f.f.bytes.target[10] ^= 1;
    expect(await createNativeVerifier(config, f.fetch).verify(manifest, deliveryKey)).toEqual(f.rejectedResult);
    expect(f.reject).toHaveBeenCalledWith({ p_run: run, p_failure: expect.objectContaining({ code: "artifact_digest_mismatch", objectId: f.f.objects[1].id }) });
    expect(f.complete).not.toHaveBeenCalled();
  });
  it("does not convert transport TypeErrors into failed engineering checks", async () => {
    const f = fixture();
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (String(url).includes("/storage/")) throw new TypeError("fetch failed");
      return f.fetch(url, init);
    };
    await expect(createNativeVerifier(config, fetch).verify(manifest, deliveryKey)).rejects.toThrow("fetch failed");
    expect(f.reject).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  });
  it("recovers a rejected delivery without rereading files", async () => {
    const f = fixture(), fetch = vi.fn(async () => Response.json({ ...f.delivery, status: "rejected", result: f.rejectedResult }));
    expect(await createNativeVerifier(config, fetch).verify(manifest, deliveryKey)).toEqual(f.rejectedResult);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a substituted registry path", async () => {
    const f = fixture(); f.f.objects[0] = { ...f.f.objects[0], scope: { ...f.f.objects[0].scope, projectId: "../../other" } };
    await expect(createNativeVerifier(config, f.fetch).verify(manifest, deliveryKey)).rejects.toThrow("registry scope");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("recovers a completed receipt without re-reading files or rerunning CAD", async () => {
    const f = fixture(), fetch = vi.fn(async () => Response.json({ ...f.delivery, status: "completed", result: f.result }));
    expect(await createNativeVerifier(config, fetch).verify(manifest, deliveryKey)).toEqual(f.result);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects an oversized RPC body", async () => {
    const fetch = vi.fn(async () => new Response(" ".repeat(200_001)));
    await expect(createNativeVerifier(config, fetch).verify(manifest, deliveryKey)).rejects.toThrow("RPC body bounds");
  });
  it("rejects duplicate RPC keys", async () => {
    const fetch = vi.fn(async () => new Response('{"schema":1,"schema":2}'));
    await expect(createNativeVerifier(config, fetch).verify(manifest, deliveryKey)).rejects.toThrow("duplicate");
  });
  it("bounds an RPC transport that ignores cancellation", async () => {
    vi.useFakeTimers();
    const promise = createNativeVerifier(config, () => new Promise(() => undefined)).verify(manifest, deliveryKey);
    const check = expect(promise).rejects.toThrow("interrupted");
    await vi.advanceTimersByTimeAsync(45_000); await check;
  });
  it("bounds an RPC body that stalls", async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const promise = createNativeVerifier(config, async () => new Response(new ReadableStream({ cancel }))).verify(manifest, deliveryKey);
    const check = expect(promise).rejects.toThrow("interrupted");
    await vi.advanceTimersByTimeAsync(45_000); await check; expect(cancel).toHaveBeenCalled();
  });
});
