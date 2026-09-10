import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { digest } from "./ovd419-job-diagnostic.mjs";

async function simulate({ reason = "login_required", expires = false, changedJob = false, changedSnapshot = false, extraExecution = false } = {}) {
  const raw = await readFile("scripts/ovd419-diagnostic-runtime.mjs", "utf8");
  const job = { metadata: { name: "fixture-job", uid: "fixture-uid", generation: 3 }, spec: { synthetic: true } };
  const snapshot = { generation: "1", metageneration: "1", etag: "fixture-etag" };
  const now = Date.parse("2026-09-10T16:00:00.000Z");
  const expected = { project: "fixture-project", region: "us-west1", job: "fixture-job", packetSha256: "a".repeat(64), runtimeModuleSha256: "b".repeat(64), expiresAt: new Date(now + (expires ? -1 : 100000)).toISOString(), snapshotFingerprint: digest(snapshot), jobIdentity: { uid: job.metadata.uid, generation: job.metadata.generation, configurationFingerprint: digest({ name: job.metadata.name, spec: job.spec }) }, executionInventory: { totalCount: 0, fingerprint: digest([]) } };
  const output = [], logged = [], fetched = [];
  const processObject = Object.assign(new EventEmitter(), { env: { OVD419_EXPECTED_PRECONDITIONS_B64: Buffer.from(JSON.stringify(expected)).toString("base64url"), XOMETRY_PROFILE_SNAPSHOT_BUCKET: "fixture-bucket", XOMETRY_PROFILE_SNAPSHOT_OBJECT: "fixture-object", CLOUD_RUN_EXECUTION: "fixture-execution" } });
  const fakeConsole = { log: (value) => logged.push(JSON.parse(value)) };
  const context = vm.createContext({ Buffer, URLSearchParams, TextEncoder, crypto: webcrypto, process: processObject, console: fakeConsole, writeSync: (_, value) => output.push(JSON.parse(value)),
    Date: class extends Date { static now() { return now; } },
    fetch: async (url) => {
      fetched.push(url);
      let data;
      if (url.includes("metadata.google.internal")) data = { access_token: "TEST-ONLY-TOKEN" };
      else if (url.includes("storage.googleapis.com")) data = { ...snapshot, generation: changedSnapshot ? "2" : "1" };
      else if (url.includes("/jobs/")) data = { ...job, metadata: { ...job.metadata, generation: changedJob ? 4 : 3 } };
      else data = { items: [{ metadata: { name: "fixture-execution", uid: "fixture-execution-uid", labels: { "run.googleapis.com/job": "fixture-job" } }, status: {} }, ...(extraExecution ? [{ metadata: { name: "other-execution", labels: { "run.googleapis.com/job": "fixture-job" } }, status: {} }] : [])] };
      return { ok: true, json: async () => data };
    },
    worker: async () => {
      fakeConsole.log(JSON.stringify({ reason, authenticated: reason === "authenticated_dashboard", cookie: "DO-NOT-RETAIN", url: "DO-NOT-RETAIN" }));
    },
  });
  const synthetic = raw.replace('import { writeSync } from "node:fs";', "").replace('await import("file:///app/dist/tools/probeXometryProfileAuth.js");', 'await globalThis[Symbol.for("overdrafter.xometryAuthProbe.preNetworkGuard")](); await worker();');
  let failed = false, syntheticError;
  try { await new vm.Script(`(async () => {${synthetic}\n})()`).runInContext(context); } catch (error) { failed = true; syntheticError = String(error); }
  return { output, logged, fetched, failed, syntheticError };
}

describe("bound runtime module against synthetic browser/metadata only", () => {
  it("emits only fixed authenticated evidence", async () => {
    const result = await simulate({ reason: "authenticated_dashboard" });
    expect(result.syntheticError).toBeUndefined(); expect(result.failed).toBe(false);
    expect(result.logged).toEqual([{ reason: "authenticated_dashboard", authenticated: true, preconditionsEnforcedBeforeBrowserNetworkActivation: true, executionId: "fixture-execution", executionUid: "fixture-execution-uid", packetSha256: "a".repeat(64), runtimeModuleSha256: "b".repeat(64) }]);
    expect(JSON.stringify(result.logged)).not.toContain("DO-NOT-RETAIN");
  });
  it.each(["captcha", "login_required", "anonymous_quote_home", "provider_error", "authenticated_dashboard_not_confirmed"])("retains fixed %s while rejecting unsuccessful probe", async (reason) => {
    const result = await simulate({ reason });
    expect(result.failed).toBe(true); expect(result.output).toEqual([{ reason: "ovd419_guard_failed", stage: "probe_result", probeReason: reason, executionId: "fixture-execution", executionUid: "fixture-execution-uid", packetSha256: "a".repeat(64), runtimeModuleSha256: "b".repeat(64) }]);
    expect(result.logged).toEqual([]);
  });
  it("expired approval stops even metadata access", async () => {
    const result = await simulate({ expires: true }); expect(result.failed).toBe(true); expect(result.fetched).toEqual([]);
  });
  it.each(["changedJob", "changedSnapshot", "extraExecution"])("rejects %s before worker evidence", async (flag) => {
    const result = await simulate({ [flag]: true }); expect(result.failed).toBe(true);
    expect(result.output.every((value) => value.probeReason === undefined)).toBe(true); expect(result.logged).toEqual([]);
  });
});
