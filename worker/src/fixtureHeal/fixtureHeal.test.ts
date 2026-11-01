// @vitest-environment node

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { genericFictivEnvelope } from "../../test-support/genericDispatchResponse";
import { fingerprintProviderDispatchEnvelope } from "../providerDispatchEnvelope";
import { ProviderDispatchAuthorizationError } from "../providerDispatchPreflight";
import { createProviderAuthorizationConsumer } from "../providerExecutionSeam";
import type { ProviderDispatchAuthorization, ProviderDispatchEnvelope } from "../providerDispatchTypes";
import {
  createProviderDaySwitch,
  PROVIDER_PAUSED_FIXTURE_HEAL,
  runProviderTaskPipeline,
  type ProviderTaskPipelineDeps,
  type ProviderTaskPipelineInput,
} from "../providerTaskPipeline";
import type { VendorQuoteAdapterInput, VendorQuoteAdapterOffer, VendorQuoteAdapterOutput } from "../types";
import { createFixtureSanityGate, FIXTURE_SANITY_HOLD_NOTE, requirementKey, type FixtureSanityContext } from "./gate";
import { createSupplierPauseSwitch, isInternalTestQuote, logFixtureHealPage, type FixtureHealPage } from "./pause";
import { checkQuote, materialEchoMismatch, type PriceHistory, type SanityInput } from "./sanity";
import { createSupabaseSanityHistoryReader, summarizeSanityHistory, type SanityHistoryReader } from "./sanityHistory";

// --------------------------------------------------------------------------- pure fixtures

const NO_HISTORY: PriceHistory = { available: true, history: [], peers: [] };

function sanityInput(change: Partial<SanityInput> = {}): SanityInput {
  return {
    provider: "oshcut",
    requestedQuantity: 1,
    priced: true,
    offers: [{ unitPriceUsd: 12.92, totalPriceUsd: 12.92, quantity: 1, priceText: "$12.92" }],
    requested: { material: "Aluminum 6061-T6", thicknessIn: 0.125 },
    echo: { material: "6061-T6", thicknessIn: 0.125, quantity: 1 },
    ...change,
  };
}

const codes = (input: SanityInput, history: PriceHistory = NO_HISTORY) =>
  checkQuote(input, history).findings.map((finding) => finding.code);

// --------------------------------------------------------------------------- pipeline harness

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const CAD = new TextEncoder().encode("step-bytes");
const DRAWING = new TextEncoder().encode("pdf-bytes");
// Inside the fixture envelope's permit window.
const NOW = Date.parse("2026-10-03T12:05:00.000Z");

function envelopeFor(): ProviderDispatchEnvelope {
  const base = genericFictivEnvelope();
  const outbound = (role: "cad" | "drawing", bytes: Uint8Array) => ({
    role,
    sourceSha256: sha(bytes),
    sha256: sha(bytes),
    derivation: "identity" as const,
  });
  return {
    ...base,
    sourceFiles: [
      { role: "cad", fileId: base.sourceFiles[0].fileId, sha256: sha(CAD) },
      { role: "drawing", fileId: base.sourceFiles[1].fileId, sha256: sha(DRAWING) },
    ],
    outboundFiles: [outbound("cad", CAD), outbound("drawing", DRAWING)],
  };
}

const ENVELOPE = envelopeFor();
const QTY = ENVELOPE.scope.requestedQuantity;

function authorization(): ProviderDispatchAuthorization {
  return {
    permitId: ENVELOPE.permit.permitId,
    provider: ENVELOPE.provider,
    envelopeFingerprint: fingerprintProviderDispatchEnvelope(ENVELOPE),
    expiresAt: ENVELOPE.expiresAt,
    sessionBindingId: ENVELOPE.sessionBindingId,
    envelope: ENVELOPE,
  };
}

function pipelineInput(internalTestQuote = false): ProviderTaskPipelineInput {
  return {
    task: {
      id: ENVELOPE.task.workQueueTaskId,
      attempts: 1,
      organizationId: ENVELOPE.subject.organizationId,
      quoteRunId: ENVELOPE.task.quoteRunId,
    },
    claim: {
      workQueueTaskId: ENVELOPE.task.workQueueTaskId,
      vendorQuoteResultId: ENVELOPE.task.vendorQuoteResultId,
      provider: "fictiv",
      permitId: ENVELOPE.permit.permitId,
      envelopeFingerprint: fingerprintProviderDispatchEnvelope(ENVELOPE),
    },
    requestedQuantity: QTY,
    environment: "test",
    adapterRevision: "fictiv@test",
    leaseSetting: "off",
    internalTestQuote,
    quoteInput: {
      organizationId: ENVELOPE.subject.organizationId,
      quoteRunId: ENVELOPE.task.quoteRunId,
      stagedCadFile: { originalName: "part.step", localPath: "/tmp/part.step", storageBucket: "b", storagePath: "p" },
      stagedDrawingFile: { originalName: "part.pdf", localPath: "/tmp/part.pdf", storageBucket: "b", storagePath: "q" },
      requestedQuantity: QTY,
    } as unknown as VendorQuoteAdapterInput,
  };
}

