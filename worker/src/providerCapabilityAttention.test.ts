// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  projectCapabilityAttention,
  type CapabilityAttentionEvidence,
  type CapabilityAttentionMetadata,
  type CapabilityAttentionResult,
} from "./providerCapabilityAttention.js";
import { decideProviderUploadCapability, REVIEWED_XOMETRY_MISSING_ACCEPT_IDENTITY } from "./providerUploadCapability.js";
import type { ProviderUploadCapabilityDecision } from "./providerUploadCapabilityTypes.js";

const metadata: CapabilityAttentionMetadata = {
  provider: "xometry", route: "quote_home", surface: "account_quote_modal",
  surfaceRevision: "surface.v1", policyRevision: "policy.v1", adapterRevision: "adapter.v1", workerBuild: null,
};
const clock = "2026-10-02T12:00:00.000Z";
const evidence: CapabilityAttentionEvidence = {
  decision: {
    contractVersion: "provider-upload-capability.v1", classification: "matches_policy",
    allowedExtensions: ["step", "stp"], reportedAddedExtensions: [], reportedRemovedExtensions: [],
    evidenceRefs: [], normalizedObservedMimeTypes: [],
  },
  observedAt: "2026-10-02T11:59:00.000Z", expiresAt: "2026-10-02T12:01:00.000Z", observationRevision: 1,
};
const input = { metadata, reviewedMetadata: [metadata], evidence, previous: null, now: clock };
function projected(result: CapabilityAttentionResult) {
  expect(result.state).toBe("projected");
  if (result.state !== "projected") throw new Error("Expected projection");
  return result;
}
function decision(classification: ProviderUploadCapabilityDecision["classification"], patch: Partial<ProviderUploadCapabilityDecision> = {}) {
  return { ...evidence, decision: { ...evidence.decision, classification, allowedExtensions: [], ...patch } };
}
const added = decision("format_added", { allowedExtensions: ["step", "stp"], reportedAddedExtensions: ["pdf"] });

function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

