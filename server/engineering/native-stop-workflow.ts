import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { NativeStopFailure, nativeStopReceipt, stopInteger, stopObject, type NativeStopRequest } from "./native-stop-admission.ts";
import { createNativeObserverRepository, observerId } from "./native-observer-repository.ts";
import { createNativeStopClient } from "./native-stop-client.ts";
import { createNativeStopWorkflowStore } from "./native-stop-workflow-store.ts";

type Identity = Omit<NativeStopRequest, "evidenceId">;
type Packet = Readonly<{ schema: "overdrafter.native-stop-workflow.v1"; identity: Identity;
  profileId: string; observerUrl: string; stopOrigin: string; manifest: string; journal: string;
  manifestSha256: string; journalSha256: string }>;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function identity(value: unknown): asserts value is Identity {
  const keys = ["workerId", "bootId", "taskId", "attemptId", "fence", "revision", "idempotencyKey"];
  if (!stopObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || ![value.workerId, value.bootId, value.taskId, value.attemptId, value.idempotencyKey].every(observerId)
    || !stopInteger(value.fence, 1, Number.MAX_SAFE_INTEGER) || !stopInteger(value.revision)) throw new NativeStopFailure(400, "invalid_stop_identity");
}
/** Syntax/byte preflight only. It never certifies the journal chain, runtime,
 * producer or stop; OVD575 SQL alone validates them under independent attribution. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 12) throw new NativeStopFailure(400, "observer_json_depth");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string") return `"${value.split("").map(char => {
    const code = char.charCodeAt(0);
    if (char === '"' || char === "\\") return `\\${char}`;
    return code < 32 || code > 126 ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }).join("")}"`;
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  if (stopObject(value)) return `{${Object.keys(value).sort().map(key => `${canonical(key, depth + 1)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
  throw new NativeStopFailure(400, "observer_json_value");
}
function checkedBytes(bytes: Uint8Array, limit: number): Record<string, unknown> {
  try {
    if (bytes.byteLength < 1 || bytes.byteLength > limit) throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), parsed: unknown = JSON.parse(text);
    if (!stopObject(parsed) || canonical(parsed) !== text) throw new Error();
    return parsed;
  } catch { throw new NativeStopFailure(400, "invalid_observer_bytes"); }
}
function validateEvidence(manifest: Uint8Array, journal: Uint8Array, expected: Identity) {
  const m = checkedBytes(manifest, 131072), j = checkedBytes(journal, 1048576);
  const binding = m.binding;
  if (m.schema !== "overdrafter.native-stop-observer.v1" || j.schema !== "overdrafter.native-attempt-journal.v1"
    || m.stopAdmission !== false || m.nativeQualification !== false || !stopObject(binding)
    || !isDeepStrictEqual(m.binding, j.binding) || m.journalSha256 !== digest(journal)
    || m.journalHeadSha256 !== j.headSha256
    || ["workerId", "bootId", "taskId", "attemptId", "fence"].some(key => binding[key] !== expected[key as keyof Identity])) {
    throw new NativeStopFailure(400, "observer_binding_differs");
  }
}
/** Default-off private orchestration. Three explicit phases, no automatic retry:
 * stage exact bytes -> attributed ingest -> separately qualified stop submission.
 * Qualification is deliberately not synthesized here; SQL can refuse submission
 * until independently provisioned exact-attempt qualification exists. */
