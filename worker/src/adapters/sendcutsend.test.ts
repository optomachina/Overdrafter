// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeLiveEvaluationInput, sha256File } from "../liveEvaluationFiles";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import {
  isApprovedSendCutSendOrigin,
  normalizeSendCutSendOffers,
  parseSendCutSendEvaluationManifest,
  parseSendCutSendValidityEvidence,
  safeSendCutSendEvaluationError,
  SendCutSendAdapter,
  type SendCutSendEvaluationManifest,
  type SendCutSendQuoteContainer,
} from "./sendcutsend";

const tempDirs: string[] = [];

function container(overrides: Partial<SendCutSendQuoteContainer> = {}): SendCutSendQuoteContainer {
  return {
    availability: "purchasable",
    domMatchId: "dom-standard",
    selector: "[data-testid='quote-option']",
    providerOptionId: "standard",
    providerLabel: "Standard",
    quoteRef: "SCS-101",
    quoteUrl: "https://app.sendcutsend.com/quotes/SCS-101",
    text: "Standard $120.00 5 business days. Quoted on 2026-08-27. Valid for 14 days.",
    ...overrides,
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((tempDir) => fs.rm(tempDir, {
    recursive: true,
    force: true,
  })));
});

function manifest(overrides: Partial<SendCutSendEvaluationManifest> = {}) {
  return {
    schemaVersion: "sendcutsend-evaluation-manifest.v1",
    reviewed: true,
    reviewedAt: "2026-08-27",
    reviewedBy: "evaluation-reviewer",
    envelopeRevision: "sendcutsend-cnc-envelope.v1",
    accountMode: "company_controlled",
    cadFileName: "bracket.step",
    drawingFileName: null,
    cadSha256: "a".repeat(64),
    drawingSha256: null,
    process: "CNC machining",
    material: "6061-T6 aluminum",
    finish: "as machined",
    tightestToleranceInch: 0.005,
    quantities: [1],
    ...overrides,
  } satisfies SendCutSendEvaluationManifest;
}

async function authorizedAdapterInput(overrides: {
  manifest?: Record<string, unknown> | null;
  executionContext?: "live_evaluation" | "production_dispatch";
  eligibleGeometry?: boolean;
  drawing?: boolean;
} = {}) {
  const fixture = await fs.readFile(
    new URL("./fixtures/sendcutsend-planar-single-solid.step", import.meta.url),
    "utf8",
  );
  const eligibleFixture = fixture.replace(
    /\((-?1)\.,(-?1)\.,(-?1)\.\)/g,
    (_match, x: string, y: string, z: string) => {
      const scaled = [x, y, z].map((coordinate) => Number(coordinate) * 25.4);
      return `(${scaled[0]}.,${scaled[1]}.,${scaled[2]}.)`;
    },
  );
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sendcutsend-adapter-test-"));
  tempDirs.push(tempDir);
  const cadPath = path.join(tempDir, "bracket.step");
  const drawingPath = overrides.drawing ? path.join(tempDir, "bracket.pdf") : null;
  await fs.writeFile(cadPath, overrides.eligibleGeometry === false ? fixture : eligibleFixture);
  if (drawingPath) {
    await fs.writeFile(drawingPath, "drawing-bytes");
  }
  const [cadSha256, drawingSha256] = await Promise.all([
    sha256File(cadPath),
    drawingPath ? sha256File(drawingPath) : Promise.resolve(null),
  ]);
  const evaluationManifest = overrides.manifest === undefined
    ? manifest({
      cadSha256,
      drawingFileName: drawingPath ? "bracket.pdf" : null,
      drawingSha256,
    })
    : overrides.manifest;
  const input: VendorQuoteAdapterInput = {
    executionContext: overrides.executionContext ?? "live_evaluation",
    liveEvaluationAuthorization: {
      nonExportControlled: true,
      cadFileSha256: cadSha256,
      drawingFileSha256: drawingSha256,
    },
    organizationId: "org-sendcutsend-evaluation",
    quoteRunId: "run-sendcutsend-evaluation",
    requestedQuantity: 1,
    part: {
      id: "part-sendcutsend-evaluation",
      job_id: "job-sendcutsend-evaluation",
      organization_id: "org-sendcutsend-evaluation",
      name: "Bracket",
      normalized_key: "bracket",
      cad_file_id: "cad-sendcutsend-evaluation",
      drawing_file_id: drawingPath ? "drawing-sendcutsend-evaluation" : null,
      quantity: 1,
    },
    cadFile: null,
    drawingFile: null,
    stagedCadFile: {
      originalName: "bracket.step",
      localPath: cadPath,
      storageBucket: "evaluation-only",
      storagePath: "cad/bracket.step",
      trustedContentSha256: cadSha256,
    },
    stagedDrawingFile: drawingPath ? {
      originalName: "bracket.pdf",
      localPath: drawingPath,
      storageBucket: "evaluation-only",
      storagePath: "drawing/bracket.pdf",
      trustedContentSha256: drawingSha256 ?? undefined,
    } : null,
    requirement: {
      id: "requirement-sendcutsend-evaluation",
      part_id: "part-sendcutsend-evaluation",
      description: "SendCutSend finite evaluation",
      part_number: "BRACKET-001",
      revision: "A",
      material: "6061-T6 aluminum",
      finish: "as machined",
      tightest_tolerance_inch: 0.005,
      quantity: 1,
      quote_quantities: [1],
      requested_by_date: null,
      applicable_vendors: ["sendcutsend"],
      spec_snapshot: {
        process: "CNC machining",
        ...(evaluationManifest === null ? {} : { evaluationManifest }),
      },
    },
  };
  const authorizedInput = await authorizeLiveEvaluationInput(input);
  if (!authorizedInput) {
    throw new Error("test input authorization failed");
  }
  return { input, authorizedInput };
}