function quoteOutput(unit: number, rawPayload: Record<string, unknown> = {}): VendorQuoteAdapterOutput {
  return {
    vendor: "fictiv",
    status: "instant_quote_received",
    unitPriceUsd: unit,
    totalPriceUsd: Math.round(unit * QTY * 100) / 100,
    leadTimeBusinessDays: 8,
    quoteUrl: "https://app.fictiv.com/quotes/abc",
    dfmIssues: [],
    notes: [],
    artifacts: [],
    rawPayload: { source: "fictiv-live-adapter", requestedQuantity: QTY, ...rawPayload },
  };
}

function pipeline(options: {
  output?: VendorQuoteAdapterOutput;
  history?: SanityHistoryReader;
  pause?: ReturnType<typeof createSupplierPauseSwitch>;
  authorize?: () => Promise<ProviderDispatchAuthorization>;
  requirementMaterial?: string;
  /** Runs inside the adapter call, after the lane was admitted. */
  onQuote?: () => void;
}) {
  const pages: FixtureHealPage[] = [];
  const pause = options.pause ?? createSupplierPauseSwitch({ page: (page) => pages.push(page) });
  const calls: string[] = [];
  const history = vi.fn(options.history ?? (async () => NO_HISTORY));
  const gate = createFixtureSanityGate({ history, pause, now: () => NOW });
  const quote = vi.fn(async () => {
    calls.push("adapter");
    options.onQuote?.();
    return options.output ?? quoteOutput(12);
  });
  const persist = vi.fn(async (_output: VendorQuoteAdapterOutput) => {
    calls.push("persist");
    return { artifactCount: 0, acceptance: { outcome: "accepted" as const } };
  });
  const deps: ProviderTaskPipelineDeps = {
    readLane: async () => ({
      laneId: ENVELOPE.task.quoteRequestLaneId,
      quoteRequestId: ENVELOPE.task.quoteRequestId,
      quoteRunId: ENVELOPE.task.quoteRunId,
      vendorQuoteResultId: ENVELOPE.task.vendorQuoteResultId,
      scopeFingerprint: ENVELOPE.scope.fingerprint,
    }),
    authorize: options.authorize ?? (async () => authorization()),
    readCapturedFiles: async () => [
      { role: "cad" as const, bytes: Uint8Array.from(CAD) },
      { role: "drawing" as const, bytes: Uint8Array.from(DRAWING) },
    ],
    adapter: { provider: "fictiv", quote },
    persist,
    daySwitch: createProviderDaySwitch(),
    consumer: createProviderAuthorizationConsumer(),
    pause,
    sanity: async (output, context) => {
      calls.push("sanity");
      return gate(output, { ...context, requirement: { material: options.requirementMaterial ?? null } });
    },
    now: () => NOW,
    log: () => {},
  };
  return { deps, calls, quote, persist, history, pause, pages };
}

afterEach(() => {
  vi.useRealTimers();
});

// --------------------------------------------------------------------------- named cases

