// @vitest-environment node

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../test-fixtures/provider-dispatch-envelope/v1.json";
import { parseXometryBetaDispatchScope } from "../../src/features/quotes/xometry-beta-dispatch";
import {
  canonicalizeProviderDispatchEnvelope,
  compareProviderDispatchEnvelopes,
  evaluateProviderDispatchAdmission,
  fingerprintProviderDispatchEnvelope,
  formatProviderEnvelopeRevision,
  isRetryableProviderDispatchDenial,
  LEGACY_XOMETRY_AUTHORIZATION_KEY_MAP,
  LEGACY_XOMETRY_PERMIT_COLUMN_MAP,
  LEGACY_XOMETRY_SCOPE_PREVIEW_KEY_MAP,
  LEGACY_XOMETRY_TASK_PAYLOAD_KEY_MAP,
  liftLegacyXometryPermit,
  negotiateProviderDispatchEnvelopeSchema,
  parseProviderDispatchEnvelope,
  parseProviderEnvelopeRevision,
  PROVIDER_DISPATCH_DENIAL_CODES,
  type ProviderDispatchCurrentEvidence,
  type ProviderDispatchEnvelope,
  projectLegacyXometryBinding,
} from "./providerDispatchEnvelope";
import type { VendorQuoteAdapterInput } from "./types";
import { quoteWithDispatchPreflight, XOMETRY_ENVELOPE_REVISION } from "./xometryDispatchPreflight";

type Json = unknown;
const UNSET = Symbol("unset");

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Sets a dotted path (numeric segments index arrays); UNSET deletes the key. */
function setPath(target: Record<string, Json>, path: string, value: Json | typeof UNSET): void {
  const segments = path.split(".");
  let cursor = target as Record<string, Json>;
  for (const segment of segments.slice(0, -1)) {
    cursor = cursor[segment] as Record<string, Json>;
  }
  const last = segments[segments.length - 1];
  if (value === UNSET) {
    delete cursor[last];
  } else {
    cursor[last] = value;
  }
}

function getPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((cursor, segment) => (cursor as Record<string, unknown>)[segment], source);
}

function mutate<T>(base: T, set: Record<string, Json> = {}, unset: string[] = []): T {
  const copy = clone(base) as Record<string, Json>;
  for (const [path, value] of Object.entries(set)) setPath(copy, path, value);
  for (const path of unset) setPath(copy, path, UNSET);
  return copy as T;
}

const golden = fixture.golden.envelope as unknown as ProviderDispatchEnvelope;
const admittedEvidence = fixture.admittedEvidence as unknown as ProviderDispatchCurrentEvidence;

/** Resolves a neutral mapping path; `envelope` is the legacy `${id}.v${version}` text. */
function neutralValue(envelope: ProviderDispatchEnvelope, path: string): unknown {
  return path === "envelope" ? formatProviderEnvelopeRevision(envelope.envelope) : getPath(envelope, path);
}

describe("provider dispatch envelope canonicalization", () => {
  it("reproduces the shared golden canonical text and PostgreSQL-compatible fingerprint", () => {
    expect(canonicalizeProviderDispatchEnvelope(golden)).toBe(fixture.golden.canonical);
    expect(fingerprintProviderDispatchEnvelope(golden)).toBe(fixture.golden.fingerprint);
    expect(createHash("sha256").update(fixture.golden.canonical, "utf8").digest("hex")).toBe(
      fixture.golden.fingerprint,
    );
  });

  it("is independent of input key order and file order", () => {
    const reordered = Object.fromEntries(Object.entries(clone(golden)).reverse()) as ProviderDispatchEnvelope;
    reordered.sourceFiles.reverse();
    reordered.outboundFiles.reverse();
    reordered.subject = Object.fromEntries(
      Object.entries(reordered.subject).reverse(),
    ) as ProviderDispatchEnvelope["subject"];
    expect(canonicalizeProviderDispatchEnvelope(reordered)).toBe(fixture.golden.canonical);
    expect(fingerprintProviderDispatchEnvelope(reordered)).toBe(fixture.golden.fingerprint);
  });

  it("orders keys like jsonb (length, then bytes) and versions the canonical form", () => {
    const canonical = fixture.golden.canonical;
    expect(canonical.startsWith('{"task": ')).toBe(true);
    expect(canonical).toContain('"schema": "provider-dispatch-envelope.v1"');
    expect(canonical.indexOf('"scope"')).toBeLessThan(canonical.indexOf('"permit"'));
  });

  it("refuses to canonicalize an invalid envelope", () => {
    expect(() => canonicalizeProviderDispatchEnvelope(mutate(golden, { purpose: "order" }))).toThrow(
      /envelope_malformed/,
    );
  });
});