describe("SendCutSend canonical evaluation manifest", () => {
  it("parses a complete exact manifest without mutating it", () => {
    const input = manifest();
    const original = structuredClone(input);

    expect(parseSendCutSendEvaluationManifest(input)).toEqual(input);
    expect(input).toEqual(original);
  });

  it.each([
    ["missing key", () => {
      const input = { ...manifest() } as Record<string, unknown>;
      delete input.finish;
      return input;
    }],
    ["extra key", () => ({ ...manifest(), unreviewed: true })],
    ["invalid date", () => ({ ...manifest(), reviewedAt: "2026-02-31" })],
    ["untrimmed reviewer", () => ({ ...manifest(), reviewedBy: " reviewer " })],
    ["path in filename", () => ({ ...manifest(), cadFileName: "/private/bracket.step" })],
    ["unpaired drawing", () => ({
      ...manifest(),
      drawingFileName: "drawing.pdf",
      drawingSha256: null,
    })],
    ["uppercase digest", () => ({ ...manifest(), cadSha256: "A".repeat(64) })],
    ["duplicate quantity", () => ({ ...manifest(), quantities: [1, 1] })],
    ["unsafe quantity", () => ({ ...manifest(), quantities: [Number.MAX_SAFE_INTEGER + 1] })],
  ])("rejects a manifest with %s", (_label, makeInput) => {
    expect(parseSendCutSendEvaluationManifest(makeInput())).toBeNull();
  });
});

describe("SendCutSend complete unique offers", () => {
  it("normalizes price, quantity, provenance, destination, reference, and validity", () => {
    const fixtures = [
      container(),
      container({
        domMatchId: "dom-rush",
        providerOptionId: "rush",
        providerLabel: "Rush",
        quoteRef: "SCS-101-RUSH",
        quoteUrl: "https://app.sendcutsend.com/quotes/SCS-101?speed=rush",
        text: "Rush per part: $80.00 3 business days. Valid through 2026-09-10.",
      }),
    ];
    const originalFixtures = structuredClone(fixtures);

    const normalized = normalizeSendCutSendOffers(fixtures, 2);

    expect(normalized).toMatchObject({
      ok: true,
      offers: [
        {
          providerOptionId: "standard",
          quoteRef: "SCS-101",
          quoteUrl: "https://app.sendcutsend.com/quotes/SCS-101",
          unitPriceUsd: 60,
          totalPriceUsd: 120,
          leadTimeBusinessDays: 5,
          provenance: { containerSelector: "[data-testid='quote-option']" },
          rawPayload: {
            containerDomMatchId: "dom-standard",
            validityEvidence: {
              quotedAt: "2026-08-27",
              validityDurationDays: 14,
              validitySource: "vendor_duration",
            },
            evidenceTrust: "evaluation_only_untrusted",
            customerLiveOfferEligible: false,
            persistenceEligible: false,
          },
        },
        {
          providerOptionId: "rush",
          unitPriceUsd: 80,
          totalPriceUsd: 160,
          leadTimeBusinessDays: 3,
        },
      ],
    });
    expect(fixtures).toEqual(originalFixtures);
  });

  it.each([
    "Standard exact $100.00 ships in under 5 business days",
    "Available from 2026-08-27. Standard exact $100.00",
  ])("does not treat ordinary qualified numbers as price bounds: %s", (text) => {
    expect(normalizeSendCutSendOffers([container({ text })], 1)).toMatchObject({
      ok: true,
      offers: [{ unitPriceUsd: 100, totalPriceUsd: 100 }],
    });
  });

  it("derives provider ID provenance from the trimmed identifier", () => {
    expect(normalizeSendCutSendOffers([container({ providerOptionId: "   " })], 1))
      .toMatchObject({
        ok: true,
        offers: [{
          providerOptionId: "Standard",
          provenance: { providerOptionIdSource: "provider_label" },
        }],
      });
    expect(normalizeSendCutSendOffers([container({ providerOptionId: " standard-trimmed " })], 1))
      .toMatchObject({
        ok: true,
        offers: [{
          providerOptionId: "standard-trimmed",
          provenance: { providerOptionIdSource: "attribute" },
        }],
      });
  });
});

