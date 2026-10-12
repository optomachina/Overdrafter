// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import {
  CANARY_PLANNING_POLICY, prepareCapabilityCanaryObservation, prepareCapabilityCanaryPlan,
  type CanaryObservationInput, type CanaryPlanInput, type CanaryReviewedEnvelope,
} from "./providerCapabilityCanary.js";
import { decideProviderUploadCapability, REVIEWED_XOMETRY_MISSING_ACCEPT_IDENTITY } from "./providerUploadCapability.js";
import type { ProviderUploadCapabilityAdmissionResolverResult } from "./providerUploadCapabilityTypes.js";

const envelope: CanaryReviewedEnvelope = {
  ...REVIEWED_XOMETRY_MISSING_ACCEPT_IDENTITY, provider: "xometry", extensions: ["step", "stp"],
  policyRevision: "xometry-controlled-beta-2026-08-17.v1", evidenceReference: "OVD-373",
};
const scope = { provider: envelope.provider, route: envelope.route, surface: envelope.surface, revision: envelope.revision };
const config: CanaryPlanInput = { enabled: false, scope, probeMode: "capability_inspection_no_upload",
  startAt: "2026-10-02T00:00:00.000Z", intervalSeconds: 3600, windowCount: 24, timeoutSeconds: 60 };
const admission: ProviderUploadCapabilityAdmissionResolverResult = {
  policy_present: true, provider_admitted: true, generically_dispatchable: false,
  provider: "xometry", admission_state: "controlled_beta_only", policy_revision: envelope.policyRevision,
  evidence_reference: envelope.evidenceReference, permission_basis: "existing_controlled_beta_path",
  supported_processes: ["cnc_milling"], accepted_file_extensions: ["step", "stp"],
  session_owner: "overdrafter_managed", reviewed_at: "2026-08-17T00:00:00.000Z", expires_at: null,
  reason_code: "controlled_beta_only",
};
const observation: CanaryObservationInput = { ...scope, windowIndex: 0, state: "fresh", extensions: [".STEP", "stp", "step"],
  mimeTypes: ["MODEL/STEP"], acceptAttributePresent: true, observedAt: "2026-10-02T00:01:00.000Z",
  expiresAt: "2026-10-02T01:01:00.000Z", observationRevision: 1 };
const now = Date.parse("2026-10-02T00:02:00.000Z");
const project = (input: unknown = observation, resolver = admission) =>
  prepareCapabilityCanaryObservation(config, [envelope], input, resolver, now);