describe("provider dispatch envelope strict parsing", () => {
  it("accepts the golden envelope", () => {
    expect(parseProviderDispatchEnvelope(golden)).toEqual({ ok: true, envelope: golden });
  });

  it.each(fixture.malformed)("$name fails closed as $denial", (entry) => {
    const candidate = mutate(golden, (entry as { set?: Record<string, Json> }).set, (entry as { unset?: string[] }).unset);
    expect(parseProviderDispatchEnvelope(candidate)).toEqual({ ok: false, denial: entry.denial });
  });

  it.each([null, undefined, "envelope", 1, [], [golden]])("rejects non-object input %#", (value) => {
    expect(parseProviderDispatchEnvelope(value)).toEqual({ ok: false, denial: "envelope_malformed" });
  });

  it("negotiates only the supported schema version", () => {
    expect(negotiateProviderDispatchEnvelopeSchema(["provider-dispatch-envelope.v2", "provider-dispatch-envelope.v1"])).toEqual({
      ok: true,
      schema: "provider-dispatch-envelope.v1",
    });
    for (const offered of [[], ["provider-dispatch-envelope.v2"], "provider-dispatch-envelope.v1", [1], null]) {
      expect(negotiateProviderDispatchEnvelopeSchema(offered)).toEqual({
        ok: false,
        denial: "envelope_version_unsupported",
      });
    }
  });

  it("round-trips the legacy envelope revision text exactly", () => {
    expect(parseProviderEnvelopeRevision(XOMETRY_ENVELOPE_REVISION)).toEqual(golden.envelope);
    expect(formatProviderEnvelopeRevision(golden.envelope)).toBe(XOMETRY_ENVELOPE_REVISION);
    for (const value of ["xometry-controlled-beta-envelope", "xometry.v0", "Xometry-envelope.v1", 1]) {
      expect(parseProviderEnvelopeRevision(value)).toBeNull();
    }
  });
});

describe("provider dispatch envelope read-once plain data", () => {
  it("rejects accessors so a getter cannot pass validation and then change", () => {
    let reads = 0;
    const scope = { ...golden.scope } as Record<string, unknown>;
    Object.defineProperty(scope, "declaredModelUnits", {
      enumerable: true,
      get: () => (reads++ === 0 ? "inch" : "furlong"),
    });
    expect(parseProviderDispatchEnvelope({ ...golden, scope })).toEqual({ ok: false, denial: "envelope_malformed" });
    expect(reads).toBe(0);
  });

  it("rejects class instances, array subclasses, and symbol keys", () => {
    class EnvelopeLike {
      constructor() {
        Object.assign(this, clone(golden));
      }
    }
    expect(parseProviderDispatchEnvelope(new EnvelopeLike())).toEqual({ ok: false, denial: "envelope_malformed" });
    class FileList extends Array<unknown> {}
    const files = FileList.from(clone(golden.sourceFiles));
    expect(parseProviderDispatchEnvelope({ ...clone(golden), sourceFiles: files })).toEqual({
      ok: false,
      denial: "envelope_malformed",
    });
    expect(parseProviderDispatchEnvelope({ ...clone(golden), [Symbol("grant")]: true })).toEqual({
      ok: false,
      denial: "envelope_malformed",
    });
  });

  it("accepts null-prototype plain data", () => {
    const bare = Object.assign(Object.create(null), clone(golden));
    expect(parseProviderDispatchEnvelope(bare)).toEqual({ ok: true, envelope: golden });
  });

  it("rejects accessor-backed evidence before reading it", () => {
    let reads = 0;
    const evidence = { ...clone(admittedEvidence) } as Record<string, unknown>;
    Object.defineProperty(evidence, "permitState", { enumerable: true, get: () => (reads++ === 0 ? "active" : "revoked") });
    expect(
      evaluateProviderDispatchAdmission({
        expected: golden,
        presented: golden,
        evidence: evidence as unknown as ProviderDispatchCurrentEvidence,
      }),
    ).toMatchObject({ admitted: false, denial: "current_evidence_malformed" });
    expect(reads).toBe(0);
  });

  it("parses both inputs inside the exported comparison", () => {
    expect(compareProviderDispatchEnvelopes(golden, golden)).toEqual({ match: true });
    expect(compareProviderDispatchEnvelopes({ ...golden, extra: 1 }, golden)).toEqual({
      match: false,
      denial: "envelope_malformed",
    });
    expect(compareProviderDispatchEnvelopes(golden, mutate(golden, { schema: "provider-dispatch-envelope.v2" }))).toEqual({
      match: false,
      denial: "envelope_version_unsupported",
    });
  });
});