describe("OVD-813 fixture sanity gate", () => {
  it("sanity_dash_price_holds", () => {
    // OSHCut shows "-" until material and thickness are set; the adapter cannot parse a number from it.
    const dash = sanityInput({ offers: [{ unitPriceUsd: Number.NaN, totalPriceUsd: Number.NaN, quantity: 1, priceText: "-" }] });
    const verdict = checkQuote(dash, NO_HISTORY);
    expect(verdict.verdict).toBe("hold");
    expect(verdict.findings).toContainEqual({ code: "price_missing", class: "hard", detail: "dash_price_text" });
    expect(verdict.pause).toBe(true);
    // Even a number next to a dash cell is not trusted.
    expect(codes(sanityInput({ offers: [{ unitPriceUsd: 12, totalPriceUsd: 12, quantity: 1, priceText: " — " }] }))).toContain("price_missing");
    // A real price passes.
    expect(checkQuote(sanityInput(), NO_HISTORY).verdict).toBe("pass");
  });

  it("sanity_zero_or_missing_price_holds", () => {
    expect(codes(sanityInput({ offers: [{ unitPriceUsd: 0, totalPriceUsd: 0, quantity: 1 }] }))).toEqual(["price_zero"]);
    expect(codes(sanityInput({ offers: [{ unitPriceUsd: null, totalPriceUsd: 12, quantity: 1 }] }))).toEqual(["price_missing"]);
    expect(codes(sanityInput({ offers: [] }))).toEqual(["price_missing"]);
    expect(codes(sanityInput({ offers: [{ unitPriceUsd: 0.4, totalPriceUsd: 0.4, quantity: 1 }] }))).toEqual(["price_floor"]);
    // A shim at $0.40 each can be real: held for review, but the supplier is not paused.
    expect(checkQuote(sanityInput({ offers: [{ unitPriceUsd: 0.4, totalPriceUsd: 0.4, quantity: 1 }] }), NO_HISTORY)).toMatchObject({
      verdict: "hold",
      pause: false,
      findings: [{ code: "price_floor", class: "suspect" }],
    });
    for (const offers of [[{ unitPriceUsd: 0, totalPriceUsd: 0 }], []]) {
      const verdict = checkQuote(sanityInput({ offers }), NO_HISTORY);
      expect(verdict).toMatchObject({ verdict: "hold", pause: true });
    }
    // A result with no price to show (already manual review) is not checked at all.
    expect(checkQuote(sanityInput({ priced: false, offers: [] }), NO_HISTORY).verdict).toBe("skip");
  });

  it("sanity_echo_material_mismatch_holds (Xometry 5052)", () => {
    // Real T1 case: Xometry silently defaulted the plate to 5052-H32 and priced it at $45.56.
    const xometry = sanityInput({
      provider: "xometry",
      offers: [{ unitPriceUsd: 45.56, totalPriceUsd: 45.56, quantity: 1 }],
      requested: { material: "Aluminum 6061-T6", thicknessIn: null },
      echo: { material: "5052-H32", thicknessIn: null, quantity: null },
    });
    const verdict = checkQuote(xometry, NO_HISTORY);
    expect(verdict.findings).toEqual([{ code: "material_echo", class: "hard" }]);
    expect(verdict).toMatchObject({ verdict: "hold", pause: true });
    // The saved-requirement readback of the requested alloy passes, whatever its formatting.
    for (const echoed of ["6061-T6", "6061", "Aluminum 6061-T6", "aluminum 6061 t6"]) {
      expect(codes({ ...xometry, echo: { ...xometry.echo, material: echoed } })).toEqual([]);
    }
    // A temper suffix is not an alloy number: T651 against T6 of the same alloy passes.
    for (const [requested, echoed] of [
      ["Aluminum 6061-T651", "6061-T6 Aluminum"],
      ["Aluminum 6061-T651", "Aluminum 6061-T6"],
      ["7075-T651", "7075-T6"],
      ["Aluminum 7075-T651", "7075-T7351 Aluminum"],
    ]) {
      expect(materialEchoMismatch(requested, echoed)).toBe(false);
    }
    // A different alloy still fails whatever the temper.
    expect(materialEchoMismatch("Aluminum 6061-T651", "5052-H32 Aluminum")).toBe(true);
    expect(materialEchoMismatch("7075-T651", "6061-T651")).toBe(true);
    // No echo is recorded, not held, in slice 1.
    const silent = checkQuote({ ...xometry, echo: { material: null, thicknessIn: null, quantity: null } }, NO_HISTORY);
    expect(silent).toMatchObject({ verdict: "pass", findings: [{ code: "echo_unavailable", class: "info", detail: "material" }] });
  });

  it("sanity_echo_qty_thickness_mismatch_holds", () => {
    expect(codes(sanityInput({ echo: { material: "6061-T6", thicknessIn: 0.125, quantity: 10 } }))).toEqual(["qty_echo"]);
    expect(codes(sanityInput({ echo: { material: "6061-T6", thicknessIn: 0.25, quantity: 1 } }))).toEqual(["thickness_echo"]);
    // Within 0.001 in is the same sheet.
    expect(codes(sanityInput({ echo: { material: "6061-T6", thicknessIn: 0.1255, quantity: 1 } }))).toEqual([]);
    // An offer for another quantity is a quantity mismatch too.
    expect(codes(sanityInput({ offers: [{ unitPriceUsd: 12, totalPriceUsd: 120, quantity: 10 }] }))).toEqual(["qty_echo"]);
    const verdict = checkQuote(sanityInput({ echo: { material: "6061-T6", thicknessIn: 0.25, quantity: 10 } }), NO_HISTORY);
    expect(verdict).toMatchObject({ verdict: "hold", pause: true });
    // A quantity mismatch alone holds the quote but does not pause the supplier.
    for (const input of [
      sanityInput({ echo: { material: "6061-T6", thicknessIn: 0.125, quantity: 10 } }),
      sanityInput({ offers: [{ unitPriceUsd: 12, totalPriceUsd: 12, quantity: 1 }, { unitPriceUsd: 10, totalPriceUsd: 100, quantity: 10 }] }),
    ]) {
      expect(checkQuote(input, NO_HISTORY)).toMatchObject({ verdict: "hold", pause: false, findings: [{ code: "qty_echo", class: "suspect" }] });
    }
  });

  it("sanity_material_echo_matches_alloy_families (real Xometry labels)", () => {
    // Xometry's saved summary labels (xometryConstraints MATERIAL_SUMMARY_MAPPINGS) against requested labels used in this repo.
    for (const [requested, echoed] of [
      ["304 Stainless", "Stainless Steel 304/304L"],
      ["SS 316", "Stainless Steel 316/316L"],
      ["AISI 304", "Stainless Steel 304/304L"],
      ["304-2B stainless steel", "Stainless Steel 304/304L"],
      ["316L Stainless", "Stainless Steel 316/316L"],
      ["303 Stainless", "Stainless Steel 303"],
      ["17-4 PH", "Stainless Steel 17-4"],
      ["Aluminum 6061", "6061-T6"],
      ["6061-T6", "6061-T6x"],
      ["Aluminum 7075-T651", "7075-T6"],
      ["2024-T3 Aluminum", "2024-T3"],
      ["1018 Steel", "Steel 1018"],
      ["4140 Alloy Steel", "Steel 4140"],
      ["Brass 360", "Copper C360 (Brass)"],
    ]) {
      expect(materialEchoMismatch(requested, echoed), `${requested} vs ${echoed}`).toBe(false);
    }
    for (const [requested, echoed] of [
      ["304 Stainless", "Stainless Steel 316/316L"],
      ["SS 316", "Stainless Steel 304/304L"],
      ["303 Stainless", "Stainless Steel 304/304L"],
      ["Aluminum 6061-T6", "7075-T6"],
      ["7075-T651", "6061-T6"],
      ["Aluminum 6061", "Stainless Steel 304/304L"],
      ["Aluminum", "Steel 1018"],
      ["Stainless Steel", "Steel 4140"],
      ["17-4 PH", "Stainless Steel 304/304L"],
    ]) {
      expect(materialEchoMismatch(requested, echoed), `${requested} vs ${echoed}`).toBe(true);
    }
    // The real 304 readback holds nothing and pauses nothing.
    const stainless = sanityInput({
      provider: "xometry",
      requested: { material: "304 Stainless", thicknessIn: null },
      echo: { material: "Stainless Steel 304/304L", thicknessIn: null, quantity: null },
    });
    expect(checkQuote(stainless, NO_HISTORY)).toMatchObject({ verdict: "pass", pause: false, findings: [] });
  });

  it("sanity_arithmetic_unit_total_mismatch_holds", () => {
    // Per-unit and extended swapped at qty 10: unit shows the total.
    const swapped = sanityInput({
      requestedQuantity: 10,
      offers: [{ unitPriceUsd: 129.2, totalPriceUsd: 129.2, quantity: 10 }],
      echo: { material: "6061-T6", thicknessIn: 0.125, quantity: 10 },
    });
    const verdict = checkQuote(swapped, NO_HISTORY);
    expect(verdict.findings).toEqual([{ code: "arithmetic", class: "hard" }]);
    expect(verdict).toMatchObject({ verdict: "hold", pause: true });
    // Rounding within max($0.01 x qty, 0.5% of total) passes.
    const rounded = { ...swapped, offers: [{ unitPriceUsd: 12.92, totalPriceUsd: 129.25, quantity: 10 }] };
    expect(codes(rounded)).toEqual([]);
  });

  it("first_outlier_pauses_supplier_and_holds", async () => {
    // This supplier quoted the same package around $12; one 3x quote is the first outlier.
    const history = async () => ({ available: true as const, history: [12, 12.5, 11.8], peers: [] });
    const run = pipeline({ output: quoteOutput(36), history });
    expect(run.pause.isPaused("fictiv")).toBe(false);

    const outcome = await runProviderTaskPipeline(pipelineInput(), run.deps);

    expect(run.calls).toEqual(["adapter", "sanity", "persist"]);
    expect(outcome).toMatchObject({ disposition: "persisted", persisted: { status: "manual_review_pending", held: true } });
    const persisted = run.persist.mock.calls[0][0];
    expect(persisted.rawPayload.fixtureSanity).toMatchObject({
      verdict: "hold",
      pause: true,
      findings: [{ code: "history_outlier", class: "outlier" }],
      ratios: { history: 3 },
    });
    // Paused on the FIRST outlier (no second-in-24h rule), with a page carrying the brake command.
    expect(run.pause.isPaused("fictiv")).toBe(true);
    expect(run.pages).toHaveLength(1);
    expect(run.pages[0]).toMatchObject({ severity: "page", provider: "fictiv", codes: ["history_outlier"] });
    expect(run.pages[0].brakeCommand).toContain("npm run provider:kill -- fictiv --on --reason \"fixture-heal sanity history_outlier");
    // The history was read for this supplier, package and quantity.
    expect(run.history).toHaveBeenCalledWith(expect.objectContaining({
      provider: "fictiv",
      requestedQuantity: QTY,
      excludeResultId: ENVELOPE.task.vendorQuoteResultId,
      packageId: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));

    // A peer outlier (4x band, n >= 2 peers) pauses the same way, and an unreadable history holds without pausing.
    const peers = pipeline({ output: quoteOutput(150), history: async () => ({ available: true, history: [], peers: [28, 30, 27] }) });
    await runProviderTaskPipeline(pipelineInput(), peers.deps);
    expect(peers.persist.mock.calls[0][0].rawPayload.fixtureSanity.findings).toEqual([{ code: "peer_outlier", class: "outlier" }]);
    expect(peers.pause.isPaused("fictiv")).toBe(true);
    const unreadable = pipeline({ history: async () => { throw new Error("db down"); } });
    const held = await runProviderTaskPipeline(pipelineInput(), unreadable.deps);
    expect(held.persisted).toMatchObject({ status: "manual_review_pending", held: true });
    expect(unreadable.pause.isPaused("fictiv")).toBe(false);
  });

  it("held_quote_offers_withheld_not_visible", async () => {
    const run = pipeline({
      output: quoteOutput(12, { supplierEcho: { material: "5052-H32" } }),
      requirementMaterial: "6061-T6",
    });

    const outcome = await runProviderTaskPipeline(pipelineInput(), run.deps);

    expect(outcome.persisted).toEqual({ status: "manual_review_pending", offerCount: 0, artifactCount: 0, acceptance: { outcome: "accepted" }, held: true });
    const persisted = run.persist.mock.calls[0][0];
    // Nothing a customer could be shown: no prices, no offer rows, a pending note.
    expect(persisted).toMatchObject({ status: "manual_review_pending", unitPriceUsd: null, totalPriceUsd: null, offers: [] });
    expect(persisted.notes).toContain(FIXTURE_SANITY_HOLD_NOTE);
    expect(persisted.rawPayload.offers).toBeUndefined();
    // The withheld prices are kept for admin review in raw_payload.fixtureSanity only.
    expect(persisted.rawPayload.fixtureSanity).toMatchObject({
      held: true,
      holdReason: "sanity",
      withheldStatus: "instant_quote_received",
      withheldResult: { unitPriceUsd: 12, totalPriceUsd: 12 * QTY },
      findings: [{ code: "material_echo", class: "hard" }],
    });

    // A passing quote persists unchanged with its verdict recorded.
    const pass = pipeline({ requirementMaterial: "6061-T6", output: quoteOutput(12, { supplierEcho: { material: "6061-T6" } }) });
    const passed = await runProviderTaskPipeline(pipelineInput(), pass.deps);
    expect(passed.persisted).toMatchObject({ status: "instant_quote_received", held: false });
    expect(pass.persist.mock.calls[0][0]).toMatchObject({ unitPriceUsd: 12, rawPayload: { fixtureSanity: { verdict: "pass", held: false } } });
  });

  it("paused_supplier_rejects_customer_quote", async () => {
    const pause = createSupplierPauseSwitch({ page: () => {} });
    pause.pause({ provider: "fictiv", codes: ["material_echo"], runId: "run", vendorQuoteResultId: "r", nowMs: NOW });
    const run = pipeline({ pause });

    const outcome = await runProviderTaskPipeline(pipelineInput(false), run.deps);

    expect(outcome).toMatchObject({
      disposition: "manual_follow_up",
      code: PROVIDER_PAUSED_FIXTURE_HEAL,
      stage: "authorize",
      adapterStarted: false,
      persisted: null,
    });
    expect(run.quote).not.toHaveBeenCalled();
    expect(run.persist).not.toHaveBeenCalled();
    // A marker without the internal org and golden part is still a customer quote.
    const policy = { internalOrganizationIds: new Set(["internal-org"]), goldenPartIds: new Set(["golden-part"]) };
    expect(isInternalTestQuote({ marker: { internal: true }, organizationId: "customer-org", partId: "golden-part" }, policy)).toBe(false);
    expect(isInternalTestQuote({ marker: { internal: true }, organizationId: "internal-org", partId: "customer-part" }, policy)).toBe(false);
    expect(isInternalTestQuote({ marker: { internal: "true" }, organizationId: "internal-org", partId: "golden-part" }, policy)).toBe(false);
    expect(isInternalTestQuote({ marker: undefined, organizationId: "internal-org", partId: "golden-part" }, policy)).toBe(false);
  });

  it("paused_supplier_allows_internal_test_quote_marked_internal", async () => {
    const policy = { internalOrganizationIds: new Set(["internal-org"]), goldenPartIds: new Set(["golden-part"]) };
    expect(isInternalTestQuote({ marker: { internal: true }, organizationId: "internal-org", partId: "golden-part" }, policy)).toBe(true);
    const pause = createSupplierPauseSwitch({ page: () => {} });
    pause.pause({ provider: "fictiv", codes: ["material_echo"], runId: "run", vendorQuoteResultId: "r", nowMs: NOW });
    const run = pipeline({ pause });

    const outcome = await runProviderTaskPipeline(pipelineInput(true), run.deps);

    expect(run.quote).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ disposition: "persisted", persisted: { status: "manual_review_pending", held: true } });
    // Marked internal and never publishable: its prices stay out of the offer table even on a pass.
    const persisted = run.persist.mock.calls[0][0];
    expect(persisted).toMatchObject({ unitPriceUsd: null, totalPriceUsd: null, offers: [] });
    expect(persisted.rawPayload.fixtureHeal).toEqual({ v: 1, internal: true });
    expect(persisted.rawPayload.fixtureSanity).toMatchObject({
      verdict: "pass",
      held: true,
      holdReason: "internal_test_quote",
      withheldResult: { unitPriceUsd: 12 },
    });
    // Running it did not release the pause.
    expect(pause.isPaused("fictiv")).toBe(true);
  });

  it("adapter_supplied_fixture_heal_marker_is_stripped", async () => {
    const spoof = { fixtureHeal: { v: 9, internal: false } };
    const offer: VendorQuoteAdapterOffer = {
      providerOptionId: "standard",
      providerLabel: "Standard",
      quoteRef: "Q-1",
      quoteUrl: "https://app.fictiv.com/quotes/abc",
      quantity: 1,
      unitPriceUsd: 12,
      totalPriceUsd: 12,
      leadTimeBusinessDays: 8,
      shipReceiveBy: null,
      tier: "Standard",
      sourcing: null,
      geographicOrigin: "unknown",
      sortRank: 0,
      provenance: {
        containerSelector: ".option",
        providerOptionIdSource: "attribute",
        priceSource: "selector",
        leadTimeSource: "selector",
        geographicOriginSource: "none",
      },
      rawPayload: { priceText: "$12.00", ...spoof },
    };
    const spoofed = (echo = "6061-T6"): VendorQuoteAdapterOutput => ({
      ...quoteOutput(12, { ...spoof, supplierEcho: { material: echo } }),
      totalPriceUsd: 12,
      offers: [offer],
    });
    const gate = createFixtureSanityGate({ history: async () => NO_HISTORY, pause: createSupplierPauseSwitch({ page: () => {} }), now: () => NOW });
    const context = (internalTestQuote: boolean) => ({
      provider: "fictiv",
      vendorQuoteResultId: "result",
      quoteRunId: "run",
      requestedQuantity: 1,
      requirement: { material: "6061-T6" },
      packageId: null,
      internalTestQuote,
    });

    // A customer quote that passes: no marker on the result or on any offer.
    const passed = await gate(spoofed(), context(false));
    expect(passed.held).toBe(false);
    expect(passed.output.rawPayload).not.toHaveProperty("fixtureHeal");
    expect(passed.output.offers?.[0].rawPayload).toEqual({ priceText: "$12.00" });

    // A held customer quote: dropped from the result and from the withheld offers.
    const held = await gate(spoofed("5052-H32"), context(false));
    expect(held.held).toBe(true);
    expect(held.output.rawPayload).not.toHaveProperty("fixtureHeal");
    const withheld = (held.output.rawPayload.fixtureSanity as { withheldOffers: VendorQuoteAdapterOffer[] }).withheldOffers;
    expect(withheld[0].rawPayload).toEqual({ priceText: "$12.00" });

    // A verified internal test quote carries the gate's own marker, never the adapter's.
    const internal = await gate(spoofed(), context(true));
    expect(internal.output.rawPayload.fixtureHeal).toEqual({ v: 1, internal: true });
  });

  it("history_reads_own_rows_separately_from_peers", async () => {
    // 50 newer peer rows would fill a single shared limit; the supplier's own rows must still be read.
    const day = Date.parse("2026-10-10T00:00:00.000Z");
    const peerRows = Array.from({ length: 50 }, (_, i) => ({ vendor: i % 2 ? "oshcut" : "fictiv", unit_price_usd: 30, created_at: "2026-10-09T00:00:00Z" }));
    const ownRows = [{ vendor: "xometry", unit_price_usd: 12, created_at: "2026-09-01T00:00:00Z" }];
    const vendorFilters: string[] = [];
    const from = () => {
      let own: boolean | null = null;
      const query = {
        select: () => query, in: () => query, gte: () => query, or: () => query, order: () => query, limit: () => query,
        eq(column: string) { if (column === "vendor") { own = true; vendorFilters.push("eq"); } return query; },
        neq(column: string) { if (column === "vendor") { own = false; vendorFilters.push("neq"); } return query; },
        then: (resolve: (value: unknown) => unknown) => resolve({ data: own ? ownRows : peerRows, error: null }),
      };
      return query;
    };
    const reader = createSupabaseSanityHistoryReader({ from } as unknown as SupabaseClient);

    const history = await reader({ provider: "xometry", packageId: "c".repeat(64), requirementKey: "d".repeat(64), requestedQuantity: 1, excludeResultId: "r", nowMs: day });

    expect(vendorFilters.sort()).toEqual(["eq", "neq"]);
    expect(history).toEqual({ available: true, history: [12], peers: [30, 30] });
  });

  it("history_matches_requirement_so_new_material_is_not_an_outlier", async () => {
    // The same CAD was quoted in 6061 at ~$12 by this supplier; now the customer re-quotes it in 316 stainless.
    const packageId = "c".repeat(64);
    const aluminum = { material: "Aluminum 6061-T6", finish: null, tightest_tolerance_inch: null, spec_snapshot: {} };
    const stainless = { ...aluminum, material: "316 Stainless" };
    const anodized = { ...aluminum, finish: "Anodize Type II" };
    const aluminumKey = requirementKey(aluminum);
    expect(aluminumKey).toMatch(/^[a-f0-9]{64}$/);
    expect(requirementKey(stainless)).not.toBe(aluminumKey);
    expect(requirementKey(anodized)).not.toBe(aluminumKey);
    expect(requirementKey({ ...aluminum, material: null })).toBeNull();
    const stored = [12, 12.5, 11.8].map((unit) => ({
      vendor: "fictiv", unit_price_usd: unit, cheapest_unit_usd: String(unit), created_at: "2026-10-01T00:00:00Z",
      packageId, requirementKey: aluminumKey,
    }));
    const from = () => {
      const filters: Array<(row: (typeof stored)[number]) => boolean> = [];
      const query = {
        select: () => query, in: () => query, gte: () => query, order: () => query, limit: () => query,
        eq(column: string, value: string) {
          if (column === "vendor") filters.push((row) => row.vendor === value);
          if (column === "raw_payload->fixtureSanity->>packageId") filters.push((row) => row.packageId === value);
          if (column === "raw_payload->fixtureSanity->>requirementKey") filters.push((row) => row.requirementKey === value);
          return query;
        },
        neq(column: string, value: string) {
          if (column === "vendor") filters.push((row) => row.vendor !== value);
          return query;
        },
        then: (resolve: (value: unknown) => unknown) => resolve({ data: stored.filter((row) => filters.every((keep) => keep(row))), error: null }),
      };
      return query;
    };
    const pause = createSupplierPauseSwitch({ page: () => {} });
    const gate = createFixtureSanityGate({ history: createSupabaseSanityHistoryReader({ from } as unknown as SupabaseClient), pause, now: () => NOW });
    const context = (requirement: FixtureSanityContext["requirement"]): FixtureSanityContext => ({
      provider: "fictiv", vendorQuoteResultId: "result", quoteRunId: "run", requestedQuantity: QTY, requirement, packageId, internalTestQuote: false,
    });

    // Stainless at 3x the aluminum price: a different requirement, so no baseline and no outlier.
    const requoted = await gate(quoteOutput(36), context(stainless));
    expect(requoted.verdict).toMatchObject({ verdict: "pass", pause: false, ratios: { history: null } });
    expect(requoted.output.rawPayload.fixtureSanity).toMatchObject({ requirementKey: requirementKey(stainless), packageId });
    expect(pause.isPaused("fictiv")).toBe(false);

    // The same 3x price in the same aluminum requirement is still the first outlier.
    const drifted = await gate(quoteOutput(36, { supplierEcho: { material: "6061-T6" } }), context(aluminum));
    expect(drifted.verdict).toMatchObject({ verdict: "hold", pause: true, findings: [{ code: "history_outlier", class: "outlier" }] });
    expect(pause.isPaused("fictiv")).toBe(true);
  });

  it("history_compares_cheapest_offer_like_for_like", () => {
    // Stored rows carry the summary (standard lead time) price and the cheapest offer the gate saw (economy).
    const query = { provider: "fictiv", packageId: "c".repeat(64), requirementKey: "d".repeat(64), requestedQuantity: 1, excludeResultId: "r",
      nowMs: Date.parse("2026-10-10T00:00:00Z") };
    const rows = [
      { vendor: "fictiv", unit_price_usd: 20, cheapest_unit_usd: "12", created_at: "2026-10-01T00:00:00Z" },
      { vendor: "oshcut", unit_price_usd: 40, cheapest_unit_usd: "25", created_at: "2026-10-01T00:00:00Z" },
      // A row without the v2 field falls back to its summary price.
      { vendor: "oshcut", unit_price_usd: 30, cheapest_unit_usd: null, created_at: "2026-10-02T00:00:00Z" },
    ];
    expect(summarizeSanityHistory(rows, query)).toEqual({ available: true, history: [12], peers: [25] });
    // The verdict records the cheapest offer, so the next quote compares against the same measure.
    const verdict = checkQuote(sanityInput({ offers: [
      { unitPriceUsd: 18, totalPriceUsd: 18, quantity: 1 },
      { unitPriceUsd: 12.5, totalPriceUsd: 12.5, quantity: 1 },
    ] }), { available: true, history: [12], peers: [] });
    expect(verdict).toMatchObject({ verdict: "pass", cheapestUnitUsd: 12.5, ratios: { history: 1.0417 } });
  });

  it("pause_page_says_restart_clears_it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logFixtureHealPage({ severity: "page", source: "fixture_heal.pause", provider: "oshcut", codes: ["price_missing"], runId: "run",
      vendorQuoteResultId: "r", brakeCommand: "npm run provider:kill -- oshcut --on" });
    const line = JSON.parse(String(error.mock.calls[0][0]));
    expect(line.message).toContain("process-local: a restart clears it. Run brakeCommand to persist it.");
    expect(line.context.brakeCommand).toBe("npm run provider:kill -- oshcut --on");
    error.mockRestore();
  });

  it("pause_while_in_flight_holds_the_result", async () => {
    // Another lane in this process pauses the supplier after this lane was admitted.
    const pause = createSupplierPauseSwitch({ page: () => {} });
    const run = pipeline({
      pause,
      onQuote: () => pause.pause({ provider: "fictiv", codes: ["material_echo"], runId: "other", vendorQuoteResultId: "other", nowMs: NOW }),
    });

    const outcome = await runProviderTaskPipeline(pipelineInput(false), run.deps);

    expect(run.calls).toEqual(["adapter", "sanity", "persist"]);
    expect(outcome).toMatchObject({ disposition: "persisted", persisted: { status: "manual_review_pending", offerCount: 0, held: true } });
    const persisted = run.persist.mock.calls[0][0];
    expect(persisted).toMatchObject({ unitPriceUsd: null, totalPriceUsd: null, offers: [] });
    // Its own check passed; it is held only because the supplier is paused.
    expect(persisted.rawPayload.fixtureSanity).toMatchObject({
      verdict: "pass",
      held: true,
      holdReason: "supplier_paused",
      withheldResult: { unitPriceUsd: 12 },
    });

    // Without a pause the same quote passes.
    const clear = pipeline({});
    expect((await runProviderTaskPipeline(pipelineInput(false), clear.deps)).persisted).toMatchObject({ held: false });
  });

  it("kill_switch_engaged_blocks_even_internal_quote", async () => {
    const pause = createSupplierPauseSwitch({ page: () => {} });
    pause.pause({ provider: "fictiv", codes: ["price_missing"], runId: "run", vendorQuoteResultId: "r", nowMs: NOW });
    const run = pipeline({
      pause,
      authorize: async () => {
        throw new ProviderDispatchAuthorizationError("provider_kill_switch_engaged");
      },
    });

    const outcome = await runProviderTaskPipeline(pipelineInput(true), run.deps);

    expect(outcome).toMatchObject({ disposition: "cancelled_provider_disabled", code: "cancelled_provider_disabled", persisted: null });
    expect(outcome.killSwitch?.error.reasonCode).toBe("provider_kill_switch_engaged");
    expect(run.quote).not.toHaveBeenCalled();
    expect(run.persist).not.toHaveBeenCalled();
  });

  it("throwing_gate_fails_closed_on_pipeline", async () => {
    const run = pipeline({});
    run.deps.sanity = async () => {
      throw new Error("gate exploded");
    };

    const outcome = await runProviderTaskPipeline(pipelineInput(), run.deps);

    // The unchecked price is never persisted; the lane goes to manual follow-up.
    expect(outcome).toMatchObject({ disposition: "manual_follow_up", code: "fixture_sanity_failed", stage: "validate", persisted: null });
    expect(run.quote).toHaveBeenCalledOnce();
    expect(run.persist).not.toHaveBeenCalled();

    // A gate that returns a malformed result fails closed the same way.
    const malformed = pipeline({});
    malformed.deps.sanity = async () => ({ output: undefined, held: "no" }) as never;
    expect(await runProviderTaskPipeline(pipelineInput(), malformed.deps)).toMatchObject({ code: "fixture_sanity_failed" });
    expect(malformed.persist).not.toHaveBeenCalled();
  });

  it("kill_switch_wins_over_pause_for_customer_quote", async () => {
    const pause = createSupplierPauseSwitch({ page: () => {} });
    pause.pause({ provider: "fictiv", codes: ["material_echo"], runId: "run", vendorQuoteResultId: "r", nowMs: NOW });
    const run = pipeline({
      pause,
      authorize: async () => {
        throw new ProviderDispatchAuthorizationError("provider_kill_switch_engaged");
      },
    });

    const outcome = await runProviderTaskPipeline(pipelineInput(false), run.deps);

    // Both engaged: the lane ends as killed, not in the manual follow-up queue.
    expect(outcome).toMatchObject({ disposition: "cancelled_provider_disabled", code: "cancelled_provider_disabled", persisted: null });
    expect(outcome.code).not.toBe(PROVIDER_PAUSED_FIXTURE_HEAL);
    expect(run.quote).not.toHaveBeenCalled();
  });

  it("pause_does_not_auto_release_at_midnight_without_reverify", () => {
    vi.useFakeTimers();
    const beforeMidnight = Date.parse("2026-10-15T23:59:00.000Z");
    vi.setSystemTime(beforeMidnight);
    const pause = createSupplierPauseSwitch({ page: () => {} });
    const daySwitch = createProviderDaySwitch();
    pause.pause({ provider: "oshcut", codes: ["price_missing"], runId: "run", vendorQuoteResultId: "r", nowMs: beforeMidnight });
    daySwitch.disable("oshcut", beforeMidnight);

    // Two days later, well past every UTC midnight: the day switch lifted, the drift pause did not.
    const later = Date.parse("2026-10-17T00:01:00.000Z");
    vi.setSystemTime(later);
    vi.advanceTimersByTime(48 * 60 * 60 * 1000);
    expect(daySwitch.isDisabled("oshcut", later)).toBe(false);
    expect(pause.isPaused("oshcut")).toBe(true);
    expect(pause.admits("oshcut", { internalTestQuote: false })).toBe(false);

    // Only a re-verify or heal outcome with evidence releases it.
    expect(pause.release("oshcut", { via: "timer" as "reverify", evidenceRef: "midnight" })).toBe(false);
    expect(pause.release("oshcut", { via: "reverify", evidenceRef: " " })).toBe(false);
    expect(pause.isPaused("oshcut")).toBe(true);
    expect(pause.release("oshcut", { via: "reverify", evidenceRef: "certification:run-42" })).toBe(true);
    expect(pause.isPaused("oshcut")).toBe(false);
    expect(pause.admits("oshcut", { internalTestQuote: false })).toBe(true);
  });
});
