// @vitest-environment node
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createNativeArtifactHandler, NATIVE_ARTIFACT_SCHEMA, type NativeArtifactScope } from "./native-artifact-transport";
import type { NativeRegistrationRepository } from "./native-result-registration";

const u = (n: number) => `51900000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: NativeArtifactScope = {
  organizationId: u(1), projectId: u(2), workerId: u(3), installationId: u(4),
  bootId: u(5), sessionId: u(6), taskId: u(7), attemptId: u(8), fence: 9,
  inputSnapshotId: u(10), candidateSnapshotId: u(11), predecessorAttemptId: u(12),
};
const token = `odw_${"a".repeat(64)}`;
const inputId = u(13), objectId = u(14);
const inputBytes = new TextEncoder().encode("exact prepared input");
const outputBytes = new TextEncoder().encode('{"candidate":"synthetic"}');
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const endpoint = "https://fixture.test/functions/v1/engineering-worker-artifact";

function fixture() {
  const stored = new Map<string, Uint8Array>();
  let current = true, authorizedScope: NativeArtifactScope = scope, registered = false;
  const registration: NativeRegistrationRepository = {
    loadAdmission: vi.fn(async () => stored.has("result") ? {
      taskId: scope.taskId, attemptId: scope.attemptId, organizationId: scope.organizationId,
      projectId: scope.projectId, fence: scope.fence, inputSnapshotId: scope.inputSnapshotId,
      candidateSnapshotId: scope.candidateSnapshotId, role: "result" as const, storageObjectId: objectId,
      bucketId: "synthetic-private", objectName: `attempt/${scope.attemptId}/result`,
      storageVersion: "immutable-1", storageUpdatedAt: "2026-09-27T00:00:00Z",
    } : null),
    readUploadedObject: vi.fn(async (id: string) => id === objectId && stored.has("result")
      ? new Response(stored.get("result")) : new Response(null, { status: 404 })),
    registerMeasuredObject: vi.fn(async (row) => {
      if (!current || row.organizationId !== scope.organizationId || row.attemptId !== scope.attemptId
        || row.fence !== scope.fence || row.inputSnapshotId !== scope.inputSnapshotId
        || row.candidateSnapshotId !== scope.candidateSnapshotId || row.sha256 !== sha(outputBytes)) {
        throw new Error("owner-only registry rejected");
      }
      if (registered) return false;
      registered = true; return true;
    }),
  };
  const put = vi.fn(async (_scope, role, bytes: Uint8Array) => {
    if (role !== "result") throw new Error("role denied");
    const old = stored.get(role);
    if (old && sha(old) !== sha(bytes)) throw new Error("immutable object conflict");
    if (!old) stored.set(role, new Uint8Array(bytes));
  });
  const authorize = vi.fn(async ({ scope: requested, tokenSha256 }: {scope:NativeArtifactScope;tokenSha256:string}) => {
    if (!current || tokenSha256 !== sha(new TextEncoder().encode(token))
      || JSON.stringify(requested) !== JSON.stringify(scope)) return null;
    return { scope: authorizedScope, input: { id: inputId, bytes: inputBytes.byteLength, sha256: sha(inputBytes) } };
  });
  const readInput = vi.fn(async (id: string) => id === inputId ? new Response(inputBytes) : new Response(null, { status: 404 }));
  const handler = createNativeArtifactHandler({ enabled: () => true, authorize, readInput,
    putImmutableOutput: put, registration });
  const headers = (bytes: Uint8Array, extra: Record<string,string> = {}) => ({
    authorization: `Bearer ${token}`, "x-overdrafter-scope": JSON.stringify(scope),
    "x-overdrafter-bytes": String(bytes.byteLength), "x-overdrafter-sha256": sha(bytes), ...extra,
  });
  const get = (extra: Record<string,string> = {}) => new Request(endpoint, { method: "GET",
    headers: headers(inputBytes, { "x-overdrafter-artifact-id": inputId, ...extra }) });
  const upload = (bytes = outputBytes, extra: Record<string,string> = {}) => new Request(endpoint, {
    method: "PUT", headers: headers(bytes, { "content-type": "application/octet-stream",
      "x-overdrafter-role": "result", ...extra }), body: bytes,
  });
  return { handler, authorize, readInput, put, registration, stored, get, upload,
    revoke: () => { current = false; }, foreignAdmission: () => { authorizedScope = { ...scope, organizationId: u(99) }; } };
}

describe("native artifact transport", () => {
  it("keeps the route disabled before credential, object, or registry access", async () => {
    const f = fixture();
    const handler = createNativeArtifactHandler({ enabled: () => false, authorize: f.authorize,
      readInput: f.readInput, putImmutableOutput: f.put, registration: f.registration });
    expect((await handler(f.get())).status).toBe(503);
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it("downloads only the admitted opaque input ID and exact bytes", async () => {
    const f = fixture(); const response = await f.handler(f.get());
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(inputBytes);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.readInput).toHaveBeenCalledWith(inputId, expect.any(AbortSignal));
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it("rejects wrong tenant, session, fence, predecessor and worker without object reads", async () => {
    for (const patch of [{organizationId:u(40)},{sessionId:u(41)},{fence:10},
      {predecessorAttemptId:u(42)},{workerId:u(43)}]) {
      const f = fixture(); const altered = JSON.stringify({ ...scope, ...patch });
      expect((await f.handler(f.get({"x-overdrafter-scope":altered}))).status).toBe(403);
      expect(f.readInput).not.toHaveBeenCalled();
    }
  });
  it("rejects foreign paths, redirects, overbounds, and changed object bytes", async () => {
    const f = fixture();
    expect((await f.handler(new Request(`${endpoint}?path=../foreign`,{method:"GET",headers:f.get().headers}))).status).toBe(403);
    expect((await f.handler(f.get({"x-overdrafter-artifact-id":"../foreign"}))).status).toBe(400);
    expect((await f.handler(f.get({"x-overdrafter-bytes":"16000001"}))).status).toBe(400);
    f.readInput.mockImplementationOnce(async () => new Response(null,{status:302,headers:{location:"https://foreign.test/object"}}));
    expect((await f.handler(f.get())).status).toBe(503);
    f.readInput.mockImplementationOnce(async () => new Response(new TextEncoder().encode("changed")));
    expect((await f.handler(f.get())).status).toBe(503);
    expect(f.put).not.toHaveBeenCalled();
  });
  it("rechecks revocation and foreign admissions before returning bytes", async () => {
    const f = fixture(); f.foreignAdmission();
    expect((await f.handler(f.get())).status).toBe(403);
    expect(f.readInput).not.toHaveBeenCalled();
    const g = fixture(); g.readInput.mockImplementationOnce(async () => { g.revoke(); return new Response(inputBytes); });
    expect((await g.handler(g.get())).status).toBe(403);
  });
  it("measures and registers one immutable output; lost reply replays the same bytes", async () => {
    const f = fixture();
    const first = await f.handler(f.upload());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ schema:NATIVE_ARTIFACT_SCHEMA, delivered:true, role:"result" });
    expect(f.stored.get("result")).toEqual(outputBytes);
    expect(f.registration.registerMeasuredObject).toHaveBeenCalledTimes(1);
    // Simulate a lost first response. An identical PUT reads the retained object
    // and SQL registration replay returns false without a second candidate.
    expect((await f.handler(f.upload())).status).toBe(200);
    expect(f.registration.registerMeasuredObject).toHaveBeenCalledTimes(2);
    expect(f.stored.size).toBe(1);
    expect((await f.handler(f.upload(new TextEncoder().encode("changed")))).status).toBe(503);
    expect(f.stored.get("result")).toEqual(outputBytes);
  });
  it("rejects digest mismatch and stale authority without registration or a verification receipt", async () => {
    const f = fixture();
    expect((await f.handler(f.upload(outputBytes,{"x-overdrafter-sha256":"0".repeat(64)}))).status).toBe(503);
    expect(f.put).not.toHaveBeenCalled();
    const g = fixture(); g.revoke();
    expect((await g.handler(g.upload())).status).toBe(403);
    expect(g.put).not.toHaveBeenCalled();
    expect(g.registration.registerMeasuredObject).not.toHaveBeenCalled();
    const h = fixture(); const result = await h.handler(h.upload());
    const text = await result.text();
    expect(text).not.toContain("verification"); expect(text).not.toContain("signature");
    expect(text).not.toContain("candidateSnapshotId"); expect(text).not.toContain(token);
  });
  it("replays exact bytes after a real local HTTP response is interrupted", async () => {
    const f = fixture(); let drop = true;
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const part of incoming) chunks.push(Buffer.from(part));
      const wireHeaders: Record<string,string> = {};
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") wireHeaders[name] = value;
      }
      const body = Buffer.concat(chunks);
      const request = new Request(endpoint, { method: incoming.method, headers: wireHeaders,
        body: body.length ? body : undefined });
      const response = await f.handler(request);
      if (drop) { drop = false; outgoing.destroy(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve));
    try {
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}/functions/v1/engineering-worker-artifact`;
      const headers = Object.fromEntries(f.upload().headers);
      await expect(fetch(url,{method:"PUT",headers,body:outputBytes})).rejects.toThrow();
      expect(f.stored.get("result")).toEqual(outputBytes);
      const retry = await fetch(url,{method:"PUT",headers,body:outputBytes});
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({schema:NATIVE_ARTIFACT_SCHEMA,delivered:true,role:"result"});
      expect(f.stored.size).toBe(1);
      expect(f.registration.registerMeasuredObject).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve,reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