describe("provider dispatch denial vocabulary", () => {
  it("is closed, unique, and only preflight unavailability is retryable", () => {
    expect(new Set(PROVIDER_DISPATCH_DENIAL_CODES).size).toBe(PROVIDER_DISPATCH_DENIAL_CODES.length);
    const retryable = PROVIDER_DISPATCH_DENIAL_CODES.filter(isRetryableProviderDispatchDenial);
    expect(retryable).toEqual(["preflight_unavailable"]);
    const used = [
      ...fixture.malformed,
      ...fixture.substitutions,
      ...fixture.evidenceDenials,
      ...fixture.legacyXometry.denials,
    ].map((entry) => entry.denial);
    for (const denial of used) expect(PROVIDER_DISPATCH_DENIAL_CODES).toContain(denial);
  });
});

describe("provider dispatch admission decision", () => {
  it("admits only the exact envelope under current authoritative evidence", () => {
    expect(evaluateProviderDispatchAdmission({ expected: golden, presented: golden, evidence: admittedEvidence })).toEqual({
      admitted: true,
      contractVersion: "provider-dispatch-envelope.v1",
      provider: "xometry",
      envelopeFingerprint: fixture.golden.fingerprint,
      expiresAt: golden.expiresAt,
    });
  });

  it.each(fixture.substitutions)("rejects $name substitution as $denial", (entry) => {
    const presented = mutate(golden, entry.set as Record<string, Json>);
    expect(compareProviderDispatchEnvelopes(golden, presented)).toEqual({ match: false, denial: entry.denial });
    expect(evaluateProviderDispatchAdmission({ expected: golden, presented, evidence: admittedEvidence })).toEqual({
      admitted: false,
      contractVersion: "provider-dispatch-envelope.v1",
      denial: entry.denial,
      retryable: false,
    });
  });

  it.each(fixture.evidenceDenials)("fails closed when $name ($denial)", (entry) => {
    const evidence = mutate(admittedEvidence, entry.set as Record<string, Json>);
    expect(evaluateProviderDispatchAdmission({ expected: golden, presented: golden, evidence })).toMatchObject({
      admitted: false,
      denial: entry.denial,
      retryable: false,
    });
  });

  it("fails closed when the authoritative binding itself is malformed", () => {
    expect(
      evaluateProviderDispatchAdmission({ expected: { ...golden, extra: true }, presented: golden, evidence: admittedEvidence }),
    ).toMatchObject({ admitted: false, denial: "envelope_malformed" });
    expect(
      evaluateProviderDispatchAdmission({
        expected: golden,
        presented: golden,
        evidence: null as unknown as ProviderDispatchCurrentEvidence,
      }),
    ).toMatchObject({ admitted: false, denial: "current_evidence_malformed" });
  });

  it("never lets envelope fields or observations enable an unreviewed provider", () => {
    const fictiv = mutate(golden, {
      provider: "fictiv",
      "envelope.id": "fictiv-generic-envelope",
      "admission.policyRevision": "fictiv-approved-2026-10-01.v1",
      "admission.evidenceReference": "OVD-999",
    });
    const approvedEvidence = mutate(admittedEvidence, {
      "admission.provider": "fictiv",
      "admission.admission_state": "approved",
      "admission.generically_dispatchable": true,
      "admission.policy_revision": "fictiv-approved-2026-10-01.v1",
      "admission.evidence_reference": "OVD-999",
      "admission.permission_basis": "written_provider_authorization",
      "admission.reason_code": "provider_approved",
      observations: [{ source: "provider-upload-capability.v1", effect: "none" }],
    });
    expect(evaluateProviderDispatchAdmission({ expected: fictiv, presented: fictiv, evidence: approvedEvidence })).toMatchObject({
      admitted: false,
      denial: "provider_envelope_unknown",
    });
  });

  it("never lets a non-denying observation override disabled admission", () => {
    const evidence = mutate(admittedEvidence, {
      "admission.provider_admitted": false,
      "admission.admission_state": "evidence_required",
      "admission.reason_code": "evidence_required",
      observations: [{ source: "provider-upload-capability.v1", effect: "none" }],
    });
    expect(evaluateProviderDispatchAdmission({ expected: golden, presented: golden, evidence })).toMatchObject({
      admitted: false,
      denial: "admission_disabled",
    });
  });
});