describe("SendCutSend duplicate evidence", () => {
  it("collapses exact matches and rejects conflicting duplicate provider IDs", () => {
    const exact = container();
    expect(normalizeSendCutSendOffers([exact, { ...exact }], 2)).toMatchObject({
      ok: true,
      offers: [{ providerOptionId: "standard" }],
    });

    expect(normalizeSendCutSendOffers([
      exact,
      container({
        domMatchId: "dom-conflict",
        providerLabel: "Different",
        quoteRef: "SCS-202",
        text: "Different $130.00 6 business days",
      }),
    ], 2)).toEqual({
      ok: false,
      reason: "duplicate_provider_option_id",
      providerOptionId: "standard",
    });
  });

  it.each([
    ["unavailable first", [
      container({ availability: "unavailable", text: "Standard unavailable" }),
      container(),
    ]],
    ["purchasable first", [
      container(),
      container({ availability: "unavailable", text: "Standard unavailable" }),
    ]],
  ])("rejects conflicting availability with the same provider ID: %s", (_label, fixtures) => {
    expect(normalizeSendCutSendOffers(fixtures, 2)).toEqual({
      ok: false,
      reason: "duplicate_provider_option_id",
      providerOptionId: "standard",
    });
  });
});

describe("SendCutSend incomplete and ambiguous offers", () => {
  it.each([
    ["missing label", { providerLabel: null }, "purchasable_offer_incomplete"],
    ["missing reference", { quoteRef: null }, "purchasable_offer_incomplete"],
    ["blank DOM identity", { domMatchId: "  " }, "purchasable_offer_incomplete"],
    ["blank selector", { selector: "\t" }, "purchasable_offer_incomplete"],
    ["missing destination", { quoteUrl: null }, "unapproved_destination"],
    ["unapproved destination", { quoteUrl: "https://sendcutsend.com/quotes/SCS-101" }, "unapproved_destination"],
    ["missing price", { text: "Standard pricing unavailable" }, "purchasable_offer_unparseable"],
    ["ambiguous prices", { text: "Was $150.00, now $125.00" }, "purchasable_offer_unparseable"],
    ["price range", { text: "Standard $100.00-$120.00" }, "purchasable_offer_unparseable"],
    ["USD to range", { text: "Standard USD 100.00 to 120.00" }, "purchasable_offer_unparseable"],
    ["en-dash range", { text: "Standard $100.00–$120.00" }, "purchasable_offer_unparseable"],
    ["em-dash USD range", { text: "Standard USD 100.00—USD 120.00" }, "purchasable_offer_unparseable"],
    ["redundant second currency", { text: "Standard $100.00 - USD $120.00" }, "purchasable_offer_unparseable"],
    ["malformed first range price", { text: "Standard $1,20.00-$120.00" }, "purchasable_offer_unparseable"],
    ["starting-at price", { text: "Standard starting at $100.00" }, "purchasable_offer_unparseable"],
    ["prices start at", { text: "Standard prices start at $100.00" }, "purchasable_offer_unparseable"],
    ["prices start from", { text: "Standard prices start from $100.00" }, "purchasable_offer_unparseable"],
    ["redundant USD marker", { text: "Standard starting at USD $100.00" }, "purchasable_offer_unparseable"],
    ["from price", { text: "Standard from USD 100.00" }, "purchasable_offer_unparseable"],
    ["up-to price", { text: "Standard up to $100.00" }, "purchasable_offer_unparseable"],
    ["minimum price", { text: "Standard minimum price: $100.00" }, "purchasable_offer_unparseable"],
    ["maximum price", { text: "Standard maximum: $100.00" }, "purchasable_offer_unparseable"],
    ["max price", { text: "Standard max cost $100.00" }, "purchasable_offer_unparseable"],
    ["open-ended price", { text: "Standard $100.00 or more" }, "purchasable_offer_unparseable"],
    ["invalid price", { text: "Standard $0.00" }, "purchasable_offer_unparseable"],
    ["malformed price", { text: "Standard $1,20.00" }, "purchasable_offer_unparseable"],
  ])("rejects %s", (_label, overrides, reason) => {
    expect(normalizeSendCutSendOffers([container(overrides)], 2)).toMatchObject({
      ok: false,
      reason,
    });
  });

  it("rejects an invalid requested quantity", () => {
    expect(normalizeSendCutSendOffers([container()], 0)).toEqual({
      ok: false,
      reason: "purchasable_offer_unparseable",
      providerOptionId: null,
    });
  });

  it("rejects non-finite or zero derived prices", () => {
    expect(normalizeSendCutSendOffers([
      container({ text: `Standard per part: $1${"0".repeat(308)}` }),
    ], 2)).toMatchObject({ ok: false, reason: "purchasable_offer_unparseable" });
    expect(normalizeSendCutSendOffers([container({ text: "Standard $0.01" })], Number.MAX_SAFE_INTEGER))
      .toMatchObject({ ok: false, reason: "purchasable_offer_unparseable" });
  });

  it.each([
    "Standard $100.00 5-7 business days",
    "Standard $100.00 5–7 business days",
    "Standard $100.00 5—7 business days",
    "Standard $100.00 5 to 7 business days",
  ])("does not normalize a lead-time range endpoint: %s", (text) => {
    expect(normalizeSendCutSendOffers([container({ text })], 1)).toMatchObject({
      ok: true,
      offers: [{ leadTimeBusinessDays: null }],
    });
  });
});