describe("offline capability attention projection", () => {
  it("starts healthy without emitting and leaves unsupported historical facts unknown", () => {
    const result = projected(projectCapabilityAttention(input));
    expect(result.intent).toBeNull();
    expect(result.cursor.generation).toBe(0);
    expect(result.item).toMatchObject({ severity: "healthy", freshness: "current", metadata,
      formatCounts: { allowed: 2, added: 0, removed: 0 }, occurrenceCount: null, firstSeenAt: null, lastChangedAt: null, action: null });
  });
  it.each([
    ["matches_policy", "healthy"], ["reviewed_missing_accept_xometry", "healthy"],
    ["format_added", "attention"], ["format_removed", "attention"],
    ["accept_missing", "blocked"], ["unsupported", "blocked"], ["denied", "blocked"],
    ["observation_missing", "unknown"], ["observation_stale", "unknown"],
    ["formats_loading", "blocked"], ["ambiguous_input", "blocked"], ["route_or_selector_drift", "blocked"],
    ["authentication_required", "blocked"], ["anti_bot_or_challenge", "blocked"],
    ["provider_error", "blocked"], ["unclassified_response", "blocked"],
  ] as const)("projects %s as %s without changing upload authorization", (classification, severity) => {
    const patch = classification === "format_added" ? { allowedExtensions: ["step"], reportedAddedExtensions: ["pdf"], reportedRemovedExtensions: ["stp"] }
      : classification === "format_removed" ? { allowedExtensions: ["step"], reportedRemovedExtensions: ["stp"] }
      : severity === "healthy" ? { allowedExtensions: ["step", "stp"] } : {};
    const current = decision(classification, patch);
    const before = structuredClone(current);
    const result = projected(projectCapabilityAttention({ ...input, evidence: current }));
    expect(result.item).toMatchObject({ severity, reasonCode: classification });
    expect(current).toEqual(before);
  });
  it("marks changed formats with no remaining permissible formats blocked", () => {
    expect(projected(projectCapabilityAttention({ ...input, evidence: decision("format_added", { reportedAddedExtensions: ["pdf"] }) })).item.severity).toBe("blocked");
  });
  it.each([null, {}, { ...evidence, decision: null }, { ...evidence, observedAt: "2026-02-30T11:59:00.000Z" },
    { ...evidence, observedAt: "2026-10-02T12:00:00.001Z" }, { ...evidence, expiresAt: evidence.observedAt },
    { ...evidence, expiresAt: "2026-10-04T12:00:00.000Z" }, { ...evidence, observationRevision: 1.5 },
    { ...evidence, decision: { ...evidence.decision, classification: "made_up" } },
    { ...evidence, decision: { ...evidence.decision, allowedExtensions: ["customer.step"] } },
    { ...evidence, decision: { ...evidence.decision, reportedAddedExtensions: ["step"] } },
    { ...evidence, decision: { ...evidence.decision, allowedExtensions: [] } },
    { ...evidence, decision: { ...evidence.decision, privateData: "secret" } },
  ])("never marks missing or malformed evidence healthy: %j", (current) => {
    const result = projected(projectCapabilityAttention({ ...input, evidence: current }));
    expect(result.item.severity).toBe("unknown");
    expect(result.item.formatCounts).toBeNull();
  });
  it.each([
    { evidenceRefs: null }, { evidenceRefs: {} }, { evidenceRefs: [123] },
    { evidenceRefs: ["https://private.example/account"] }, { evidenceRefs: Array(9).fill("issue:OVD-387") },
    { normalizedObservedMimeTypes: null }, { normalizedObservedMimeTypes: {} }, { normalizedObservedMimeTypes: [123] },
    { normalizedObservedMimeTypes: ["model/step;account=secret"] }, { normalizedObservedMimeTypes: Array(33).fill("model/step") },
    { normalizedObservedMimeTypes: [`model/${"x".repeat(256)}`] },
  ])("withholds healthy status for malformed or unbounded known arrays: %j", (patch) => {
    const result = projected(projectCapabilityAttention({ ...input, evidence: { ...evidence, decision: { ...evidence.decision, ...patch } } }));
    expect(result.item).toMatchObject({ severity: "unknown", reasonCode: "source_malformed" });
  });
  it("accepts valid bounded references and MIME while excluding them from output", () => {
    const result = projectCapabilityAttention({ ...input, evidence: { ...evidence, decision: {
      ...evidence.decision, evidenceRefs: ["issue:OVD-387"], normalizedObservedMimeTypes: ["model/step"],
    } } });
    expect(result).toEqual(projectCapabilityAttention(input));
  });
  it.each([
    { extensions: ["iges"], classification: "unsupported", allowed: [], severity: "blocked" },
    { extensions: ["step", "iges"], classification: "reviewed_missing_accept_xometry", allowed: ["step"], severity: "healthy" },
  ])("projects corrected shared fallback without duplicating policy: %j", ({ extensions, classification, allowed, severity }) => {
    const release = { ...REVIEWED_XOMETRY_MISSING_ACCEPT_IDENTITY, extensions, policyRevision: metadata.policyRevision, evidenceReference: "OVD-373" };
    const sharedDecision = decideProviderUploadCapability({
      releaseEnvelope: release,
      admissionResolver: {
        policy_present: true, provider_admitted: true, generically_dispatchable: false,
        provider: "xometry", admission_state: "controlled_beta_only", policy_revision: release.policyRevision,
        evidence_reference: release.evidenceReference, permission_basis: "existing_controlled_beta_path",
        supported_processes: ["cnc_milling"], accepted_file_extensions: extensions, session_owner: "overdrafter_managed",
        reviewed_at: "2026-08-17T00:00:00.000Z", expires_at: null, reason_code: "controlled_beta_only",
      },
      observed: { ...REVIEWED_XOMETRY_MISSING_ACCEPT_IDENTITY, state: "fresh", acceptAttributePresent: false },
      nowMs: Date.parse(input.now),
    });
    expect(sharedDecision).toMatchObject({ classification, allowedExtensions: allowed });
    const context = { ...metadata, surfaceRevision: release.revision };
    const result = projected(projectCapabilityAttention({ ...input, metadata: context, reviewedMetadata: [context], evidence: { ...evidence, decision: sharedDecision } }));
    expect(result.item).toMatchObject({ severity, reasonCode: classification, formatCounts: { allowed: allowed.length } });
  });
  it("becomes stale exactly at expiry, with one transition without a new observation", () => {
    const fresh = projected(projectCapabilityAttention(input));
    const staleInput = { ...input, previous: fresh.cursor, now: evidence.expiresAt };
    const stale = projected(projectCapabilityAttention(staleInput));
    expect(stale.item).toMatchObject({ severity: "unknown", freshness: "stale", reasonCode: "observation_stale" });
    expect(stale.intent).toMatchObject({ kind: "attention", generation: 1 });
    expect(projected(projectCapabilityAttention({ ...staleInput, previous: stale.cursor, now: "2026-10-02T12:02:00.000Z" })).intent).toBeNull();
  });
  it("is fresh one millisecond before expiry", () => {
    expect(projected(projectCapabilityAttention({ ...input, now: "2026-10-02T12:00:59.999Z" })).item.severity).toBe("healthy");
  });
  it("deduplicates semantically identical canonical formats across newer observations", () => {
    const first = projected(projectCapabilityAttention({ ...input, evidence: added }));
    const second = projected(projectCapabilityAttention({ ...input, previous: first.cursor,
      evidence: { ...added, observationRevision: 2, observedAt: "2026-10-02T11:59:30.000Z",
        decision: { ...added.decision, allowedExtensions: ["STP", ".STEP", "step"], diagnostic: "changed diagnostic" } } }));
    expect(second.intent).toBeNull();
    expect(second.item.key).toBe(first.item.key);
    expect(second.cursor.lastObservationRevision).toBe(2);
    expect(second.item.formatCounts).toEqual(first.item.formatCounts);
  });
  it("emits semantic change, recovery and a distinct recurrence", () => {
    const first = projected(projectCapabilityAttention(input));
    const fail = projected(projectCapabilityAttention({ ...input, previous: first.cursor, evidence: { ...added, observationRevision: 2 } }));
    const recovery = projected(projectCapabilityAttention({ ...input, previous: fail.cursor, evidence: { ...evidence, observationRevision: 3 } }));
    const again = projected(projectCapabilityAttention({ ...input, previous: recovery.cursor, evidence: { ...added, observationRevision: 4 } }));
    expect([fail.intent?.kind, recovery.intent?.kind, again.intent?.kind]).toEqual(["attention", "recovery", "attention"]);
    expect([fail.cursor.generation, recovery.cursor.generation, again.cursor.generation]).toEqual([1, 2, 3]);
    expect(again.intent?.key).not.toBe(fail.intent?.key);
  });
  it("notices changed added formats even with the same classification", () => {
    const first = projected(projectCapabilityAttention({ ...input, evidence: added }));
    const next = projected(projectCapabilityAttention({ ...input, previous: first.cursor,
      evidence: { ...added, observationRevision: 2, decision: { ...added.decision, reportedAddedExtensions: ["iges"] } } }));
    expect(next.intent?.generation).toBe(2);
  });
  it("requires exact reviewed metadata, not just syntactically valid strings", () => {
    expect(projectCapabilityAttention({ ...input, metadata: { ...metadata, adapterRevision: "unreviewed.v2" } }))
      .toEqual({ state: "rejected", reasonCode: "invalid_context" });
    expect(projectCapabilityAttention({ ...input, reviewedMetadata: [] }).state).toBe("rejected");
  });
  it("isolates provider, route, surface and version cursor scopes", () => {
    const previous = projected(projectCapabilityAttention(input)).cursor;
    for (const change of [{ provider: "fictiv" }, { route: "another_route" }, { surface: "other_surface" }, { surfaceRevision: "surface.v2" }, { policyRevision: "policy.v2" }, { workerBuild: "build.v2" }]) {
      const context = { ...metadata, ...change };
      expect(projectCapabilityAttention({ ...input, metadata: context, reviewedMetadata: [context], previous }))
        .toEqual({ state: "rejected", reasonCode: "invalid_cursor" });
    }
  });
  it("does not recognize reviewed Xometry fallback for another provider", () => {
    const context = { ...metadata, provider: "fictiv" };
    expect(projected(projectCapabilityAttention({ ...input, metadata: context, reviewedMetadata: [context],
      evidence: decision("reviewed_missing_accept_xometry", { allowedExtensions: ["step"] }) })).item.severity).toBe("unknown");
  });
  it("rejects older revisions, older observation times and conflicting same revision", () => {
    const previous = projected(projectCapabilityAttention({ ...input, evidence: { ...evidence, observationRevision: 2 } })).cursor;
    for (const current of [evidence, { ...evidence, observationRevision: 3, observedAt: "2026-10-02T11:58:00.000Z" }, { ...added, observationRevision: 2 }]) {
      expect(projectCapabilityAttention({ ...input, previous, evidence: current }))
        .toEqual({ state: "rejected", reasonCode: "observation_replay" });
    }
  });
  it("retains replay watermarks through missing evidence", () => {
    const first = projected(projectCapabilityAttention({ ...input, evidence: { ...evidence, observationRevision: 2 } }));
    const missing = projected(projectCapabilityAttention({ ...input, previous: first.cursor, evidence: null }));
    expect(missing.cursor.lastObservationRevision).toBe(2);
    expect(projectCapabilityAttention({ ...input, previous: missing.cursor })).toEqual({ state: "rejected", reasonCode: "observation_replay" });
  });
  it("rejects malformed cursor, backwards clock and exhausted generation", () => {
    const previous = projected(projectCapabilityAttention(input)).cursor;
    for (const change of [{ generation: -1 }, { generation: 0.1 }, { fingerprint: "secret" }, { lastObservedAt: null }]) {
      expect(projectCapabilityAttention({ ...input, previous: { ...previous, ...change } }))
        .toEqual({ state: "rejected", reasonCode: "invalid_cursor" });
    }
    expect(projectCapabilityAttention({ ...input, previous, now: "2026-10-02T11:59:59.000Z" }).state).toBe("rejected");
    expect(projectCapabilityAttention({ ...input, evidence: { ...added, observationRevision: 2 }, previous: { ...previous, generation: 1_000_000 } }))
      .toEqual({ state: "rejected", reasonCode: "generation_exhausted" });
  });
  it("returns identical intents for concurrent calls, without claiming durable delivery", () => {
    const first = projectCapabilityAttention({ ...input, evidence: added });
    expect(projectCapabilityAttention({ ...input, evidence: added })).toEqual(first);
  });
  it("does not forward diagnostic, evidence, secret or customer data", () => {
    const privateText = "Bearer private-secret user@example.test customer.step <html>private</html> stack at file:///secret";
    const result = projected(projectCapabilityAttention({ ...input, evidence: { ...added,
      decision: { ...added.decision, reason: privateText, diagnostic: privateText.repeat(1000), evidenceRefs: ["issue:OVD-387"] } } }));
    expect(result).toEqual(projectCapabilityAttention({ ...input, evidence: added }));
    expect(JSON.stringify(result)).not.toMatch(/private-secret|example.test|customer.step|<html>|file:\/\/\/secret/);
    expect(JSON.stringify(result).length).toBeLessThan(2000);
  });
  it("rejects malicious metadata and accessor records without executing accessors", () => {
    const malicious = { ...metadata, workerBuild: "https://secret.example/account" };
    expect(projectCapabilityAttention({ ...input, metadata: malicious, reviewedMetadata: [malicious] }).state).toBe("rejected");
    const current = { ...evidence };
    Object.defineProperty(current, "decision", { enumerable: true, get() { throw new Error("must not execute"); } });
    expect(projected(projectCapabilityAttention({ ...input, evidence: current })).item.severity).toBe("unknown");
  });
  it("does not mutate frozen fixtures", () => {
    const fixture = structuredClone({ ...input, evidence: added });
    const before = JSON.stringify(fixture);
    freeze(fixture);
    expect(projectCapabilityAttention(fixture).state).toBe("projected");
    expect(JSON.stringify(fixture)).toBe(before);
  });
  it.each(["invalid", "2026-02-30T12:00:00.000Z", "2026-10-02T12:00:00Z"])("rejects malformed injected clock %s", (now) => {
    expect(projectCapabilityAttention({ ...input, now })).toEqual({ state: "rejected", reasonCode: "invalid_clock" });
  });
});
