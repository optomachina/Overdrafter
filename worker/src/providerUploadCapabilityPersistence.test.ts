// @vitest-environment node

import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { claimNextTask } from "./queue.js";
import {
  recordProviderUploadCapabilityObservation,
  resolveProviderUploadCapabilityObservation,
} from "./providerUploadCapabilityPersistence.js";

const releaseEnvelope = {
  provider: "xometry",
  route: "quote_home",
  surface: "account_quote_modal",
  revision: "xometry-account-quote-modal.v1",
  extensions: ["step", "stp"],
  policyRevision: "xometry-controlled-beta-2026-08-17.v1",
  evidenceReference: "OVD-373",
};
const admissionResolver = {
  policy_present: true,
  provider_admitted: true,
  generically_dispatchable: false,
  provider: "xometry",
  admission_state: "controlled_beta_only",
  policy_revision: releaseEnvelope.policyRevision,
  evidence_reference: releaseEnvelope.evidenceReference,
  permission_basis: "existing_controlled_beta_path",
  supported_processes: ["cnc_milling"],
  accepted_file_extensions: ["step", "stp"],
  session_owner: "overdrafter_managed",
  reviewed_at: "2026-08-17T00:00:00.000Z",
  expires_at: null,
  reason_code: "controlled_beta_only",
};

function currentRow() {
  return {
    provider: "xometry",
    capability: "provider_upload",
    route: releaseEnvelope.route,
    surface: releaseEnvelope.surface,
    surface_revision: releaseEnvelope.revision,
    contract_version: "provider-upload-capability.v1",
    observation_state: "fresh",
    observed_extensions: ["step", "stp"],
    observed_mime_types: ["model/step"],
    accept_attribute_present: true,
    observed_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    freshness: "current",
    observation_revision: 7,
  };
}

function serviceClient(data: unknown, error: unknown = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data, error });
  const rpc = vi.fn().mockImplementation((name: string) => {
    if (name === "api_resolve_current_capability_observation") return { maybeSingle };
    return Promise.resolve({ data, error });
  });
  return { client: { rpc } as unknown as SupabaseClient, rpc, maybeSingle };
}

function recordInput() {
  return {
    provider: "xometry" as const,
    route: releaseEnvelope.route,
    surface: releaseEnvelope.surface,
    revision: releaseEnvelope.revision,
    state: "fresh" as const,
    extensions: [".STEP", "stp", "step"],
    mimeTypes: ["MODEL/STEP"],
    acceptAttributePresent: true,
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    actorKind: "worker" as const,
    sourceKind: "provider_surface" as const,
    sourceVersion: "worker.v1",
    evidenceReference: "issue:OVD-514",
    idempotencyKey: "ovd-514:observation-1",
    observationRevision: 7,
  };
}