describe("SendCutSend unavailable evidence", () => {
  it("filters only fixtures explicitly marked unavailable", () => {
    expect(normalizeSendCutSendOffers([
      container({
        availability: "unavailable",
        providerLabel: null,
        quoteRef: null,
        quoteUrl: null,
        text: "Contact support",
      }),
    ], 1)).toEqual({ ok: true, offers: [] });
  });

  it("filters multiple unavailable-only fixtures sharing an option ID", () => {
    expect(normalizeSendCutSendOffers([
      container({ availability: "unavailable", text: "Standard unavailable" }),
      container({
        availability: "unavailable",
        domMatchId: "dom-standard-secondary",
        text: "Standard currently unavailable",
      }),
    ], 1)).toEqual({ ok: true, offers: [] });
  });
});

describe("SendCutSend approved origin", () => {
  it.each([
    ["https://app.sendcutsend.com/", true],
    ["https://app.sendcutsend.com:443/", true],
    ["https://app.sendcutsend.com:8443/", false],
    ["http://app.sendcutsend.com/", false],
    ["https://sendcutsend.com/", false],
    ["https://quotes.sendcutsend.com/", false],
    ["https://app.sendcutsend.com.example.com/", false],
    ["https://user:secret@app.sendcutsend.com/", false],
    ["not a URL", false],
  ])("classifies %s", (url, expected) => {
    expect(isApprovedSendCutSendOrigin(url)).toBe(expected);
  });
});

describe("SendCutSend validity evidence", () => {
  it("retains explicit dates or durations and never invents missing evidence", () => {
    expect(parseSendCutSendValidityEvidence(
      "Quoted on 2026-08-27. Valid through 2026-09-10.",
    )).toMatchObject({
      quotedAt: "2026-08-27",
      validUntil: "2026-09-10",
      validitySource: "vendor_date",
    });
    expect(parseSendCutSendValidityEvidence("Valid for 14 days")).toMatchObject({
      validUntil: null,
      validityDurationDays: 14,
      validitySource: "vendor_duration",
    });
    expect(parseSendCutSendValidityEvidence("Valid until not-a-date")).toEqual({
      quotedAt: null,
      validUntil: null,
      validityDurationDays: null,
      validitySource: null,
      validityTerms: null,
    });
    expect(parseSendCutSendValidityEvidence("Valid until 2026-02-31")).toEqual({
      quotedAt: null,
      validUntil: null,
      validityDurationDays: null,
      validitySource: null,
      validityTerms: null,
    });
    expect(parseSendCutSendValidityEvidence("No validity shown")).toEqual({
      quotedAt: null,
      validUntil: null,
      validityDurationDays: null,
      validitySource: null,
      validityTerms: null,
    });
  });
});