export function createNativeStopWorkflow(config: Readonly<{
  enabled?: boolean; spoolRoot: string;
  observer: Parameters<typeof createNativeObserverRepository>[0];
  stop: Parameters<typeof createNativeStopClient>[0];
}>) {
  const enabled = () => { if (config.enabled !== true) throw new NativeStopFailure(503, "stop_workflow_disabled"); };
  const store = createNativeStopWorkflowStore(config.spoolRoot);
  const key = (attemptId: string, fence: number, kind: string) => {
    if (!observerId(attemptId) || !stopInteger(fence, 1, Number.MAX_SAFE_INTEGER)) throw new NativeStopFailure(400, "invalid_stop_identity");
    return `${attemptId}-${fence}.${kind}.json`;
  };
  async function packet(attemptId: string, fence: number) {
    enabled();
    const raw = await store.read(key(attemptId, fence, "packet"));
    if (!raw) throw new NativeStopFailure(409, "stop_packet_missing");
    const p = JSON.parse(raw) as Packet;
    identity(p.identity);
    if (p.schema !== "overdrafter.native-stop-workflow.v1" || p.identity.attemptId !== attemptId || p.identity.fence !== fence
      || p.profileId !== config.observer.profileId || p.observerUrl !== config.observer.url || p.stopOrigin !== config.stop.origin) {
      throw new NativeStopFailure(409, "stop_packet_scope_differs");
    }
    const manifest = Buffer.from(p.manifest, "base64"), journal = Buffer.from(p.journal, "base64");
    if (manifest.toString("base64") !== p.manifest || journal.toString("base64") !== p.journal
      || digest(manifest) !== p.manifestSha256 || digest(journal) !== p.journalSha256) throw new NativeStopFailure(409, "stop_packet_corrupt");
    validateEvidence(manifest, journal, p.identity);
    return { p, manifest, journal };
  }
  return {
    async stage(input: Readonly<{ identity: Identity; manifest: Uint8Array; journal: Uint8Array }>) {
      enabled(); identity(input.identity);
      // Copy before awaiting any disk operation; no caller mutable byte buffer survives.
      const manifest = Buffer.from(input.manifest), journal = Buffer.from(input.journal);
      validateEvidence(manifest, journal, input.identity);
      const p: Packet = { schema: "overdrafter.native-stop-workflow.v1", identity: { ...input.identity },
        profileId: config.observer.profileId, observerUrl: config.observer.url, stopOrigin: config.stop.origin,
        manifest: manifest.toString("base64"), journal: journal.toString("base64"), manifestSha256: digest(manifest), journalSha256: digest(journal) };
      await store.publish(key(p.identity.attemptId, p.identity.fence, "packet"), JSON.stringify(p));
      return { phase: "evidence_staged" as const, attemptId: p.identity.attemptId, fence: p.identity.fence };
    },
    async ingest(attemptId: string, fence: number) {
      const { p, manifest, journal } = await packet(attemptId, fence);
      const prior = await store.read(key(attemptId, fence, "evidence"));
      if (prior) {
        const evidence: unknown = JSON.parse(prior);
        if (!observerId(evidence)) throw new NativeStopFailure(409, "stop_evidence_corrupt");
        return { phase: "evidence_retained" as const, evidenceId: evidence, stopAdmitted: false as const };
      }
      const evidenceId = await createNativeObserverRepository(config.observer).ingest(manifest, journal);
      try { await store.publish(key(attemptId, fence, "evidence"), JSON.stringify(evidenceId)); }
      catch { throw new NativeStopFailure(503, "observer_outcome_unknown", true); }
      // p is retained in the immutable packet; ingestion never constructs stop authority.
      return { phase: "evidence_retained" as const, evidenceId, stopAdmitted: false as const, attemptId: p.identity.attemptId };
    },
    async submitStop(attemptId: string, fence: number) {
      const { p } = await packet(attemptId, fence);
      const stored = await store.read(key(attemptId, fence, "evidence"));
      const evidenceId: unknown = stored === null ? null : JSON.parse(stored);
      if (!observerId(evidenceId)) throw new NativeStopFailure(409, "stop_evidence_missing");
      const request: NativeStopRequest = { ...p.identity, evidenceId };
      await store.publish(key(attemptId, fence, "request"), JSON.stringify(request));
      const prior = await store.read(key(attemptId, fence, "receipt"));
      if (prior) return { phase: "stop_receipt_retained" as const, receipt: nativeStopReceipt(JSON.parse(prior), request), replayedLocally: true };
      const receipt = await createNativeStopClient(config.stop).submit(request);
      try { await store.publish(key(attemptId, fence, "receipt"), JSON.stringify(receipt)); }
      catch { throw new NativeStopFailure(503, "stop_outcome_unknown", true); }
      return { phase: "stop_receipt_retained" as const, receipt, replayedLocally: false };
    },
  };
}
