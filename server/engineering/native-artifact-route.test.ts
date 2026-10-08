// @vitest-environment node
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeArtifactRoute, NATIVE_ARTIFACT_ROUTE } from "./native-artifact-route";
import { ARTIFACT_AUTHORITY_SQL, ARTIFACT_INPUT_SQL, ARTIFACT_OUTPUT_SQL, ARTIFACT_ISOLATION_SQL, ARTIFACT_LOCK_SQL, ARTIFACT_ATTEMPT_LOCK_SQL, ARTIFACT_STORAGE_LOCK_SQL, ARTIFACT_REGISTER_SQL } from "./native-artifact-repository";
import { NATIVE_STORAGE_IDENTITY_SQL } from "./native-private-storage";
const id = (n: number) => `51900000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), projectId: id(2), workerId: id(3), installationId: id(4), bootId: id(5), sessionId: id(6),
  taskId: id(7), attemptId: id(8), fence: 9, inputSnapshotId: id(10), candidateSnapshotId: id(11), predecessorAttemptId: null };
const bytes = new TextEncoder().encode("disposable fixture"), sha = createHash("sha256").update(bytes).digest("hex");
const headers = { authorization: `Bearer odw_${"a".repeat(64)}`, "x-overdrafter-scope": JSON.stringify(scope),
  "x-overdrafter-artifact-id": id(13), "x-overdrafter-bytes": String(bytes.length), "x-overdrafter-sha256": sha };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
  server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
}))); });
async function setup(enabled?: boolean, wrongBytes = false, output = false, hangPool = false) {
  let stored = false;
  const query = vi.fn(async (text: string) => {
    if (text === ARTIFACT_AUTHORITY_SQL) return { rows: [{ scope, inputEligible: !output, outputEligible: output }] };
    if (text === ARTIFACT_INPUT_SQL) return { rows: [{ id: id(13), bytes: bytes.length, sha256: sha, storageObjectId: id(14), bucketId: "fixture",
      objectName: "source", storageVersion: id(15), storageUpdatedAt: "2026-10-03T00:00:00Z" }] };
    if (text === ARTIFACT_OUTPUT_SQL) return { rows: [{ bucketId: "fixture", objectName: `native-results/${scope.attemptId}/result`,
      storageObjectId: stored ? id(14) : null, storageVersion: stored ? id(15) : null, storageUpdatedAt: stored ? "2026-10-03T00:00:00Z" : null }] };
    if (text === ARTIFACT_ISOLATION_SQL) return { rows: [{ isolation: "read committed" }] };
    if (text === ARTIFACT_LOCK_SQL) return { rows: [{ id: scope.taskId }] };
    if (text === ARTIFACT_ATTEMPT_LOCK_SQL) return { rows: [{ id: scope.attemptId }] };
    if (text === ARTIFACT_STORAGE_LOCK_SQL) return { rows: [{ id: id(14) }] };
    if (text === ARTIFACT_REGISTER_SQL) return { rows: [{ registered: true }] };
    if (text === NATIVE_STORAGE_IDENTITY_SQL) return { rows: [{ id: id(14) }] };
    return { rows: [] };
  });
  const connect = vi.fn(async () => {
    if (hangPool) await new Promise<never>(() => {});
    return { query, release: vi.fn() };
  });
  const storageFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") { stored = true; return Response.json({ Key: "synthetic" }); }
    return new Response(wrongBytes ? "different" : bytes);
  });
  const route = createNativeArtifactRoute({ pool: { connect }, storageOrigin: "https://storage.invalid", storageAuthorization: "Bearer synthetic-fixture",
    publicOrigin: "https://artifact.invalid", enabled, storageVersionIdQualified: true, fetch: storageFetch, timeoutMs: hangPool ? 20 : 30000 });
  const server = createServer((req, res) => { void route(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("fixture address");
  return { query, connect, storageFetch, port: address.port, url: `http://127.0.0.1:${address.port}${NATIVE_ARTIFACT_ROUTE}` };
}
describe("Node artifact route (synthetic loopback only)", () => {
  it("defaults off without database or storage access", async () => {
    const f = await setup(); const response = await fetch(f.url, { method: "PUT", body: bytes });
    expect(response.status).toBe(503); expect((await response.json()).error).toBe("transfer_disabled");
    expect(f.connect).not.toHaveBeenCalled(); expect(f.storageFetch).not.toHaveBeenCalled();
  });
  it("mounts only the exact raw path", async () => {
    const f = await setup(true); expect((await fetch(`${f.url}?extra=1`)).status).toBe(404); expect(f.connect).not.toHaveBeenCalled();
  });
  it("ends the HTTP response on deadline even when the pool never resolves", async () => {
    const f = await setup(true, false, false, true);
    const response = await fetch(f.url, { headers, signal: AbortSignal.timeout(1000) });
    expect(response.status).toBe(503); expect(response.headers.get("connection")).toBe("close");
    expect((await response.json()).error).toBe("transfer_unavailable");
    expect(f.connect).toHaveBeenCalledTimes(1); expect(f.storageFetch).not.toHaveBeenCalled();
  });
  it("rejects invalid authentication before acquiring SQL", async () => {
    const f = await setup(true); expect((await fetch(f.url)).status).toBe(403); expect(f.connect).not.toHaveBeenCalled();
  });
  it("carries authenticated input through real HTTP, concrete SQL and storage drivers", async () => {
    const f = await setup(true); const response = await fetch(f.url, { headers });
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("x-overdrafter-sha256")).toBe(sha); expect(f.storageFetch).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.some(([text]) => text === "commit")).toBe(true);
  });
  it("does not release wrong provider bytes even with a matching SQL generation", async () => {
    const f = await setup(true, true); const response = await fetch(f.url, { headers });
    expect(response.status).toBe(503); expect((await response.json()).error).toBe("transfer_unavailable");
  });
  it("rejects duplicate headers rather than trusting Node normalization", async () => {
    const f = await setup(true);
    const status = await new Promise<number>(resolve => {
      const request = httpRequest({ host: "127.0.0.1", port: f.port, path: NATIVE_ARTIFACT_ROUTE, headers: ["authorization", headers.authorization, "authorization", headers.authorization] }, response => { response.resume(); resolve(response.statusCode!); });
      request.end();
    });
    expect(status).toBe(400); expect(f.connect).not.toHaveBeenCalled();
  });
  it("delivers a streamed PUT through create, two exact-generation reads and committed registration", async () => {
    const f = await setup(true, false, true);
    const outputHeaders: Record<string, string> = { ...headers, "content-type": "application/octet-stream", "x-overdrafter-role": "result" };
    delete outputHeaders["x-overdrafter-artifact-id"];
    const response = await fetch(f.url, { method: "PUT", headers: outputHeaders, body: bytes });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ schema: "overdrafter.native-artifact-transfer.v1", delivered: true, role: "result" });
    expect(f.storageFetch.mock.calls.map(call => call[1]?.method)).toEqual(["POST", "GET", "GET"]);
    expect(f.query.mock.calls.some(([text]) => text === ARTIFACT_REGISTER_SQL)).toBe(true);
  });
  it("streams a PUT into the existing measured-body check before any storage write", async () => {
    const f = await setup(true); const outputHeaders = { ...headers, "content-type": "application/octet-stream", "x-overdrafter-role": "result" };
    delete (outputHeaders as Partial<typeof headers>)["x-overdrafter-artifact-id"];
    const response = await fetch(f.url, { method: "PUT", headers: outputHeaders, body: bytes });
    expect(response.status).toBe(403); expect(f.storageFetch).not.toHaveBeenCalled();
  });
});
