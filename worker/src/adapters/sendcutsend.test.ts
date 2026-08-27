// @vitest-environment node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { authorizeLiveEvaluationInput } from "../liveEvaluationFiles";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import {
  classifySendCutSendPortalState,
  isApprovedSendCutSendOrigin,
  normalizeSendCutSendOffers,
  parseSendCutSendValidityEvidence,
  SendCutSendAdapter,
  type SendCutSendQuoteContainer,
} from "./sendcutsend";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const planarSolidPath = path.resolve(currentDir, "fixtures/sendcutsend-planar-single-solid.step");
const tempDirs: string[] = [];

function makeConfig(overrides: Partial<WorkerConfig> = {}) {
  return {
    ...loadConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      WORKER_MODE: "live",
      WORKER_LIVE_ADAPTERS: "sendcutsend",
    }),
    ...overrides,
  };
}

function makeInput(overrides: Partial<VendorQuoteAdapterInput> = {}): VendorQuoteAdapterInput {
  return {
    organizationId: "org-1",
    quoteRunId: "run-1",
    requestedQuantity: 2,
    part: {
      id: "part-1",
      job_id: "job-1",
      organization_id: "org-1",
      name: "Bracket",
      normalized_key: "bracket",
      cad_file_id: "cad-1",
      drawing_file_id: null,
      quantity: 2,
    },
    cadFile: {
      id: "cad-1",
      job_id: "job-1",
      storage_bucket: "job-files",
      storage_path: "cad/bracket.step",
      original_name: "bracket.step",
      file_kind: "cad",
    },
    drawingFile: null,
    stagedCadFile: null,
    stagedDrawingFile: null,
    requirement: {
      id: "req-1",
      part_id: "part-1",
      description: "Bracket",
      part_number: "BRACKET-001",
      revision: "A",
      material: "6061-T6 aluminum",
      finish: "as machined",
      tightest_tolerance_inch: 0.005,
      quantity: 2,
      quote_quantities: [2],
      requested_by_date: null,
      applicable_vendors: ["sendcutsend"],
      spec_snapshot: { process: "CNC machining" },
    },
    ...overrides,
  };
}

async function makeAuthorizedInput(eligibleSize: boolean) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sendcutsend-test-"));
  tempDirs.push(tempDir);
  const source = await fs.readFile(planarSolidPath, "utf8");
  const stepContent = eligibleSize
    ? source.replaceAll("-1.", "-25.4").replaceAll("1.", "25.4")
    : source;
  const cadPath = path.join(tempDir, "bracket.step");
  await fs.writeFile(cadPath, stepContent, "utf8");
  const digest = createHash("sha256").update(stepContent).digest("hex");
  const input = makeInput({
    quoteRunId: "run-authorized",
    executionContext: "live_evaluation",
    liveEvaluationAuthorization: {
      nonExportControlled: true,
      cadFileSha256: digest,
      drawingFileSha256: null,
    },
    stagedCadFile: {
      originalName: "bracket.step",
      localPath: cadPath,
      storageBucket: "job-files",
      storagePath: "cad/bracket.step",
      trustedContentSha256: digest,
    },
  });

  const authorizedInput = await authorizeLiveEvaluationInput(input);
  if (!authorizedInput) {
    throw new Error("Test input did not satisfy live evaluation authorization.");
  }
  return authorizedInput;
}