describe("SendCutSend bounded pure error evidence", () => {
  it("redacts exact paths before bounding without a provider-capable helper side effect", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const sensitivePath = "/opt/Acme Defense/Project X/secret.step";
    const sanitized = safeSendCutSendEvaluationError(
      new Error(`${"x".repeat(970)}${sensitivePath} trailing detail`),
      [sensitivePath],
    );

    expect(sanitized.length).toBeLessThanOrEqual(1_000);
    expect(sanitized).toContain("<redacted-path>");
    expect(sanitized).not.toContain("Acme Defense");
    expect(sanitized).not.toContain("secret.step");
    expect(safeSendCutSendEvaluationError(
      new Error("failed at /srv/Project Alpha/private folder then stopped"),
      ["/srv/Project Alpha/private folder"],
    )).toBe("failed at <redacted-path> then stopped");
    expect(safeSendCutSendEvaluationError(new Error("failed at /mnt/private/part.step")))
      .not.toContain("/mnt/private");
    const genericPaths = safeSendCutSendEvaluationError(new Error(
      "failed at /opt/Acme Defense/Project X/other part.step; then retry denied "
      + "C:\\Acme Defense\\Project X\\drawing file.dxf, no disclosure occurred",
    ));
    expect(genericPaths).not.toContain("Acme Defense");
    expect(genericPaths).not.toContain("other part.step");
    expect(genericPaths).not.toContain("drawing file.dxf");
    expect(genericPaths).toContain("then retry denied");
    expect(genericPaths).toContain("no disclosure occurred");
    const extensionlessPaths = safeSendCutSendEvaluationError(new Error(
      "failed at /opt/Acme Defense/Project X/private model; retry denied "
      + "C:\\Acme Defense\\Project X\\private drawing, no disclosure occurred",
    ));
    expect(extensionlessPaths).not.toContain("Acme Defense");
    expect(extensionlessPaths).not.toContain("private model");
    expect(extensionlessPaths).not.toContain("private drawing");
    expect(extensionlessPaths).toContain("retry denied");
    expect(extensionlessPaths).toContain("no disclosure occurred");
    expect(fetchSpy).not.toHaveBeenCalled();

    const moduleSource = await fs.readFile(new URL("./sendcutsend.ts", import.meta.url), "utf8");
    expect(moduleSource).not.toMatch(
      /stageLiveEvaluationFiles|playwright|puppeteer|chromium|fetch\s*\(|page\.(?:goto|click)|request\.(?:get|post)/i,
    );
  });
});