describe("disabled capability canary planning", () => {
  it.each([undefined, {}, { enabled: false }])("defaults %j to disabled without evidence or clock access", (input) => {
    expect(prepareCapabilityCanaryPlan(input, [])).toEqual({ state: "disabled" });
    expect(prepareCapabilityCanaryObservation(input, [], null, null as never, NaN)).toEqual({ state: "disabled" });
  });

  it.each([
    null, [], true, { enabled: true }, { ...config, enabled: true }, { ...config, enabled: "false" },
    { ...config, probeMode: "quote" }, { ...config, scope: { ...scope, provider: "*" } },
    { ...config, scope: { ...scope, url: "https://provider.invalid" } },
    { ...config, startAt: "2026-02-30T00:00:00.000Z" }, { ...config, startAt: "2026-10-02" },
    { ...config, startAt: "9999-12-31T23:59:59.000Z" },
    ...[0, -1, 3599, 86401, Infinity, NaN, 3600.5, "3600"].map((intervalSeconds) => ({ ...config, intervalSeconds })),
    ...[0, -1, 25, 1.5, Infinity].map((windowCount) => ({ ...config, windowCount })),
    ...[0, -1, 61, 1.5, NaN, "60"].map((timeoutSeconds) => ({ ...config, timeoutSeconds })),
    { ...config, intervalSeconds: 86400, windowCount: 2 },
    ...["taskCount", "parallelism", "taskRetries", "schedulerRetries", "cpu", "memoryMiB", "secret", "command"]
      .map((key) => ({ ...config, [key]: 99 })),
  ])("refuses malformed or enabled planning config %j", (input) => {
    expect(prepareCapabilityCanaryPlan(input, [envelope])).toEqual({ state: "invalid_configuration" });
  });

  it("rejects accessors without invoking them", () => {
    const getter = vi.fn(() => false);
    const input = Object.defineProperty({ ...config }, "enabled", { get: getter });
    expect(prepareCapabilityCanaryPlan(input, [envelope])).toEqual({ state: "invalid_configuration" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects a slug outside the provider enum even when caller supplies matching review data", () => {
    const unknownScope = { ...scope, provider: "synthetic-provider" };
    expect(prepareCapabilityCanaryPlan({ ...config, scope: unknownScope },
      [{ ...envelope, ...unknownScope } as CanaryReviewedEnvelope])).toEqual({ state: "invalid_configuration" });
  });

  it.each([[], [envelope, envelope], [{ ...envelope, revision: "other" }], [{ ...envelope, unknown: "secret" }],
    [{ ...envelope, extensions: ["../step"] }], [{ ...envelope, evidenceReference: "https://secret.invalid" }]])(
    "requires exactly one valid reviewed identity: %j", (reviewed) => {
      expect(prepareCapabilityCanaryPlan(config, reviewed as CanaryReviewedEnvelope[])).toEqual({ state: "invalid_configuration" });
    },
  );

  it("returns finite inert resources and stable scope/window-bound keys", () => {
    const result = prepareCapabilityCanaryPlan(config, [envelope]);
    expect(result.state).toBe("prepared_plan");
    if (result.state !== "prepared_plan") throw Error("missing plan");
    expect(result.plan).toMatchObject({ policyRevision: CANARY_PLANNING_POLICY, enabled: false,
      taskCount: 1, parallelism: 1, taskRetries: 0, schedulerRetries: 0, maxObservationsPerWindow: 1,
      timeoutSeconds: 60, cpu: 1, memoryMiB: 512, endAt: "2026-10-03T00:00:00.000Z" });
    expect(result.plan.windows).toHaveLength(24);
    expect(new Set(result.plan.windows.map((window) => window.idempotencyKey)).size).toBe(24);
    expect(result.plan.windows[0].idempotencyKey).toMatch(/^canary:[a-f0-9]{64}$/);
    expect(prepareCapabilityCanaryPlan(config, [envelope])).toEqual(result);
    for (const key of ["provider", "route", "surface", "revision"] as const) {
      const changed = { ...scope, [key]: key === "provider" ? "quickparts" : "different" };
      const alternative = prepareCapabilityCanaryPlan({ ...config, scope: changed }, [{ ...envelope, ...changed }]);
      expect(alternative.state).toBe("prepared_plan");
      if (alternative.state === "prepared_plan") expect(alternative.plan.windows[0].idempotencyKey).not.toBe(result.plan.windows[0].idempotencyKey);
    }
    // Returning a plan neither aliases reviewed evidence nor changes future preparation.
    result.plan.releaseEnvelope.extensions.push("pdf");
    expect(envelope.extensions).toEqual(["step", "stp"]);
    expect(prepareCapabilityCanaryPlan({ enabled: false }, [envelope])).toEqual({ state: "disabled" });
  });
});

describe("pure sanitized observation projection", () => {
  it("builds only a typed ledger candidate and delegates classification without ambient time", () => {
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw Error("ambient clock forbidden"); });
    try {
      const result = project();
      expect(result.state).toBe("prepared_observation");
      if (result.state !== "prepared_observation") throw Error("missing candidate");
      expect(result.candidate).toEqual({ ...observation, windowIndex: undefined, extensions: ["step", "stp"], mimeTypes: ["model/step"],
        actorKind: "scheduled_canary", sourceKind: "scheduled_canary", sourceVersion: CANARY_PLANNING_POLICY,
        evidenceReference: "issue:OVD-415", idempotencyKey: expect.stringMatching(/^canary:[a-f0-9]{64}$/) });
      expect(Object.hasOwn(result.candidate, "windowIndex")).toBe(false);
      expect(result.decision).toEqual(decideProviderUploadCapability({ releaseEnvelope: envelope, admissionResolver: admission, nowMs: now,
        observed: { ...scope, state: "fresh", extensions: ["step", "stp"], mimeTypes: ["model/step"],
          acceptAttributePresent: true, evidenceRefs: ["issue:OVD-415"] } }));
      expect(clock).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it.each([
    ["2026-10-02T00:02:00.001Z", "matches_policy"],
    ["2026-10-02T00:02:00.000Z", "observation_stale"],
    ["2000-01-01T00:00:00.000Z", "observation_stale"],
    ["not-a-date", "denied"],
  ] as const)("evaluates admission expiry %s against explicit time without rewriting evidence", (expiry, classification) => {
    const resolver = { ...admission, expires_at: expiry };
    const before = structuredClone(resolver);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw Error("ambient clock forbidden"); });
    try {
      expect(project(observation, resolver)).toMatchObject({ state: "prepared_observation", decision: { classification,
        allowedExtensions: classification === "matches_policy" ? ["step", "stp"] : [] } });
      expect(clock).not.toHaveBeenCalled();
      expect(resolver).toEqual(before);
    } finally { clock.mockRestore(); }
  });

  it("blocks future admission review using explicit time even without expiry", () => {
    const resolver = { ...admission, reviewed_at: "2026-10-02T00:02:00.001Z" };
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw Error("ambient clock forbidden"); });
    try {
      expect(project(observation, resolver)).toMatchObject({ state: "prepared_observation",
        decision: { classification: "denied", allowedExtensions: [] } });
      expect(resolver.reviewed_at).toBe("2026-10-02T00:02:00.001Z");
      expect(clock).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it.each([NaN, Infinity, -Infinity, now + 0.5, 8640000000000001, -8640000000000001])(
    "refuses invalid explicit observation clock %s", (clock) => {
      expect(prepareCapabilityCanaryObservation(config, [envelope], observation, admission, clock))
        .toEqual({ state: "invalid_observation" });
    },
  );

  it("keeps reviewed Xometry missing accept distinct from a generic missing accept", () => {
    const missing = { ...observation, acceptAttributePresent: false, extensions: ["step", "stp"] };
    expect(project(missing)).toMatchObject({ state: "prepared_observation", decision: { classification: "reviewed_missing_accept_xometry" } });
    expect(project({ ...missing, extensions: ["step"] })).toMatchObject({ state: "prepared_observation", decision: { classification: "format_removed" } });
    const generic = { ...envelope, route: "other-reviewed-route" };
    expect(prepareCapabilityCanaryObservation({ ...config, scope: { ...scope, route: generic.route } }, [generic],
      { ...missing, route: generic.route }, admission, now)).toMatchObject({ state: "prepared_observation", decision: { classification: "accept_missing", allowedExtensions: [] } });
    expect(project(observation, { ...admission, provider_admitted: false })).toMatchObject({ state: "prepared_observation", decision: { classification: "denied", allowedExtensions: [] } });
  });

  it.each([
    { rawHtml: "secret" }, { error: "private" }, { url: "https://private.invalid" }, { token: "credential" },
    { provider: "quickparts" }, { route: "other" }, { surface: "other" }, { revision: "other" },
    { windowIndex: -1 }, { windowIndex: 24 }, { windowIndex: 0.5 },
    { state: "missing" }, { state: "stale" }, { state: "not_a_state" }, { acceptAttributePresent: null },
    { extensions: Array(33).fill("step") }, { mimeTypes: ["text/html;secret=value"] },
    { extensions: ["../secret"] }, { extensions: ["a".repeat(33)] }, { mimeTypes: [`model/${"a".repeat(128)}`] },
    { extensions: ["https://private.invalid"] }, { mimeTypes: ["user@example.invalid"] },
    { observedAt: "2026-10-02T00:03:00.000Z" }, { observedAt: "2026-10-01T23:59:00.000Z" },
    { expiresAt: "2026-10-02T00:02:00.000Z" }, { expiresAt: "2026-10-02T01:01:00.001Z" },
    { observedAt: "2026-02-30T00:00:00.000Z" }, { observationRevision: 0 }, { observationRevision: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects unsanitized or unbound observation %j", (change) => {
    expect(project({ ...observation, ...change })).toEqual({ state: "invalid_observation" });
  });

  it.each(["loading", "route_or_selector_drift", "authentication_required", "anti_bot_or_challenge", "provider_error", "unclassified_response", "ambiguous"] as const)(
    "preserves finite observed state %s without invented formats", (state) => {
      expect(project({ ...observation, state, extensions: [], mimeTypes: [], acceptAttributePresent: null }))
        .toMatchObject({ state: "prepared_observation", candidate: { state, extensions: [], mimeTypes: [], acceptAttributePresent: null } });
      expect(project({ ...observation, state })).toEqual({ state: "invalid_observation" });
    },
  );

  it("rejects invalid clocks, closed-window mismatch and accessor evidence", () => {
    expect(prepareCapabilityCanaryObservation(config, [envelope], observation, admission, NaN)).toEqual({ state: "invalid_observation" });
    const next = { ...observation, observedAt: "2026-10-02T01:00:00.000Z", expiresAt: "2026-10-02T02:00:00.000Z" };
    expect(prepareCapabilityCanaryObservation(config, [envelope], next, admission, Date.parse(next.observedAt))).toEqual({ state: "invalid_observation" });
    const getter = vi.fn(() => ["step"]);
    expect(project(Object.defineProperty({ ...observation }, "extensions", { get: getter }))).toEqual({ state: "invalid_observation" });
    expect(getter).not.toHaveBeenCalled();
  });
});

it("has only pure runtime dependencies and no execution capability", () => {
  const source = fs.readFileSync(new URL("./providerCapabilityCanary.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("canary.ts", source, ts.ScriptTarget.Latest, true);
  const imports = file.statements.filter(ts.isImportDeclaration).filter((entry) => !entry.importClause?.isTypeOnly)
    .map((entry) => (entry.moduleSpecifier as ts.StringLiteral).text);
  expect(imports).toEqual(["node:crypto", "./providerUploadCapability.js"]);
  const calls: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  const forbidden = new Set(["fetch", "setTimeout", "setInterval", "require", "import", "eval", "Date.now"]);
  expect(calls.filter((call) => forbidden.has(call) || forbidden.has(call.replace(/^globalThis\./, "")))).toEqual([]);
  const shared = fs.readFileSync(new URL("./providerUploadCapability.ts", import.meta.url), "utf8");
  const sharedFile = ts.createSourceFile("capability.ts", shared, ts.ScriptTarget.Latest, true);
  expect(sharedFile.statements.filter(ts.isImportDeclaration).every((entry) => entry.importClause?.isTypeOnly)).toBe(true);
});