function container(overrides: Partial<SendCutSendQuoteContainer> = {}): SendCutSendQuoteContainer {
  return {
    availability: "purchasable",
    domMatchId: "dom-standard",
    selector: "[data-testid='quote-option']",
    providerOptionId: "standard",
    providerLabel: "Standard",
    quoteRef: "SCS-101",
    quoteUrl: "https://app.sendcutsend.com/quotes/SCS-101",
    text: "Standard $120.00 5 business days",
    ...overrides,
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("SendCutSend complete-offer normalization", () => {
  it("preserves every unique provider-anchored purchasable option", () => {
    const normalized = normalizeSendCutSendOffers([
      container(),
      container({ domMatchId: "dom-rush", providerOptionId: "rush", providerLabel: "Rush", text: "Rush $80.00 per part 3 business days" }),
    ], 2);

    expect(normalized).toMatchObject({
      ok: true,
      offers: [
        { providerOptionId: "standard", unitPriceUsd: 60, totalPriceUsd: 120, leadTimeBusinessDays: 5 },
        { providerOptionId: "rush", unitPriceUsd: 80, totalPriceUsd: 160, leadTimeBusinessDays: 3 },
      ],
    });
  });

  it("collapses exact duplicate DOM matches but rejects conflicting duplicate provider IDs", () => {
    const exact = container();
    expect(normalizeSendCutSendOffers([exact, { ...exact }], 2)).toMatchObject({
      ok: true,
      offers: [{ providerOptionId: "standard" }],
    });
    expect(normalizeSendCutSendOffers([
      exact,
      container({ domMatchId: "dom-different", providerLabel: "Different", text: "Different $130.00" }),
    ], 2)).toEqual({
      ok: false,
      reason: "duplicate_provider_option_id",
      providerOptionId: "standard",
    });
  });

  it("fails the complete set when a purchasable card cannot normalize", () => {
    expect(normalizeSendCutSendOffers([
      container(),
      container({ domMatchId: "dom-ambiguous", providerOptionId: "ambiguous", text: "Was $150.00, now $125.00" }),
    ], 2)).toEqual({
      ok: false,
      reason: "purchasable_offer_unparseable",
      providerOptionId: "ambiguous",
    });
  });

  it("filters only cards explicitly marked unavailable", () => {
    expect(normalizeSendCutSendOffers([
      container({ availability: "unavailable", text: "Contact support" }),
    ], 1)).toEqual({ ok: true, offers: [] });
  });

  it("keeps provider ranges and absent validity truthful instead of inventing precision", () => {
    const normalized = normalizeSendCutSendOffers([
      container({ providerOptionId: null, providerLabel: "Economy", text: "Economy USD 99.00, 2-5 business days" }),
    ], 1);
    expect(normalized).toMatchObject({
      ok: true,
      offers: [{ providerOptionId: "Economy", leadTimeBusinessDays: null }],
    });
    expect(parseSendCutSendValidityEvidence("No validity shown")).toEqual({
      quotedAt: null,
      validUntil: null,
      validityDurationDays: null,
      validitySource: null,
      validityTerms: null,
    });
  });

  it("retains explicit provider dates or durations without deriving expiration", () => {
    expect(parseSendCutSendValidityEvidence("Quoted on 2026-08-26. This quote is valid through 2026-09-09.")).toMatchObject({
      quotedAt: "2026-08-26",
      validUntil: "2026-09-09",
      validitySource: "vendor_date",
    });
    expect(parseSendCutSendValidityEvidence("Valid for 14 days")).toMatchObject({
      validityDurationDays: 14,
      validitySource: "vendor_duration",
    });
  });

  it.each([
    ["captcha", "Verify you are human", "https://app.sendcutsend.com/", 0, 0],
    ["login_required", "Sign in with your password", "https://app.sendcutsend.com/login", 1, 0],
    ["quote_ready", "Quote options", "https://app.sendcutsend.com/quote", 0, 2],
    ["manual_review", "Engineering review required", "https://app.sendcutsend.com/quote", 0, 0],
    ["configuration_required", "Select material", "https://app.sendcutsend.com/quote", 0, 0],
    ["unknown", "Processing", "https://app.sendcutsend.com/quote", 0, 0],
  ])("classifies %s as a finite portal state", (state, bodyText, url, passwordInputCount, offerCount) => {
    expect(classifySendCutSendPortalState({ bodyText, url, passwordInputCount, offerCount })).toBe(state);
  });
});

describe("SendCutSend navigation and authorization boundary", () => {
  it.each([
    ["https://app.sendcutsend.com/", true],
    ["https://app.sendcutsend.com:443/", true],
    ["https://app.sendcutsend.com:8443/", false],
    ["http://app.sendcutsend.com/", false],
    ["https://sendcutsend.com/", false],
    ["https://quotes.sendcutsend.com/", false],
    ["https://app.sendcutsend.com.example.com/", false],
    ["not a URL", false],
  ])("allows only the exact HTTPS application origin for %s", (url, expected) => {
    expect(isApprovedSendCutSendOrigin(url)).toBe(expected);
  });

  it("rejects production dispatch before provider interaction", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const adapter = new SendCutSendAdapter("sendcutsend", makeConfig());

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "unexpected_ui_state",
      payload: {
        reason: "provider_neutral_authorization_unavailable",
        orderAttempted: false,
        source: "sendcutsend-provider-envelope",
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects out-of-envelope bytes without navigation, upload, submit, click, or order request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const adapter = new SendCutSendAdapter("sendcutsend", makeConfig());
    const result = await adapter.quote(await makeAuthorizedInput(false));

    expect(result).toMatchObject({
      status: "manual_vendor_followup",
      quoteUrl: null,
      artifacts: [],
      rawPayload: {
        manualFollowUpReason: "outside_certified_cnc_envelope",
        orderAttempted: false,
        sessionIsolation: "not_started",
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns finite unavailable when exact provider configuration/readback is uncertified", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const adapter = new SendCutSendAdapter("sendcutsend", makeConfig());
    const result = await adapter.quote(await makeAuthorizedInput(true));

    expect(result).toMatchObject({
      status: "manual_vendor_followup",
      totalPriceUsd: null,
      quoteUrl: null,
      artifacts: [],
      rawPayload: {
        source: "sendcutsend-evaluation-preflight",
        detectedFlow: "provider_configuration_contract_uncertified",
        manualFollowUpReason: "provider_configuration_contract_uncertified",
        orderAttempted: false,
        sessionIsolation: "not_started",
      },
    });
    expect(result.offers).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
