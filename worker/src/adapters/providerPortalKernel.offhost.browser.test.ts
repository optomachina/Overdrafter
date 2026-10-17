// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authorizeLiveEvaluationInput, sha256File } from "../liveEvaluationFiles";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import {
  createLocalPortalBrowser,
  PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS,
  sandboxedChromiumLaunchOptions,
  type LocalPortalObserved,
} from "../../test-support/localPortalBrowserFixture";
import {
  buildExpectedProviderPortalApproval,
  classifyProviderPortalSnapshot,
  runProviderPortalKernel,
  type ProviderPortalDefinition,
  type ProviderPortalReadCapability,
} from "./providerPortalKernel";

/**
 * OVD-773: a fixture replay of an OSH Cut-like page. Real provider pages load
 * fonts, analytics, a RUM agent, and post a Datadog CSP report; the kernel must
 * block all of it quietly and still finish. Pages are served from a local
 * static fixture through the kernel's own route; nothing reaches the network.
 */
const FIXTURE_PAGE = fileURLToPath(new URL("../../test-support/fixtures/oshcut-telemetry-portal.html", import.meta.url));
const CAD_BYTES = "synthetic oshcut cad bytes for the off-host fixture";

async function anchoredNumber(reader: ProviderPortalReadCapability, selector: string): Promise<number | null> {
  const text = await reader.readText(selector);
  const value = Number((text ?? "").replace(/[^0-9.]/g, ""));
  return text && Number.isFinite(value) ? value : null;
}

function oshcutLikeDefinition(): ProviderPortalDefinition {
  return {
    provider: "oshcut",
    displayName: "OSH Cut",
    manifestRevision: "oshcut-manifest.fixture",
    envelopeRevision: "oshcut-envelope.fixture",
    adapterRevision: "oshcut-offhost-fixture.v1",
    accountMode: "company_controlled",
    routes: {
      publicUrl: "https://www.oshcut.com/",
      loginUrl: "https://app.oshcut.com/login",
      uploadUrl: "https://app.oshcut.com/",
    },
    allowedHosts: ["www.oshcut.com", "app.oshcut.com"],
    selectors: { cadUpload: "input[type='file']", quantity: "input[name='quantity']" },
    supportedFileExtensions: ["step"],
    terminalSignals: {
      login: [/\bsign in\b/i],
      captcha: [/captcha/i],
      manualReview: [/manual review/i],
      configurationRequired: [/select material/i],
      unavailable: [/temporarily unavailable/i],
    },
    requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
    hooks: {
      assessEligibility: () => ({ state: "eligible", reason: "fixture" }),
      configure: () => undefined,
      classifyPortalState: (snapshot) => classifyProviderPortalSnapshot(snapshot),
      extractOffers: async (reader) => {
        const unit = await anchoredNumber(reader, "[data-unit-price]");
        const total = await anchoredNumber(reader, "[data-total-price]");
        const lead = await anchoredNumber(reader, "[data-lead-days]");
        const quantity = await anchoredNumber(reader, "[data-quantity]");
        const id = await reader.readAttribute("[data-option-id]", "data-option-id");
        if (unit === null || total === null || quantity === null || !id) return [];
        return [{
          providerOptionId: id,
          providerLabel: await reader.readText("[data-option-label]"),
          quoteRef: null,
          quoteUrl: null,
          quantity,
          unitPriceUsd: { value: unit, source: "selector", selector: "[data-unit-price]" },
          totalPriceUsd: { value: total, source: "selector", selector: "[data-total-price]" },
          leadTimeBusinessDays: { value: lead, source: "selector", selector: "[data-lead-days]" },
          shipReceiveBy: null,
          tier: null,
          sourcing: null,
          geographicOrigin: null,
          geographicOriginSource: "none",
          containerSelector: `[data-option-id='${id}']`,
          providerOptionIdSource: "attribute",
          validUntil: null,
          validityDurationDays: null,
          validitySource: null,
          validityTerms: null,
          rawPayload: {},
        }];
      },
    },
  };
}

