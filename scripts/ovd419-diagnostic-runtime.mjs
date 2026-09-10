// Bound runtime module. Read as bytes by the launcher; never import on the controller.

import { writeSync } from "node:fs";
const fail = () => { throw new Error("OVD-419 in-job precondition failed"); };
const guardState = { executed: false, started: false, reported: false };
let guardStage = "expected_environment";
let guardHttpStatus;
let probeEvidence;
const unsuccessfulProbeReasons = new Set(["captcha", "login_required", "anonymous_quote_home", "provider_error", "authenticated_dashboard_not_confirmed"]);
const reportFailure = () => {
  if (guardState.reported) return;
  guardState.reported = true;
  const evidence = { reason: "ovd419_guard_failed", stage: guardStage };
  if (Number.isInteger(guardHttpStatus) && guardHttpStatus >= 400 && guardHttpStatus <= 599) evidence.httpStatus = guardHttpStatus;
  // Preserve only the worker's fixed classification, never its private payload.
  if (guardState.executed && guardStage === "probe_result" && probeEvidence?.authenticated === false && unsuccessfulProbeReasons.has(probeEvidence.reason)) evidence.probeReason = probeEvidence.reason;
  try { writeSync(2, JSON.stringify(evidence) + "\n"); } catch { /* Logging must not bypass rejection. */ }
};
const json = async (url, phase, headers) => {
  guardStage = phase + "_request";
  const response = await fetch(url, { headers });
  if (!response.ok) { guardStage = phase + "_http"; guardHttpStatus = response.status; fail(); }
  guardStage = phase + "_json";
  return await response.json();
};
let expected;
try { expected = JSON.parse(Buffer.from(process.env.OVD419_EXPECTED_PRECONDITIONS_B64, "base64url").toString("utf8")); } catch { reportFailure(); fail(); }
if (!expected || typeof expected.region !== "string" || !/^[a-z]+(?:-[a-z]+)+[0-9]+$/.test(expected.region) || !/^[0-9a-f]{64}$/.test(expected.packetSha256) || !Number.isFinite(Date.parse(expected.expiresAt)) || Date.now() >= Date.parse(expected.expiresAt)) { reportFailure(); fail(); }
const runApi = `https://${expected.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${encodeURIComponent(expected.project)}`;
const compare = (left, right) => { if (left < right) return -1; if (left > right) return 1; return 0; };
const canonical = (value) => { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonical(value[key])])); return value; };
const hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value)))))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
globalThis[Symbol.for("overdrafter.xometryAuthProbe.preNetworkGuard")] = async () => {
  guardState.started = true;
  try {
    if (Date.now() >= Date.parse(expected.expiresAt)) fail();
    const tokenPayload = await json("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", "token", { "Metadata-Flavor": "Google" });
    guardStage = "token_value";
    const token = tokenPayload.access_token;
    if (typeof token !== "string" || token.length === 0) fail();
    const headers = { Authorization: `Bearer ${token}` };
    const objectUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(process.env.XOMETRY_PROFILE_SNAPSHOT_BUCKET)}/o/${encodeURIComponent(process.env.XOMETRY_PROFILE_SNAPSHOT_OBJECT)}`;
    const snapshot = await json(objectUrl, "snapshot", headers);
    guardStage = "snapshot_identity";
    if (await hash({ generation: snapshot.generation, metageneration: snapshot.metageneration, etag: snapshot.etag }) !== expected.snapshotFingerprint) fail();
    const jobUrl = `${runApi}/jobs/${encodeURIComponent(expected.job)}`;
    const job = await json(jobUrl, "job", headers);
    // Execution status updates resourceVersion; desired identity must stay fixed.
    guardStage = "job_uid";
    if (typeof expected.jobIdentity?.uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(expected.jobIdentity.uid) || job.metadata?.uid !== expected.jobIdentity.uid) fail();
    guardStage = "job_generation";
    if (!Number.isSafeInteger(expected.jobIdentity.generation) || expected.jobIdentity.generation < 1 || job.metadata?.generation !== expected.jobIdentity.generation) fail();
    guardStage = "job_configuration";
    if (await hash({ name: job.metadata?.name, spec: job.spec }) !== expected.jobIdentity.configurationFingerprint) fail();
    let pageToken = "";
    const ids = [];
    const seenIds = new Set();
    const seenTokens = new Set();
    let activeCount = 0;
    do {
      const query = new URLSearchParams({ labelSelector: `run.googleapis.com/job=${expected.job}`, limit: "1000", continue: pageToken });
      const page = await json(`${runApi}/executions?${query}`, "inventory", headers);
      guardStage = "inventory_page";
      if (!page || !Array.isArray(page.items) || (page.unreachable !== undefined && (!Array.isArray(page.unreachable) || page.unreachable.length > 0))) fail();
      for (const execution of page.items) {
        guardStage = "execution_identity";
        const id = execution?.metadata?.name;
        const status = execution?.status;
        if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(id) || seenIds.has(id) || execution.metadata?.labels?.["run.googleapis.com/job"] !== expected.job) fail();
        guardStage = "execution_status";
        if (!status || typeof status !== "object" || Array.isArray(status)) fail();
        const runningCount = status.runningCount ?? 0;
        if (!Number.isInteger(runningCount) || runningCount < 0 || (status.completionTime !== undefined && (typeof status.completionTime !== "string" || !Number.isFinite(Date.parse(status.completionTime))))) fail();
        seenIds.add(id);
        ids.push(id);
        if (status.completionTime === undefined || runningCount > 0) {
          guardStage = "execution_active_owner";
          if (id !== process.env.CLOUD_RUN_EXECUTION) fail();
          activeCount += 1;
        }
      }
      guardStage = "inventory_pagination";
      if (page.metadata !== undefined && (!page.metadata || typeof page.metadata !== "object" || Array.isArray(page.metadata))) fail();
      if (page.metadata?.continue !== undefined && typeof page.metadata.continue !== "string") fail();
      pageToken = page.metadata?.continue ?? "";
      if (typeof pageToken !== "string" || (pageToken && (seenTokens.has(pageToken) || page.items.length === 0))) fail();
      if (pageToken) seenTokens.add(pageToken);
      guardStage = "inventory_limit";
      if (ids.length >= 10000) fail();
    } while (pageToken);
    guardStage = "current_execution";
    const currentExecution = process.env.CLOUD_RUN_EXECUTION;
    if (!currentExecution || activeCount !== 1 || !ids.includes(currentExecution)) fail();
    guardStage = "prior_inventory";
    const priorIds = ids.filter((id) => id !== currentExecution).sort(compare);
    if (priorIds.length !== expected.executionInventory.totalCount || await hash(priorIds) !== expected.executionInventory.fingerprint) fail();
    if (Date.now() >= Date.parse(expected.expiresAt)) fail();
    guardState.executed = true;
  } catch { reportFailure(); fail(); }
};
// A worker catch may call process.exit(1), so report synchronously before exit.
const onGuardExit = () => {
  if (guardState.reported) return;
  if (!guardState.started) guardStage = "guard_not_called";
  else if (guardState.executed) guardStage = "probe_result";
  reportFailure();
};
process.on("exit", onGuardExit);
const originalLog = console.log;
console.log = (value) => { try { probeEvidence = JSON.parse(String(value)); } catch { guardStage = "probe_output"; reportFailure(); fail(); } };
await import("file:///app/dist/tools/probeXometryProfileAuth.js");
console.log = originalLog;
if (!guardState.executed || process.exitCode || !probeEvidence?.authenticated || probeEvidence.reason !== "authenticated_dashboard") {
  guardStage = guardState.started ? "probe_result" : "guard_not_called";
  reportFailure();
  fail();
}
process.removeListener("exit", onGuardExit);
originalLog(JSON.stringify({ reason: "authenticated_dashboard", authenticated: true, preconditionsEnforcedBeforeBrowserNetworkActivation: true }));
