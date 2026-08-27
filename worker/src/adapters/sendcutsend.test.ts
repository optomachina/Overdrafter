// @vitest-environment node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const { launchMock } = vi.hoisted(() => ({
  launchMock: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: launchMock,
  },
}));

import { loadConfig } from "../config";
import { authorizeLiveEvaluationInput } from "../liveEvaluationFiles";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import {
  classifySendCutSendPortalState,
  normalizeSendCutSendOffers,
  parseSendCutSendValidityEvidence,
  SendCutSendAdapter,
  SENDCUTSEND_LOCATORS,
  type SendCutSendQuoteContainer,
} from "./sendcutsend";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const minimalSolidPath = path.resolve(
  currentDir,
  "../extraction/fixtures/minimal-solid.step",
);
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

function makeInput(
  overrides: Partial<VendorQuoteAdapterInput> = {},
): VendorQuoteAdapterInput {
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

async function makeAuthorizedInput(options: {
  eligibleSize: boolean;
  runId?: string;
}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sendcutsend-test-"));
  tempDirs.push(tempDir);
  const source = await fs.readFile(minimalSolidPath, "utf8");
  const stepContent = options.eligibleSize
    ? source.replaceAll("-1.", "-25.4").replaceAll("1.", "25.4")
    : source;
  const cadPath = path.join(tempDir, "bracket.step");
  await fs.writeFile(cadPath, stepContent, "utf8");
  const digest = createHash("sha256").update(stepContent).digest("hex");
  const input = makeInput({
    quoteRunId: options.runId ?? "run-authorized",
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

afterEach(async () => {
  launchMock.mockReset();
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("SendCutSend normalization", () => {
  it("preserves every unique provider-anchored purchasable option", () => {
    const containers: SendCutSendQuoteContainer[] = [
      {
        selector: '[data-testid*="quote-option"]',
        providerOptionId: "standard",
        providerLabel: "Standard",
        quoteRef: "SCS-101",
        quoteUrl: "https://app.sendcutsend.com/quotes/SCS-101",
        text: "Standard $120.00 5 business days",
      },
      {
        selector: '[data-testid*="quote-option"]',
        providerOptionId: "rush",
        providerLabel: "Rush",
        quoteRef: "SCS-101",
        quoteUrl: "https://app.sendcutsend.com/quotes/SCS-101",
        text: "Rush $80.00 per part 3 business days",
      },
      {
        selector: '[data-testid*="quote-option"]',
        providerOptionId: "rush",
        providerLabel: "Duplicate Rush",
        quoteRef: "SCS-101",
        quoteUrl: "https://app.sendcutsend.com/quotes/SCS-101",
        text: "Duplicate $75.00 3 business days",
      },
      {
        selector: '[data-testid*="quote-option"]',
        providerOptionId: "ambiguous",
        providerLabel: "Ambiguous",
        quoteRef: null,
        quoteUrl: null,
        text: "Was $150.00, now $125.00",
      },
    ];

    expect(normalizeSendCutSendOffers(containers, 2)).toEqual([
      expect.objectContaining({
        providerOptionId: "standard",
        providerLabel: "Standard",
        quoteRef: "SCS-101",
        unitPriceUsd: 60,
        totalPriceUsd: 120,
        leadTimeBusinessDays: 5,
        geographicOrigin: "unknown",
        provenance: expect.objectContaining({
          providerOptionIdSource: "attribute",
          priceSource: "selector",
          leadTimeSource: "selector",
          geographicOriginSource: "none",
        }),
      }),
      expect.objectContaining({
        providerOptionId: "rush",
        unitPriceUsd: 80,
        totalPriceUsd: 160,
        leadTimeBusinessDays: 3,
      }),
    ]);
  });

  it("keeps provider ranges and absent validity truthful instead of inventing precision", () => {
    const offers = normalizeSendCutSendOffers([
      {
        selector: "[data-test='quote-option']",
        providerOptionId: null,
        providerLabel: "Economy",
        quoteRef: null,
        quoteUrl: null,
        text: "Economy USD 99.00, 2-5 business days",
      },
    ], 1);

    expect(offers[0]).toMatchObject({
      providerOptionId: "Economy",
      leadTimeBusinessDays: null,
      provenance: { leadTimeSource: "none" },
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
    expect(
      parseSendCutSendValidityEvidence(
        "Quoted on 2026-08-26. This quote is valid through 2026-09-09.",
      ),
    ).toEqual({
      quotedAt: "2026-08-26",
      validUntil: "2026-09-09",
      validityDurationDays: null,
      validitySource: "vendor_date",
      validityTerms: "valid through 2026-09-09",
    });
    expect(parseSendCutSendValidityEvidence("Valid for 14 days")).toEqual({
      quotedAt: null,
      validUntil: null,
      validityDurationDays: 14,
      validitySource: "vendor_duration",
      validityTerms: "Valid for 14 days",
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

describe("SendCutSend authorization and session boundary", () => {
  it("rejects production dispatch before browser launch while provider-neutral preflight is absent", async () => {
    const adapter = new SendCutSendAdapter("sendcutsend", makeConfig());

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "unexpected_ui_state",
      payload: {
        reason: "provider_neutral_authorization_unavailable",
        orderAttempted: false,
      },
    });
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("rejects out-of-envelope authorized bytes without a browser or disclosure", async () => {
    const adapter = new SendCutSendAdapter("sendcutsend", makeConfig());
    const result = await adapter.quote(await makeAuthorizedInput({ eligibleSize: false }));

    expect(result).toMatchObject({
      status: "manual_vendor_followup",
      rawPayload: {
        manualFollowUpReason: "outside_certified_cnc_envelope",
        orderAttempted: false,
        envelopeDecision: {
          eligible: false,
          denialCodes: ["geometry_too_small"],
        },
      },
    });
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("requires a provider-isolated company session after exact envelope admission", async () => {
    const adapter = new SendCutSendAdapter("sendcutsend", makeConfig());

    await expect(
      adapter.quote(await makeAuthorizedInput({ eligibleSize: true })),
    ).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "login_required",
      payload: {
        reason: "missing_isolated_storage_state",
        orderAttempted: false,
      },
    });
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("converts browser startup failure into a finite structured failure", async () => {
    launchMock.mockRejectedValueOnce(new Error("browser unavailable"));
    const adapter = new SendCutSendAdapter("sendcutsend", makeConfig({
      vendorStorageStateJson: {
        sendcutsend: JSON.stringify({ cookies: [], origins: [] }),
      },
    }));

    await expect(
      adapter.quote(await makeAuthorizedInput({ eligibleSize: true })),
    ).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "unexpected_ui_state",
      payload: {
        reason: "unexpected_ui_state",
        orderAttempted: false,
      },
    });
  });

  it("opens and closes a fresh browser context for each authorized quote", async () => {
    const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    launchMock.mockImplementation(() => {
      const page = createQuotePage();
      const context = {
        close: vi.fn().mockResolvedValue(undefined),
        newPage: vi.fn().mockResolvedValue(page),
        setDefaultTimeout: vi.fn(),
        setDefaultNavigationTimeout: vi.fn(),
      };
      contexts.push(context);
      return Promise.resolve({
        close: vi.fn().mockResolvedValue(undefined),
        newContext: vi.fn().mockResolvedValue(context),
      });
    });

    const config = makeConfig({
      workerTempDir: await fs.mkdtemp(path.join(os.tmpdir(), "sendcutsend-artifacts-")),
      vendorStorageStateJson: {
        sendcutsend: JSON.stringify({ cookies: [], origins: [] }),
      },
    });
    tempDirs.push(config.workerTempDir);
    const adapter = new SendCutSendAdapter("sendcutsend", config);

    const first = await adapter.quote(await makeAuthorizedInput({ eligibleSize: true, runId: "run-1" }));
    const second = await adapter.quote(await makeAuthorizedInput({ eligibleSize: true, runId: "run-2" }));

    expect(first).toMatchObject({
      status: "instant_quote_received",
      totalPriceUsd: 120,
      unitPriceUsd: 60,
      rawPayload: {
        sessionIsolation: "fresh_context_per_quote",
        orderAttempted: false,
        offerCount: 2,
      },
    });
    expect(second.status).toBe("instant_quote_received");
    expect(first.offers).toHaveLength(2);
    expect(first.offers?.[0]?.rawPayload).toMatchObject({ requestedQuantity: 2 });
    expect(first.artifacts).toHaveLength(2);
    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(contexts).toHaveLength(2);
    expect(contexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
  });
});

type FakeLocatorOptions = {
  attributes?: Record<string, string>;
  count?: number;
  text?: string;
};

function makeLocator(options: FakeLocatorOptions = {}) {
  return {
    first() {
      return this;
    },
    nth() {
      return this;
    },
    async count() {
      return options.count ?? 0;
    },
    async innerText() {
      return options.text ?? "";
    },
    async getAttribute(name: string) {
      return options.attributes?.[name] ?? null;
    },
    locator(selector: string) {
      if (selector === "a[href]" && options.attributes?.href) {
        return makeLocator({ count: 1, attributes: { href: options.attributes.href } });
      }
      return makeLocator();
    },
    async setInputFiles() {
      return undefined;
    },
    async fill() {
      return undefined;
    },
    async press() {
      return undefined;
    },
  };
}

function makeGroup(locators: ReturnType<typeof makeLocator>[]) {
  return {
    first() {
      return locators[0] ?? makeLocator();
    },
    nth(index: number) {
      return locators[index] ?? makeLocator();
    },
    async count() {
      return locators.length;
    },
  };
}

function createQuotePage() {
  const options = [
    makeLocator({
      count: 1,
      attributes: {
        "data-quote-option-id": "standard",
        "aria-label": "Standard",
        "data-quote-ref": "SCS-101",
        href: "/quotes/SCS-101",
      },
      text: "Standard $120.00 5 business days",
    }),
    makeLocator({
      count: 1,
      attributes: {
        "data-quote-option-id": "rush",
        "aria-label": "Rush",
        "data-quote-ref": "SCS-101",
        href: "/quotes/SCS-101",
      },
      text: "Rush $80.00 per part 3 business days",
    }),
  ];

  return {
    async goto() {
      return undefined;
    },
    url() {
      return "https://app.sendcutsend.com/quotes/SCS-101";
    },
    locator(selector: string) {
      if (selector === "body") {
        return makeLocator({
          count: 1,
          text: "Quoted on 2026-08-26. Valid for 14 days.",
        });
      }
      if (selector === 'input[type="password"]') {
        return makeLocator();
      }
      if (selector === SENDCUTSEND_LOCATORS.uploadInputs[0]) {
        return makeGroup([makeLocator({ count: 1 })]);
      }
      if (selector === SENDCUTSEND_LOCATORS.quantityInputs[0]) {
        return makeGroup([makeLocator({ count: 1 })]);
      }
      if (selector === SENDCUTSEND_LOCATORS.optionContainers[0]) {
        return makeGroup(options);
      }
      return makeGroup([]);
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      return undefined;
    },
    async content() {
      return "<html><body>SendCutSend quote options</body></html>";
    },
    async screenshot() {
      return undefined;
    },
  };
}
