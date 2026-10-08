import { describe, expect, it, vi } from "vitest";
import { createNativePrivateStorage, NATIVE_STORAGE_IDENTITY_SQL } from "./native-private-storage";
import type { PrivateArtifactSql } from "./native-artifact-repository";
const id = "11111111-1111-4111-8111-111111111111", version = "22222222-2222-4222-8222-222222222222";
const ref = { method: "GET" as const, storageObjectId: id, bucketId: "private", objectName: "folder/a b.bin", storageVersion: version, storageUpdatedAt: "2026-10-03T00:00:00Z", ifMatch: version };
const put = { method: "PUT" as const, bucketId: "private", objectName: "native-results/test/result", ifNoneMatch: "*" as const, contentType: "application/octet-stream" as const, bytes: new Uint8Array([1, 2, 3]) };
const signal = () => new AbortController().signal;
function setup(options: { response?: () => Response | Promise<Response>; rows?: () => Record<string, unknown>[]; timeoutMs?: number; qualified?: boolean } = {}) {
  const query = vi.fn(async () => options.rows?.() ?? [{ id }]);
  const sql = { query, transaction: vi.fn() } as PrivateArtifactSql;
  const fetch = vi.fn(async () => options.response?.() ?? new Response(new Uint8Array([1, 2, 3])));
  const storage = createNativePrivateStorage({ sql, fetch, enabled: true, versionIdQualified: options.qualified ?? true,
    authorization: "Bearer synthetic-fixture-only", storageOrigin: "https://storage.invalid", timeoutMs: options.timeoutMs });
  return { storage, fetch, query, sql };
}
describe("Supabase private storage driver", () => {
  it("has a separate default-off versionId qualification gate", async () => {
    const f = setup({ qualified: false }); await expect(f.storage.read(ref, signal())).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
  });
  it("uses exact versionId, no UUID If-Match, and brackets the complete body with SQL identity reads", async () => {
    const f = setup(); const response = await f.storage.read(ref, signal());
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(put.bytes);
    expect(f.fetch).toHaveBeenCalledWith(`https://storage.invalid/storage/v1/object/authenticated/private/folder/a%20b.bin?versionId=${version}`, expect.objectContaining({ method: "GET", redirect: "error", headers: expect.not.objectContaining({ "if-match": expect.anything() }) }));
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query).toHaveBeenCalledWith(NATIVE_STORAGE_IDENTITY_SQL, [id, "private", "folder/a b.bin", version, ref.storageUpdatedAt], expect.anything());
  });
  it("rejects generation changes before releasing any bytes", async () => {
    let count = 0;
    const f = setup({ rows: () => ++count === 1 ? [{ id }] : [] });
    await expect(f.storage.read(ref, signal())).rejects.toThrow(); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a stale SQL generation without HTTP", async () => {
    const f = setup({ rows: () => [] }); await expect(f.storage.read(ref, signal())).rejects.toThrow(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([400, 404, 412, 206, 302])("fails closed on unsupported/stale provider status %s", async status => {
    const f = setup({ response: () => new Response("invalid", { status }) });
    await expect(f.storage.read(ref, signal())).rejects.toThrow(); expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("cancels a hanging read and does not execute the final SQL check", async () => {
    const cancel = vi.fn(); const f = setup({ timeoutMs: 10, response: () => new Response(new ReadableStream({ cancel })) });
    await expect(f.storage.read(ref, signal())).rejects.toThrow(); expect(cancel).toHaveBeenCalled(); expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("rejects compressed or oversized bodies", async () => {
    const f = setup({ response: () => new Response("abc", { headers: { "content-encoding": "gzip" } }) });
    await expect(f.storage.read(ref, signal())).rejects.toThrow();
    const g = setup({ response: () => new Response(new Uint8Array(16000001)) });
    await expect(g.storage.read(ref, signal())).rejects.toThrow();
  });
  it("posts create-only and accepts only explicit duplicate conflicts", async () => {
    const f = setup(); expect(await f.storage.create(put, signal())).toBe("created");
    expect(f.fetch).toHaveBeenCalledWith("https://storage.invalid/storage/v1/object/private/native-results/test/result", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "x-upsert": "false" }) }));
    const g = setup({ response: () => Response.json({ code: "ResourceAlreadyExists" }, { status: 409 }) });
    expect(await g.storage.create(put, signal())).toBe("conflict");
    const h = setup({ response: () => Response.json({ code: "AccessDenied" }, { status: 400 }) });
    await expect(h.storage.create(put, signal())).rejects.toThrow();
  });
  it("does not retry uncertain creates", async () => {
    const f = setup({ response: () => { throw new Error("response lost"); } });
    await expect(f.storage.create(put, signal())).rejects.toThrow(); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects traversal and malformed generation parameters", async () => {
    const f = setup();
    await expect(f.storage.read({ ...ref, storageVersion: "not-etag" }, signal())).rejects.toThrow();
    await expect(f.storage.create({ ...put, objectName: "../evil" }, signal())).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
