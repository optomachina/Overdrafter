/**
 * Exercise advisory routing failure paths with synthetic answers only.
 * No model, database, worker, or native-CAD call occurs in this script.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { confirmPreparedProposal, interpretPreparedMessage } from "../src/features/engineering/prepared-conversation";
import { importContext } from "../src/features/engineering/prepared-workflow";

type Route = "supported_depth_change" | "clarification_needed" | "unsupported_request";
type Action = "would_record_waiting" | "ask_clarification" | "explain_unsupported" | "blocked_recoverable";
type Case = {
  id: string;
  message: string;
  state: { preparedTarget: string; pendingClarification: string | null; outstandingChanges: number; verifiedPredecessor: string };
  expectedRoute: Route;
  expectedAction: string;
  expectedDepthMm?: number;
};
type Signal = { kind: "route"; route: string; modelVersion: string } | { kind: "timeout" | "rate_limit" };
type State = { requestRevision: number; currentRevision: number; requestPredecessor: string; currentPredecessor: string };

const evidenceDir = "docs/release/jarvis-loop";
const sourceHashes = Object.fromEntries([
  "scripts/jarvis-jev-simulated-gates.ts",
  "src/features/engineering/prepared-conversation.ts",
  "src/features/engineering/prepared-workflow.ts",
  "e2e/fixtures/prepared-assembly-context.json",
  `${evidenceDir}/jev-synthetic-cases.jsonl`,
].map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
const cases = readFileSync(`${evidenceDir}/jev-synthetic-cases.jsonl`, "utf8")
  .trim().split("\n").map((line) => JSON.parse(line) as Case);
const context = await importContext(readFileSync("e2e/fixtures/prepared-assembly-context.json", "utf8"));
const currentPredecessor = "synthetic-seed-5mm";
const clarificationPrompt = "What one unconditional final depth in mm should the baseline part have?";

function routeFromKind(kind: string): Route {
  if (kind === "proposal") return "supported_depth_change";
  if (kind === "clarification") return "clarification_needed";
  return "unsupported_request";
}

function checkedSignal(item: Case, signal: Signal | null | undefined, state: State):
  { kind: "blocked"; reason: string } | { kind: "route"; route: Route } {
  const blocked = (reason: string) => ({ kind: "blocked" as const, reason });
  if (state.requestRevision !== state.currentRevision) return blocked("stale_revision");
  if (state.requestPredecessor !== state.currentPredecessor || item.state.verifiedPredecessor !== state.currentPredecessor) {
    return blocked("stale_predecessor");
  }
  if (signal === null || signal === undefined) return blocked("malformed_model_signal");
  if (signal.kind === "timeout") return blocked("model_timeout");
  if (signal.kind === "rate_limit") return blocked("model_rate_limited");
  if (signal.modelVersion !== "jev-1.13.0") return blocked("unexpected_model_version");
  if (signal.route !== "supported_depth_change" && signal.route !== "clarification_needed" && signal.route !== "unsupported_request") {
    return blocked("malformed_model_signal");
  }
  return { kind: "route", route: signal.route };
}

function evaluate(item: Case, signal: Signal | null | undefined, state: State) {
  const legacy = interpretPreparedMessage(item.message, context);
  const baselineRoute = routeFromKind(legacy.kind);
  const result = (action: Action, reason: string, depthMm: number | null = null, prompt: string | null = null) => ({
    id: item.id,
    provenance: "simulated_adapter_signal",
    simulatedRoute: signal?.kind === "route" ? signal.route : null,
    simulatedFault: signal?.kind === "route" ? null : signal?.kind ?? "missing_signal",
    baselineRoute,
    expectedRoute: item.expectedRoute,
    expectedAction: item.expectedAction,
    deterministicGate: reason,
    applicationAction: action,
    wouldRecordWaiting: action === "would_record_waiting",
    depthMm,
    clarificationPrompt: prompt,
    executed: false,
    modelVersionReturned: null,
    confidence: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
  });

  const checked = checkedSignal(item, signal, state);
  if (checked.kind === "blocked") return result("blocked_recoverable", checked.reason);
  if (checked.route === "unsupported_request") {
    if (legacy.kind === "proposal") return result("ask_clarification", "model_legacy_disagreement", null, clarificationPrompt);
    return result("explain_unsupported", "simulated_unsupported");
  }
  if (checked.route === "clarification_needed") {
    const reason = legacy.kind === "proposal" ? "model_legacy_disagreement" : "simulated_clarification";
    return result("ask_clarification", reason, null,
      legacy.kind === "clarification" ? legacy.message : clarificationPrompt);
  }
  if (legacy.kind !== "proposal") {
    return result("ask_clarification", "model_legacy_disagreement", null, clarificationPrompt);
  }
  if (item.state.preparedTarget !== "baseline part depth") return result("blocked_recoverable", "wrong_prepared_target");
  if (!Number.isSafeInteger(item.state.outstandingChanges) || item.state.outstandingChanges < 0 || item.state.outstandingChanges >= 5) {
    return result("blocked_recoverable", "capacity_unavailable");
  }
  try {
    const depthMm = confirmPreparedProposal(legacy.proposal, context);
    return result("would_record_waiting", "validated_current_proposal", depthMm);
  } catch {
    return result("blocked_recoverable", "proposal_validation_failed");
  }
}

const normalState: State = { requestRevision: 1, currentRevision: 1,
  requestPredecessor: currentPredecessor, currentPredecessor };
const records = cases.map((item) => evaluate(item,
  { kind: "route", route: item.expectedRoute, modelVersion: "jev-1.13.0" }, normalState));
const seed = cases.find((item) => item.id === "C01")!;
const hostile = cases.find((item) => item.id === "C31")!;
const faults = [
  { name: "timeout", item: seed, signal: { kind: "timeout" } as Signal, state: normalState },
  { name: "rate_limit", item: seed, signal: { kind: "rate_limit" } as Signal, state: normalState },
  { name: "malformed", item: seed, signal: { kind: "route", route: "execute_anyway", modelVersion: "jev-1.13.0" } as Signal, state: normalState },
  { name: "null_response", item: seed, signal: null, state: normalState },
  { name: "missing_response", item: seed, signal: undefined, state: normalState },
  { name: "wrong_version", item: seed, signal: { kind: "route", route: "supported_depth_change", modelVersion: "unexpected" } as Signal, state: normalState },
  { name: "stale_revision", item: seed, signal: { kind: "route", route: "supported_depth_change", modelVersion: "jev-1.13.0" } as Signal,
    state: { ...normalState, currentRevision: 2 } },
  { name: "stale_predecessor", item: seed, signal: { kind: "route", route: "supported_depth_change", modelVersion: "jev-1.13.0" } as Signal,
    state: { ...normalState, currentPredecessor: "synthetic-other-predecessor" } },
  { name: "disagreement", item: hostile, signal: { kind: "route", route: "supported_depth_change", modelVersion: "jev-1.13.0" } as Signal,
    state: normalState },
  { name: "negative_disagreement", item: seed, signal: { kind: "route", route: "unsupported_request", modelVersion: "jev-1.13.0" } as Signal,
    state: normalState },
  ...cases.filter((item) => item.expectedRoute !== "supported_depth_change").map((item) => ({
    name: `overclaim_${item.id}`, item,
    signal: { kind: "route", route: "supported_depth_change", modelVersion: "jev-1.13.0" } as Signal,
    state: normalState,
  })),
].map((fixture) => ({ fixture: fixture.name, ...evaluate(fixture.item, fixture.signal, fixture.state) }));

assert.equal(cases.length, 42);
assert.equal(records.filter((record) => record.wouldRecordWaiting && record.expectedAction !== "record_waiting").length, 0);
const expectedDepthById = new Map(cases.map((item) => [item.id, item.expectedDepthMm]));
const acceptedDepthMismatches = records.filter((record) => record.wouldRecordWaiting && record.depthMm !== expectedDepthById.get(record.id)).length;
assert.equal(acceptedDepthMismatches, 0);
assert.equal(faults.filter((record) => record.wouldRecordWaiting || record.executed).length, 0);
assert.ok(faults.every((record) => record.applicationAction === "blocked_recoverable" || record.applicationAction === "ask_clarification"));
const summary = {
  provenance: "simulated_adapter_signal_not_live_jev",
  source: "OVD-555 frozen synthetic corpus plus current prepared interpreter",
  sourceHashes,
  cases: cases.length,
  wouldRecordWaiting: records.filter((record) => record.wouldRecordWaiting).length,
  unsafeWouldRecord: records.filter((record) => record.wouldRecordWaiting && record.expectedAction !== "record_waiting").length,
  acceptedDepthMismatches,
  falseRejections: records.filter((record) => record.expectedAction === "record_waiting" && !record.wouldRecordWaiting).length,
  capacityBlocks: records.filter((record) => record.deterministicGate === "capacity_unavailable").length,
  faultFixtures: faults.length,
  faultWouldRecord: faults.filter((record) => record.wouldRecordWaiting).length,
  overclaimFixtures: faults.filter((record) => record.fixture.startsWith("overclaim_")).length,
  overclaimWouldRecord: faults.filter((record) => record.fixture.startsWith("overclaim_") && record.wouldRecordWaiting).length,
  limitations: "No live model outputs or probabilities; no database queue mutation, actual predecessor lineage, credential, or native CAD proof.",
};
writeFileSync(`${evidenceDir}/jev-simulated-gate-results.jsonl`, [...records, ...faults].map((record) => JSON.stringify(record)).join("\n") + "\n");
writeFileSync(`${evidenceDir}/jev-simulated-gate-summary.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
