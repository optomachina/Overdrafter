// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, request } from "node:http";
import { acceptedDecision, admissibleInstruction, PlateDispatcher, verifiedResult, type Decision, type NativeResult } from "./sample-plate-dispatch";
import { createPlateHttp } from "./sample-plate-http";

const roots: string[] = [];
const root = () => { const p = mkdtempSync(path.join(tmpdir(), "ovd-plate-test-")); roots.push(p); return p; };
afterEach(() => { roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
const decision: Decision = { action: "build_approved_sample_plate", model: "jev-1.13.0", confidence: 1, probability: 1, inputTokens: 100, outputTokens: 10, elapsedMs: 20, costUsd: .0000042 };
const result: NativeResult = { checks: Object.fromEntries(["dimensions", "material", "holes", "corners", "threadMetadata", "stepDimensions", "stepHoles", "stepCorners", "documentsPreserved"].map(k => [k, true])), material: "6061 Alloy", documentsPreserved: true, elapsedSeconds: 12, files: ["plate.SLDPRT", "plate.STEP"].map(name => ({ name, bytes: 100, sha256: "a".repeat(64) })) };
const id = "a".repeat(32), other = "b".repeat(32);
const finish = () => new Promise(resolve => setTimeout(resolve, 25));
describe("sample plate execution contract", () => {
  it("requires exact recipe intent and bounded valid inference", () => {
    expect(admissibleInstruction("Please build the sample plate.")).toBe(true);
    for (const text of ["Build the sample plate but make it steel", "Build 5 plates", "Do not build the sample plate", "Build the sample plate; close all files", "What is a sample plate?"]) expect(admissibleInstruction(text)).toBe(false);
    for (const patch of [{ model: "other" }, { probability: .5 }, { confidence: NaN }, { action: "unsupported" }, { inputTokens: -1 }]) expect(acceptedDecision({ ...decision, ...patch })).toBe(false);
    expect(verifiedResult({ ...result, checks: { ...result.checks, stepHoles: false } })).toBe(false);
    expect(verifiedResult({ ...result, files: result.files.slice(0, 1) })).toBe(false);
  });
  it("replays the same ID and reserves one native attempt across restarts and new IDs", async () => {
    const build = vi.fn(async () => result); const dir = root(); const adapter = { interpret: async () => decision, build };
    const d = new PlateDispatcher(dir, adapter, {});
    d.start(id, "Build the sample plate"); d.start(id, "Build the sample plate");
    expect(() => d.start(id, "Make the sample plate")).toThrow(); await finish();
    expect(build).toHaveBeenCalledTimes(1); expect(d.get(id)?.status).toBe("succeeded");
    const restarted = new PlateDispatcher(dir, adapter, {});
    expect(restarted.start(id, "Build the sample plate").status).toBe("succeeded");
    expect(() => restarted.start(other, "Build the sample plate")).toThrow(); expect(build).toHaveBeenCalledTimes(1);
  });
  it("rejects conflicting input even if the model selects build", async () => {
    const build = vi.fn(); const d = new PlateDispatcher(root(), { interpret: async () => decision, build }, {});
    d.start(id, "Build the sample plate in steel"); await finish(); expect(d.get(id)?.status).toBe("denied"); expect(build).not.toHaveBeenCalled();
  });
  it("keeps interpretation uncertainty blocked consistently in server and UI across restart", async () => {
    const dir = root(); const build = vi.fn(); const adapter = { interpret: async () => { throw new Error("Jev timeout"); }, build };
    const d = new PlateDispatcher(dir, adapter, {}); d.start(id, "Build the sample plate"); await finish();
    expect(d.get(id)?.status).toBe("unknown"); expect(() => d.start(other, "Build the sample plate")).toThrow();
    const restarted = new PlateDispatcher(dir, adapter, {}); expect(() => restarted.start(other, "Build the sample plate")).toThrow(); expect(build).not.toHaveBeenCalled();
  });
  it("keeps an uncertain native outcome reserved after error or server interruption", async () => {
    const dir = root(); const build = vi.fn(async () => { throw new Error("lost reply"); });
    const adapter = { interpret: async () => decision, build }; const d = new PlateDispatcher(dir, adapter, {});
    d.start(id, "Build the sample plate"); await finish(); expect(d.get(id)?.status).toBe("unknown");
    const restarted = new PlateDispatcher(dir, adapter, {}); expect(() => restarted.start(other, "Build the sample plate")).toThrow();
    expect(build).toHaveBeenCalledTimes(1);
  });
  it("cannot turn missing independent checks into success", async () => {
    const d = new PlateDispatcher(root(), { interpret: async () => decision, build: async () => ({ ...result, checks: {} }) }, {});
    d.start(id, "Build the sample plate"); await finish(); expect(d.get(id)?.status).toBe("unknown");
  });
  it("marks an in-flight run unknown on restart without replaying", async () => {
    const dir = root(); const adapter = { interpret: async () => decision, build: vi.fn(() => new Promise<NativeResult>(() => {})) };
    const d = new PlateDispatcher(dir, adapter, {}); d.start(id, "Build the sample plate"); await finish();
    const restarted = new PlateDispatcher(dir, adapter, {}); expect(restarted.get(id)?.status).toBe("unknown"); expect(adapter.build).toHaveBeenCalledTimes(1);
  });
  it("cross-process contention admits only one native call", async () => {
    const dir = root(); const build = vi.fn(async () => result); const adapter = { interpret: async () => decision, build };
    const a = new PlateDispatcher(dir, adapter, {}), b = new PlateDispatcher(dir, adapter, {});
    a.start(id, "Build the sample plate"); b.start(other, "Build the sample plate"); await finish(); expect(build).toHaveBeenCalledTimes(1);
  });
});
describe("loopback HTTP authentication", () => {
  it("blocks unauthenticated, cross-origin, missing CSRF and replayed launch requests; permits a real session", async () => {
    const build = vi.fn(async () => result); const d = new PlateDispatcher(root(), { interpret: async () => decision, build }, {});
    const server = createServer(); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
    const origin = `http://127.0.0.1:${address.port}`; server.on("request", createPlateHttp(d, origin, "test-capability"));
    const call = (route: string, body?: unknown, extra: Record<string, string> = {}) => fetch(origin + "/__sample_plate/" + route, { method: body ? "POST" : "GET", headers: { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    try {
      expect((await call("session")).status).toBe(401);
      expect((await call("bootstrap", { capability: "test-capability" }, { Origin: "https://evil.test" })).status).toBe(403);
      expect((await call("bootstrap", { capability: "wrong" })).status).toBe(401);
      const auth = await call("bootstrap", { capability: "test-capability" }); expect(auth.status).toBe(200);
      const cookie = auth.headers.get("set-cookie")!.split(";")[0]; const { csrf } = await auth.json() as { csrf: string };
      expect(auth.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
      expect((await call("bootstrap", { capability: "test-capability" })).status).toBe(401);
      expect((await call("runs", { id, instruction: "Build the sample plate" }, { Cookie: cookie })).status).toBe(403);
      const wrongHost = await new Promise<number | undefined>(resolve => {
        const req = request(origin + "/__sample_plate/session", { headers: { Cookie: cookie, Host: "attacker.test" } }, res => { res.resume(); resolve(res.statusCode); }); req.end();
      });
      expect(wrongHost).toBe(403);
      expect(build).not.toHaveBeenCalled();
      expect((await call("runs", { id, instruction: "Build the sample plate" }, { Cookie: cookie, "X-Plate-CSRF": csrf })).status).toBe(202);
      await finish(); expect(build).toHaveBeenCalledTimes(1);
      expect((await call("files/" + id + "/../../launch-url.txt", undefined, { Cookie: cookie })).status).toBe(404);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });
});