describe("OVD-514 service RPC wrapper", () => {
  it("has no runtime path to provider adapters or dispatch modules", () => {
    for (const filename of ["providerUploadCapabilityPersistence.ts", "providerUploadCapability.ts"]) {
      const source = ts.createSourceFile(filename,
        readFileSync(fileURLToPath(new URL(filename, import.meta.url)), "utf8"),
        ts.ScriptTarget.Latest, true);
      const runtimeImports = source.statements
        .filter(ts.isImportDeclaration)
        .filter((declaration) => !declaration.importClause?.isTypeOnly)
        .map((declaration) => (declaration.moduleSpecifier as ts.StringLiteral).text);
      expect(runtimeImports).toEqual(filename === "providerUploadCapabilityPersistence.ts"
        ? ["./providerUploadCapability.js"] : []);
      const dynamicDependencies: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
             (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
          dynamicDependencies.push(node.getText(source));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(dynamicDependencies).toEqual([]);
    }
  });

  it("records only bounded normalized fields and accepts only the exact scoped revision", async () => {
    const { client, rpc } = serviceClient(7);
    const telemetry = vi.fn();
    await expect(recordProviderUploadCapabilityObservation(client, recordInput(), telemetry))
      .resolves.toEqual({ recorded: true, observationRevision: 7 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("api_record_capability_observation", {
      p_provider: "xometry",
      p_capability: "provider_upload",
      p_route: releaseEnvelope.route,
      p_surface: releaseEnvelope.surface,
      p_surface_revision: releaseEnvelope.revision,
      p_contract_version: "provider-upload-capability.v1",
      p_observation_state: "fresh",
      p_observed_extensions: ["step", "stp"],
      p_observed_mime_types: ["model/step"],
      p_accept_attribute_present: true,
      p_observed_at: expect.any(String),
      p_expires_at: expect.any(String),
      p_actor_kind: "worker",
      p_source_kind: "provider_surface",
      p_source_version: "worker.v1",
      p_evidence_reference: "issue:OVD-514",
      p_idempotency_key: "ovd-514:observation-1",
      p_observation_revision: 7,
    });
    expect(telemetry).toHaveBeenCalledWith({ reasonCode: "recorded", state: "fresh", revision: 7 });
    expect(JSON.stringify(telemetry.mock.calls)).not.toMatch(/idempotency|evidence|actor|source|route|surface/);
  });

  it.each([
    ["raw filename", { extensions: ["../secret.step"] }],
    ["unsafe MIME", { mimeTypes: ["model/step;name=secret"] }],
    ["unbounded formats", { extensions: Array.from({ length: 33 }, (_, i) => `e${i}`) }],
    ["nonfresh payload", { state: "loading", extensions: ["step"] }],
    ["missing accept", { acceptAttributePresent: null }],
    ["oversized TTL", { expiresAt: new Date(Date.now() + 27 * 60 * 60_000).toISOString() }],
    ["hash key", { idempotencyKey: "a".repeat(64) }],
  ] as const)("rejects %s before RPC", async (_name, patch) => {
    const { client, rpc } = serviceClient(7);
    const result = await recordProviderUploadCapabilityObservation(client, { ...recordInput(), ...patch } as never);
    expect(result).toEqual({ recorded: false, reasonCode: "record_invalid_input" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["database denial", 7, { message: "secret database details" }, "record_rpc_denied"],
    ["wrong revision", 8, null, "record_invalid_response"],
    ["private row shape", { id: 9 }, null, "record_invalid_response"],
  ] as const)("fails closed on %s", async (_name, data, error, reasonCode) => {
    const { client } = serviceClient(data, error);
    const telemetry = vi.fn();
    expect(await recordProviderUploadCapabilityObservation(client, recordInput(), telemetry))
      .toEqual({ recorded: false, reasonCode });
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain("secret");
  });

  it("fails closed on a thrown transport error without emitting exception details", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("secret transport URL"));
    const telemetry = vi.fn();
    expect(await recordProviderUploadCapabilityObservation({ rpc } as unknown as SupabaseClient, recordInput(), telemetry))
      .toEqual({ recorded: false, reasonCode: "record_transport_error" });
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain("secret");
  });

  it("passes a current sanitized row to the existing policy decision", async () => {
    const { client, rpc } = serviceClient(currentRow());
    const telemetry = vi.fn();
    const result = await resolveProviderUploadCapabilityObservation(client, releaseEnvelope, admissionResolver, telemetry);
    expect(result).toMatchObject({ reasonCode: "matches_policy", observationRevision: 7,
      decision: { classification: "matches_policy", allowedExtensions: ["step", "stp"] } });
    expect(rpc).toHaveBeenCalledWith("api_resolve_current_capability_observation", {
      p_provider: "xometry", p_capability: "provider_upload", p_route: releaseEnvelope.route,
      p_surface: releaseEnvelope.surface, p_surface_revision: releaseEnvelope.revision,
    });
    expect(telemetry).toHaveBeenCalledWith({ reasonCode: "matches_policy", state: "fresh", revision: 7 });
    expect(result.decision.evidenceRefs).toEqual([]);
  });

  it("keeps admission policy in child-1 when the resolver row is current", async () => {
    const { client } = serviceClient(currentRow());
    const result = await resolveProviderUploadCapabilityObservation(client, releaseEnvelope,
      { ...admissionResolver, policy_revision: "different" });
    expect(result.decision).toMatchObject({ classification: "route_or_selector_drift", allowedExtensions: [] });
  });

  it.each([
    ["missing", { freshness: "missing", observation_state: "missing", contract_version: null,
      observed_extensions: [], observed_mime_types: [], accept_attribute_present: null,
      observed_at: null, expires_at: null, observation_revision: null }, "resolver_missing"],
    ["expired", { freshness: "stale", observation_state: "stale", contract_version: null,
      observed_extensions: [], observed_mime_types: [], accept_attribute_present: null,
      observation_revision: null }, "resolver_stale"],
    ["malformed", { freshness: "malformed", observation_state: "ambiguous", contract_version: null,
      observed_extensions: [], observed_mime_types: [], accept_attribute_present: null,
      observation_revision: null }, "resolver_malformed"],
    ["different scope", { route: "different_route" }, "resolver_scope_mismatch"],
    ["contradictory flags", { freshness: "current", observation_state: "loading",
      observed_extensions: ["step"], accept_attribute_present: true }, "resolver_invalid_response"],
    ["ambiguous", { freshness: "ambiguous", observation_state: "ambiguous", contract_version: null,
      observed_extensions: [], observed_mime_types: [], accept_attribute_present: null,
      observation_revision: null }, "resolver_ambiguous"],
    ["raw extra field", { raw_evidence: "secret" }, "resolver_invalid_response"],
    ["expired current row", { expires_at: "2000-01-01T00:00:00.000Z" }, "resolver_stale"],
    ["wrong contract", { contract_version: "v2" }, "resolver_invalid_response"],
  ] as const)("queue-boundary %s gives no affirmative adapter input", async (_name, patch, reasonCode) => {
    const task = { id: "synthetic-task", status: "running", task_type: "run_vendor_quote", payload: {} };
    const maybeSingle = vi.fn().mockResolvedValueOnce({ data: task, error: null })
      .mockResolvedValueOnce({ data: { ...currentRow(), ...patch }, error: null });
    const rpc = vi.fn().mockReturnValue({ maybeSingle });
    const client = { rpc } as unknown as SupabaseClient;
    const telemetry = vi.fn();
    expect(await claimNextTask(client, "synthetic-worker")).toEqual(task);
    const result = await resolveProviderUploadCapabilityObservation(client, releaseEnvelope, admissionResolver, telemetry);
    expect(result.reasonCode).toBe(reasonCode);
    expect(result.decision.allowedExtensions).toEqual([]);
    expect(result.observationRevision).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "api_claim_next_task", "api_resolve_current_capability_observation",
    ]);
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain("secret");
  });

  it.each([
    ["RPC denial", { data: null, error: { message: "secret denial" } }, "resolver_rpc_denied"],
    ["empty response", { data: null, error: null }, "resolver_invalid_response"],
  ] as const)("fails closed for %s", async (_name, response, reasonCode) => {
    const maybeSingle = vi.fn().mockResolvedValue(response);
    const rpc = vi.fn().mockReturnValue({ maybeSingle });
    const telemetry = vi.fn();
    const result = await resolveProviderUploadCapabilityObservation({ rpc } as unknown as SupabaseClient,
      releaseEnvelope, admissionResolver, telemetry);
    expect(result.reasonCode).toBe(reasonCode);
    expect(result.decision.allowedExtensions).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("api_resolve_current_capability_observation");
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain("secret");
  });

  it("fails closed on transport exceptions and rejects malformed scope before RPC", async () => {
    const rpc = vi.fn().mockImplementation(() => ({ maybeSingle: () => Promise.reject(new Error("secret URL")) }));
    const client = { rpc } as unknown as SupabaseClient;
    expect((await resolveProviderUploadCapabilityObservation(client, releaseEnvelope, admissionResolver)).reasonCode)
      .toBe("resolver_transport_error");
    expect((await resolveProviderUploadCapabilityObservation(client,
      { ...releaseEnvelope, route: "../../secret" }, admissionResolver)).reasonCode)
      .toBe("resolver_invalid_scope");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("api_resolve_current_capability_observation");
  });
});