describe("legacy Xometry compatibility mapping", () => {
  const legacy = fixture.legacyXometry;

  it("lifts an existing permit into the golden envelope only with explicit bindings", () => {
    const lifted = liftLegacyXometryPermit({
      scopeSnapshotFingerprint: legacy.scopeSnapshotFingerprint,
      permit: legacy.permit,
      scopeSnapshot: legacy.scopeSnapshot,
      bindings: legacy.bindings as Parameters<typeof liftLegacyXometryPermit>[0]["bindings"],
    });
    expect(lifted).toEqual({ ok: true, envelope: golden });
  });

  it("round-trips permit columns, task payload keys, and authorization keys verbatim", () => {
    const projection = projectLegacyXometryBinding(golden);
    expect(projection).toEqual({
      ok: true,
      permit: legacy.permit,
      taskPayload: legacy.taskPayload,
      authorization: legacy.authorization,
    });
  });

  it("documents every legacy key with a mapping that resolves to the same value", () => {
    const projection = projectLegacyXometryBinding(golden);
    if (!projection.ok) throw new Error(projection.denial);
    const surfaces: Array<[Record<string, string>, Record<string, unknown>]> = [
      [LEGACY_XOMETRY_PERMIT_COLUMN_MAP, projection.permit],
      [LEGACY_XOMETRY_TASK_PAYLOAD_KEY_MAP, projection.taskPayload],
      [LEGACY_XOMETRY_AUTHORIZATION_KEY_MAP, projection.authorization],
    ];
    for (const [map, legacyValue] of surfaces) {
      expect(Object.keys(map).sort()).toEqual(Object.keys(legacyValue).sort());
      for (const [legacyKey, neutralPath] of Object.entries(map)) {
        expect(legacyValue[legacyKey]).toEqual(neutralValue(golden, neutralPath));
      }
    }
  });

  it("maps the client scope-preview keys, keeping the notice revision distinct from admission", () => {
    const preview = parseXometryBetaDispatchScope({
      organizationId: golden.subject.organizationId,
      jobId: golden.subject.jobId,
      partId: golden.subject.partId,
      provider: "xometry",
      requestedQuantity: 1,
      scopeVersion: 1,
      scopeFingerprint: golden.scope.fingerprint,
      declaredModelUnits: "inch",
      policyRevision: golden.noticeRevision,
      envelopeRevision: XOMETRY_ENVELOPE_REVISION,
      scope: {
        schema: "quote-lane-scope.v1",
        vendor: "xometry",
        quantity: 1,
        destination: {
          confirmationRevision: "1",
          state: "confirmed",
          street: "1 Synthetic Way",
          city: "Example",
          region: "CA",
          postalCode: "00000",
          country: "US",
        },
        part: { id: golden.subject.partId, ...legacy.scopeSnapshot.part },
        requirements: {
          id: "00000000-0000-4000-8000-0000000045aa",
          capturedAt: "2026-10-03T11:00:00.000Z",
          description: null,
          partNumber: null,
          revision: null,
          material: "6061-T6",
          finish: null,
          tightestToleranceInch: 0.005,
          requestedDeliveryDate: null,
          specification: {},
        },
      },
    }) as unknown as Record<string, unknown>;
    for (const [legacyKey, neutralPath] of Object.entries(LEGACY_XOMETRY_SCOPE_PREVIEW_KEY_MAP)) {
      expect(preview[legacyKey]).toEqual(neutralValue(golden, neutralPath));
    }
    expect(LEGACY_XOMETRY_SCOPE_PREVIEW_KEY_MAP.policyRevision).toBe("noticeRevision");
    expect(golden.admission.policyRevision).not.toBe(preview.policyRevision);
  });

  it("feeds the existing worker preflight parser without behavior change", async () => {
    const projection = projectLegacyXometryBinding(golden);
    if (!projection.ok) throw new Error(projection.denial);
    const rpc = vi.fn().mockResolvedValue({
      data: { authorized: true, reasonCode: null, ...projection.authorization },
      error: null,
    });
    const quote = vi.fn().mockResolvedValue({ offers: [] });
    await quoteWithDispatchPreflight({
      supabase: { rpc } as unknown as SupabaseClient,
      config: { workerMode: "live", workerName: "worker-1" },
      workQueueTaskId: golden.task.workQueueTaskId,
      vendorQuoteResultId: golden.task.vendorQuoteResultId,
      claimedAt: golden.issuedAt,
      vendor: "xometry",
      scopeSnapshot: legacy.scopeSnapshot,
      adapter: { quote },
      quoteInput: {} as VendorQuoteAdapterInput,
    });
    expect(quote).toHaveBeenCalledWith({ xometryDispatchAuthorization: legacy.authorization });
  });

  it.each(legacy.denials)("rejects $name as $denial", (entry) => {
    const typed = entry as {
      permitSet?: Record<string, Json>;
      scopeSet?: Record<string, Json>;
      bindingsSet?: Record<string, Json>;
      scopeSnapshotFingerprint?: string | null;
      denial: string;
    };
    expect(
      liftLegacyXometryPermit({
        permit: mutate(legacy.permit, typed.permitSet),
        scopeSnapshot: mutate(legacy.scopeSnapshot, typed.scopeSet),
        scopeSnapshotFingerprint:
          "scopeSnapshotFingerprint" in typed ? typed.scopeSnapshotFingerprint : legacy.scopeSnapshotFingerprint,
        bindings: mutate(legacy.bindings, typed.bindingsSet) as Parameters<typeof liftLegacyXometryPermit>[0]["bindings"],
      }),
    ).toEqual({ ok: false, denial: typed.denial });
  });

  it("refuses to project non-legacy envelopes onto Xometry legacy keys", () => {
    expect(projectLegacyXometryBinding(mutate(golden, { "envelope.version": 2 }))).toEqual({
      ok: false,
      denial: "provider_envelope_mismatch",
    });
    expect(
      projectLegacyXometryBinding(mutate(golden, { provider: "fictiv", "envelope.id": "fictiv-controlled-beta-envelope" })),
    ).toEqual({ ok: false, denial: "provider_mismatch" });
    expect(projectLegacyXometryBinding({ ...golden, extra: 1 })).toEqual({ ok: false, denial: "envelope_malformed" });
  });
});