describe("provider portal kernel off-host boundary in a browser fixture (OVD-773)", () => {
  let browser: Browser;
  const tempDirs: string[] = [];
  beforeAll(async () => {
    browser = await chromium.launch(sandboxedChromiumLaunchOptions());
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function approvedInput(definition: ProviderPortalDefinition): Promise<VendorQuoteAdapterInput> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oshcut-offhost-"));
    tempDirs.push(dir);
    const cadPath = path.join(dir, "part.step");
    await fs.writeFile(cadPath, CAD_BYTES);
    const digest = await sha256File(cadPath);
    const authorized = await authorizeLiveEvaluationInput({
      executionContext: "live_evaluation",
      liveEvaluationAuthorization: { nonExportControlled: true, cadFileSha256: digest, drawingFileSha256: null },
      providerPortalExecutionScope: { cadPath, drawingPath: null, requestedQuantities: [5] },
      organizationId: "org-1",
      quoteRunId: "run-1",
      part: { id: "part-1", quantity: 5 },
      stagedCadFile: { originalName: "part.step", localPath: cadPath, trustedContentSha256: digest },
      stagedDrawingFile: null,
      requestedQuantity: 5,
      requirement: { quantity: 5, material: "6061 aluminum" },
    } as VendorQuoteAdapterInput);
    if (!authorized) throw new Error("fixture authorization failed");
    authorized.providerPortalApproval = buildExpectedProviderPortalApproval(definition, authorized)!;
    return authorized;
  }

  function config(): WorkerConfig {
    return {
      workerMode: "live",
      workerTempDir: os.tmpdir(),
      browserTimeoutMs: 5_000,
      playwrightHeadless: true,
      playwrightDisableSandbox: false,
      playwrightDisableDevShmUsage: false,
      vendorStorageStateJson: { oshcut: JSON.stringify({ cookies: [], origins: [] }) },
      vendorStorageStatePaths: {},
      vendorStorageStateDir: null,
    } as unknown as WorkerConfig;
  }

  it("blocks the Datadog CSP report, analytics, and fonts, records them, and completes", async () => {
    const definition = oshcutLikeDefinition();
    const observed: LocalPortalObserved = { requests: [], uploads: [] };
    const page = await fs.readFile(FIXTURE_PAGE, "utf8");
    const result = await runProviderPortalKernel(definition, config(), await approvedInput(definition), {
      launchBrowser: async () => createLocalPortalBrowser(browser, { pages: { "app.oshcut.com/": page } }, observed),
      captureEvidence: async () => [],
    });

    expect(result).toMatchObject({ state: "offers_extracted", providerMutationPossible: true });
    expect(result.offers.map((offer) => [offer.providerOptionId, offer.unitPriceUsd, offer.totalPriceUsd]))
      .toEqual([["laser-standard", 12, 60]]);
    // The file went only to the provider host.
    expect(observed.uploads.map((upload) => upload.toString("utf8"))).toEqual([CAD_BYTES]);

    const boundary = result.portalBoundary!;
    expect(boundary.blockedOffhostCount).toBeGreaterThan(0);
    expect(boundary.blockedOffhostByHost).toMatchObject({
      "csp-report.browser-intake-datadoghq.com": expect.any(Number),
      "www.google-analytics.com": expect.any(Number),
      "www.googletagmanager.com": expect.any(Number),
      "fonts.googleapis.com": expect.any(Number),
    });
    expect(boundary.blockedOffhostEvents.every((event) => event.event === "boundary.blocked_offhost")).toBe(true);
    // Host and resource type only: no path, query string, or key.
    expect(JSON.stringify(boundary)).not.toMatch(/dd-api-key|pubfixture|G-FIXTURE|\/api\/v2|\?/);
    expect(observed.requests.some((request) => request.includes("csp-report.browser-intake-datadoghq.com"))).toBe(true);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("still stops when the page navigates the main frame off the provider host", async () => {
    const definition = oshcutLikeDefinition();
    const observed: LocalPortalObserved = { requests: [], uploads: [] };
    const uploadLine = "await fetch(\"/api/upload\", { method: \"POST\", body: cad.files[0] });";
    const original = await fs.readFile(FIXTURE_PAGE, "utf8");
    expect(original).toContain(uploadLine);
    const page = original.replace(uploadLine, "location.assign(\"https://login.example-sso.com/authorize\"); return;");
    await expect(runProviderPortalKernel(definition, config(), await approvedInput(definition), {
      launchBrowser: async () => createLocalPortalBrowser(browser, { pages: { "app.oshcut.com/": page } }, observed),
      captureEvidence: async () => [],
    })).rejects.toMatchObject({
      payload: { terminalState: "unexpected_origin", reason: "unexpected_navigation:login.example-sso.com" },
    });
    expect(observed.requests).toContain("GET https://login.example-sso.com/authorize");
    expect(observed.uploads).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);
});