describe("SendCutSend finite manifest-bound evaluation", () => {
  const liveConfig = { workerMode: "live" } as WorkerConfig;

  it("terminates an eligible authorized envelope without provider interaction or an offer", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { authorizedInput } = await authorizedAdapterInput();
    const adapter = new SendCutSendAdapter("sendcutsend", liveConfig);

    const result = await adapter.quote(authorizedInput);

    expect(result).toMatchObject({
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      quoteUrl: null,
      offers: [],
      artifacts: [],
      rawPayload: {
        source: "sendcutsend-evaluation-preflight",
        detectedFlow: "provider_configuration_contract_uncertified",
        evidenceTrust: "evaluation_only_untrusted",
        customerLiveOfferEligible: false,
        persistenceEligible: false,
        providerInteractionAttempted: false,
        disclosureAttempted: false,
        configurationAttempted: false,
        quoteAcquisitionAttempted: false,
        orderAttempted: false,
        sessionIsolation: "not_started",
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns finite manual follow-up when the local envelope denies geometry", async () => {
    const { authorizedInput } = await authorizedAdapterInput({ eligibleGeometry: false });
    const adapter = new SendCutSendAdapter("sendcutsend", liveConfig);

    const result = await adapter.quote(authorizedInput);

    expect(result.rawPayload).toMatchObject({
      detectedFlow: "outside_certified_cnc_envelope",
      disclosureAttempted: false,
      envelopeDecision: {
        eligible: false,
        denialCodes: expect.arrayContaining(["geometry_too_small"]),
      },
    });
    expect(result.offers).toEqual([]);
  });

  it.each([
    ["missing", null, "evaluation_manifest_invalid"],
    ["inexact", { unexpected: true }, "evaluation_manifest_invalid"],
  ])("fails finitely for a %s manifest", async (_label, evaluationManifest, reason) => {
    const { authorizedInput } = await authorizedAdapterInput({ manifest: evaluationManifest });
    const adapter = new SendCutSendAdapter("sendcutsend", liveConfig);

    const result = await adapter.quote(authorizedInput);

    expect(result.rawPayload).toMatchObject({
      detectedFlow: reason,
      providerInteractionAttempted: false,
      disclosureAttempted: false,
    });
  });

  it.each([
    ["digest", (value: SendCutSendEvaluationManifest) => ({
      ...value,
      cadSha256: "f".repeat(64),
    })],
    ["filename", (value: SendCutSendEvaluationManifest) => ({
      ...value,
      cadFileName: "other.step",
    })],
    ["quantity", (value: SendCutSendEvaluationManifest) => ({
      ...value,
      quantities: [5],
    })],
    ["requirement", (value: SendCutSendEvaluationManifest) => ({
      ...value,
      material: "6061-T6 aluminum" as const,
    })],
  ])("fails finitely when the manifest %s binding does not match", async (_label, mutate) => {
    const { authorizedInput } = await authorizedAdapterInput();
    const snapshot = authorizedInput.requirement.spec_snapshot as Record<string, unknown>;
    const currentManifest = snapshot.evaluationManifest as SendCutSendEvaluationManifest;
    snapshot.evaluationManifest = mutate(currentManifest);
    if (_label === "requirement") {
      authorizedInput.requirement.material = "7075 aluminum";
    }
    const adapter = new SendCutSendAdapter("sendcutsend", liveConfig);

    const result = await adapter.quote(authorizedInput);

    expect(result.rawPayload).toMatchObject({
      detectedFlow: "evaluation_manifest_binding_mismatch",
      providerInteractionAttempted: false,
    });
  });

  it("rejects forged CAD digest metadata mutated after byte authorization", async () => {
    const { authorizedInput } = await authorizedAdapterInput();
    const forgedDigest = "f".repeat(64);
    const authorization = authorizedInput.liveEvaluationAuthorization!;
    authorization.cadFileSha256 = forgedDigest;
    const snapshot = authorizedInput.requirement.spec_snapshot as Record<string, unknown>;
    snapshot.evaluationManifest = {
      ...(snapshot.evaluationManifest as SendCutSendEvaluationManifest),
      cadSha256: forgedDigest,
    };
    const adapter = new SendCutSendAdapter("sendcutsend", liveConfig);

    const result = await adapter.quote(authorizedInput);

    expect(result.rawPayload).toMatchObject({
      detectedFlow: "evaluation_manifest_binding_mismatch",
      providerInteractionAttempted: false,
      disclosureAttempted: false,
    });
  });

  it("rejects forged drawing digest metadata mutated after byte authorization", async () => {
    const { authorizedInput } = await authorizedAdapterInput({ drawing: true });
    const forgedDigest = "e".repeat(64);
    const authorization = authorizedInput.liveEvaluationAuthorization!;
    authorization.drawingFileSha256 = forgedDigest;
    const snapshot = authorizedInput.requirement.spec_snapshot as Record<string, unknown>;
    snapshot.evaluationManifest = {
      ...(snapshot.evaluationManifest as SendCutSendEvaluationManifest),
      drawingSha256: forgedDigest,
    };
    const adapter = new SendCutSendAdapter("sendcutsend", liveConfig);

    const result = await adapter.quote(authorizedInput);

    expect(result.rawPayload).toMatchObject({
      detectedFlow: "evaluation_manifest_binding_mismatch",
      providerInteractionAttempted: false,
      disclosureAttempted: false,
    });
  });

  it("rejects production dispatch before evaluation-file access", async () => {
    const { input } = await authorizedAdapterInput({ executionContext: "production_dispatch" });
    input.stagedCadFile = {
      ...input.stagedCadFile!,
      localPath: "/path/that/must/not/be/read.step",
    };
    const adapter = new SendCutSendAdapter("sendcutsend", liveConfig);

    const result = await adapter.quote(input);

    expect(result.rawPayload).toMatchObject({
      executionContext: "production_dispatch",
      detectedFlow: "provider_neutral_authorization_unavailable",
      providerInteractionAttempted: false,
      disclosureAttempted: false,
      orderAttempted: false,
    });
  });
});
