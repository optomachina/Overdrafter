import { OSHCUT_PORTAL_DISABLED_MESSAGE } from "./oshcutPortalDisabled";
// @vitest-environment node
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEWED_PROVIDER_DISPATCH_ENVELOPES } from "../providerDispatchEnvelope";
import { withProviderAbortSignal } from "../providerAbort";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import { expectAdmittedDecisionReachesAdapter, observedLiveConfig, productionCadStager } from "../../test-support/productionPortalTestHarness";
import { oshcutDispatchAuthorization, oshcutDispatchEnvelope } from "../../test-support/oshcutDispatchFixture";
import { buildAdapterRegistry } from "./index";
import { OSHCUT_DISPATCH_ENVELOPE, oshcutDispatchAuthorizationDenial } from "./oshcutDispatchAuthorization";
import { cleanupOshcutCart, reportOshcutCartCleanup, OSHCUT_CART_CLEANUP_SELECTORS } from "./oshcutCartCleanup";
import {
  buildOshcutProductionPortalDefinition,
  classifyOshcutPortalState,
  configureOshcutCart,
  extractOshcutProductionOffers,
  OSHCUT_ALLOWED_HOSTS,
  OSHCUT_PRODUCTION_LOCATORS,
} from "./oshcutProductionPortal";
import {
  normalizeAnchoredProviderOffers,
  runProviderPortalKernel,
  type ProviderPortalConfigurationCapability,
  type ProviderPortalReadCapability,
} from "./providerPortalKernel";

/**
 * OVD-677: the production OSH Cut branch is default-off. Without a current
 * generic provider-dispatch authorization for the OSH Cut envelope, bound to
 * the staged bytes and quantity, there is zero provider interaction: no
 * session is read and no browser launches. The envelope remains unreviewed,
 * so production routing refuses even a database-admitted decision.
 * Synthetic data only.
 */

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** The only package the OSH Cut envelope admits: flat-sheet laser cutting in 6061-T6. */
const OSHCUT_REQUIREMENT = {
  material: "Aluminum 6061-T6",
  spec_snapshot: { process: "Laser Cutting", geometryFamily: "flat_sheet", sheetThicknessInch: 0.125 },
};

const observedConfig = () => observedLiveConfig("oshcut");
const stagedCad = productionCadStager("oshcut", tempDirs);

async function authorizedInput(overrides: Partial<VendorQuoteAdapterInput> = {}): Promise<VendorQuoteAdapterInput> {
  const cad = await stagedCad();
  const envelope = oshcutDispatchEnvelope({ cadSha256: cad.trustedContentSha256, requestedQuantity: 3 });
  return {
    organizationId: envelope.subject.organizationId,
    quoteRunId: envelope.task.quoteRunId,
    requestedQuantity: 3,
    requirement: OSHCUT_REQUIREMENT,
    executionContext: "production_dispatch",
    stagedCadFile: cad,
    stagedDrawingFile: null,
    providerDispatchAuthorization: oshcutDispatchAuthorization(envelope),
    ...overrides,
  } as unknown as VendorQuoteAdapterInput;
}

describe("OSH Cut production dispatch envelope (OVD-677)", () => {
  it("declares its envelope on the production portal definition", () => {
    expect(buildOshcutProductionPortalDefinition().productionDispatch).toEqual({
      envelope: { ...OSHCUT_DISPATCH_ENVELOPE },
    });
  });

  it("keeps OSH Cut absent from the reviewed generic-dispatch allow-list", () => {
    expect(REVIEWED_PROVIDER_DISPATCH_ENVELOPES.filter((reviewed) => reviewed.provider === "oshcut")).toEqual([]);
  });

  it("accepts exactly the authorized bytes and quantity at the adapter seam", async () => {
    expect(oshcutDispatchAuthorizationDenial(await authorizedInput())).toBeNull();
  });
});

describe("OSH Cut production hard disable (OVD-1022)", () => {
  it("refuses an authorized package before session access or browser launch", async () => {
    const { config, sessionRead } = observedConfig();
    const launchBrowser = vi.fn();
    await expect(runProviderPortalKernel(buildOshcutProductionPortalDefinition(), config, await authorizedInput(), { launchBrowser }))
      .rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    expect(launchBrowser).not.toHaveBeenCalled();
    expect(sessionRead).not.toHaveBeenCalled();
  });
});

/** A reader over synthetic cart price cells; each call advances through `frames`. */
function cartReader(frames: Array<{ single: string[]; extended: string[] }>): ProviderPortalReadCapability & { reads: () => number } {
  let reads = 0;
  const frame = () => frames[Math.min(reads, frames.length - 1)];
  return {
    count: async () => 0,
    readText: async () => null,
    readTexts: async (selector) => {
      if (selector === OSHCUT_PRODUCTION_LOCATORS.singlePrice) return frame().single;
      if (selector === OSHCUT_PRODUCTION_LOCATORS.extendedPrice) {
        const texts = frame().extended;
        reads += 1;
        return texts;
      }
      return [];
    },
    readAttribute: async () => null,
    reads: () => reads,
  };
}

const priced = (single: string, extended: string) => ({ single: [single], extended: [extended] });

describe("OSH Cut production offer extraction (OVD-677)", () => {
  it("normalizes the priced cart row into one USD offer", async () => {
    const candidates = await extractOshcutProductionOffers(cartReader([priced("$411.50", "$1,234.50")]), 3, 0);
    const offers = normalizeAnchoredProviderOffers(candidates, { expectedQuantity: 3, allowedHosts: OSHCUT_ALLOWED_HOSTS });
    expect(offers.map((offer) => [offer.providerOptionId, offer.unitPriceUsd, offer.totalPriceUsd, offer.leadTimeBusinessDays]))
      .toEqual([["cart", 411.5, 1234.5, null]]);
    expect(candidates[0].rawPayload).toEqual({
      adapterRevision: "oshcut-production-adapter.v2",
      locatorRevision: "oshcut-production-locators.v2",
    });
  });

  it("waits while the cells read '-' and then reads the price", async () => {
    const reader = cartReader([priced("-", "-"), priced("-", "-"), priced("$5.00", "$15.00 USD")]);
    const candidates = await extractOshcutProductionOffers(reader, 3, 5_000);
    expect(candidates.map((candidate) => [candidate.unitPriceUsd.value, candidate.totalPriceUsd.value])).toEqual([[5, 15]]);
    expect(reader.reads()).toBe(3);
  });

  it("never parses '-': a price still pending at the bound stops in selector drift", async () => {
    await expect(extractOshcutProductionOffers(cartReader([priced("-", "-")]), 3, 300)).rejects.toMatchObject({
      code: "selector_failure",
      payload: { terminalState: "selector_drift", reason: "oshcut_price_pending", providerMutationPossible: true },
    });
  });

  it.each([
    ["no price cells", { single: [], extended: [] }],
    ["more than one cart row", { single: ["$5.00", "$6.00"], extended: ["$15.00", "$18.00"] }],
    ["a non-USD amount", priced("€5.00", "€15.00")],
    ["a currency code other than USD", priced("$5.00 CAD", "$15.00 CAD")],
    ["an extended price that disagrees with single times quantity", priced("$5.00", "$15.02")],
    ["an extended price for another quantity", priced("$5.00", "$5.00")],
    ["a non-price text", priced("Request quote", "$15.00")],
  ])("withholds the offer for %s", async (_name, frame) => {
    expect(await extractOshcutProductionOffers(cartReader([frame]), 3, 0)).toEqual([]);
  });

  it("accepts a one-cent rounding difference", async () => {
    const candidates = await extractOshcutProductionOffers(cartReader([priced("$3.33", "$10.00")]), 3, 0);
    expect(candidates).toHaveLength(1);
  });
});

/** A configuration capability whose clicks succeed only for the listed field/text pairs. */
function cartConfiguration(available: string[]): ProviderPortalConfigurationCapability & { clicks: string[] } {
  const clicks: string[] = [];
  return {
    fill: vi.fn(async () => false),
    select: vi.fn(async () => false),
    click: async (field, text) => {
      const key = text === undefined ? field : `${field}:${text}`;
      if (!available.includes(key)) return false;
      clicks.push(key);
      return true;
    },
    clicks,
  };
}

const ALL_CONTROLS = ["openMaterial", "materialFilter:6061 T6 Aluminum", 'thicknessFilter:0.125"'];

describe("OSH Cut cart configuration hard disable (OVD-1022)", () => {
  it("refuses before clicking any material or thickness control", async () => {
    const configuration = cartConfiguration(ALL_CONTROLS);
    await expect(configureOshcutCart(configuration, { requirement: OSHCUT_REQUIREMENT } as VendorQuoteAdapterInput, 0))
      .rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    expect(configuration.clicks).toEqual([]);
    expect(configuration.fill).not.toHaveBeenCalled();
    expect(configuration.select).not.toHaveBeenCalled();
  });
});

describe("OSH Cut portal state (OVD-677)", () => {
  const snapshot = (bodyText: string, url = "https://app.oshcut.com/cart") => ({ url, bodyText, passwordInputCount: 0 });

  it.each([
    ["the logged-out header Sign In control", "OSH Cut\nSign In\nUpload parts", "login_required"],
    ["session expired text", "Your session expired", "login_required"],
    ["a priced cart part", "Design check: Passed", "ready"],
    ["an unpriced part", "part.dxf\nSelect material\nAll parts need selected material and units to checkout", "configuration_required"],
    ["the open material slideover heading", "Select Material - part.dxf\n6061 T6 Aluminum\nSign out", "ready"],
  ])("classifies %s", (_name, bodyText, state) => {
    expect(classifyOshcutPortalState(snapshot(bodyText, "https://app.oshcut.com/cart/O-1f0e/P-2a3b"))).toBe(state);
  });

  it("refuses any other host", () => {
    expect(classifyOshcutPortalState(snapshot("Upload parts", "https://www.oshcut.com/cart"))).toBe("unexpected_origin");
  });

  it("routes every leg to the cart, never /login", () => {
    expect(Object.values(buildOshcutProductionPortalDefinition().routes)).toEqual([
      "https://app.oshcut.com/cart",
      "https://app.oshcut.com/cart",
      "https://app.oshcut.com/cart",
    ]);
  });
});

describe("OSH Cut production registry and routing (OVD-677)", () => {
  it("is absent from a live worker that does not list oshcut", () => {
    const { config } = observedConfig();
    expect(buildAdapterRegistry({ ...config, workerLiveAdapters: ["xometry", "quickparts"] } as WorkerConfig).oshcut)
      .toBeUndefined();
  });

  it("refuses even a database-admitted OSH Cut decision before the adapter launches", async () => {
    const input = await authorizedInput({ providerDispatchAuthorization: undefined });
    await expectAdmittedDecisionReachesAdapter({
      vendor: "oshcut",
      expectedDenial: "provider_envelope_unknown",
      envelope: oshcutDispatchEnvelope({ cadSha256: input.stagedCadFile!.trustedContentSha256!, requestedQuantity: 3 }),
      input,
      now: "2026-10-10T12:05:00.000Z",
      claimedAt: "2026-10-10T12:04:00.000Z",
      reviewedAt: "2026-10-10T11:00:00+00:00",
      permissionBasis: "owner_approved",
      supportedProcesses: ["laser_cutting"],
      acceptedFileExtensions: ["dxf", "step"],
    });
  });

  it("stops an aborted authorized run before any session read or launch (OVD-748)", async () => {
    const launch = vi.spyOn(chromium, "launch");
    const { config, sessionRead } = observedConfig();
    const controller = new AbortController();
    controller.abort();
    const adapter = buildAdapterRegistry(config).oshcut!;
    await expect(adapter.quote(withProviderAbortSignal(await authorizedInput(), controller.signal)))
      .rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    expect(launch).not.toHaveBeenCalled();
    expect(sessionRead).not.toHaveBeenCalled();
  });

  it("keeps its portal host constraint without enabling governed production egress", async () => {
    const { STABLE_EGRESS_PROVIDER_HOSTS } = await import("../../../scripts/xometry-stable-egress-contract.mjs");
    expect(STABLE_EGRESS_PROVIDER_HOSTS).not.toHaveProperty("oshcut");
    expect([...buildOshcutProductionPortalDefinition().allowedHosts]).toEqual([...OSHCUT_ALLOWED_HOSTS]);
  });
});

describe("OSH Cut cart cleanup (standing rule, OVD-677)", () => {
  it("never requests a remove or confirm action, even when a count is returned", async () => {
    const click = vi.fn();
    const count = vi.fn(async () => 3);
    await expect(cleanupOshcutCart({ count, click })).rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    expect(count).not.toHaveBeenCalled();
    expect(reportOshcutCartCleanup(3)).toEqual({ removed: 0, remaining: 3 });
    expect(click).not.toHaveBeenCalled();
  });

  it("declares only read-only candidate reporting on the production definition", () => {
    const definition = buildOshcutProductionPortalDefinition();
    expect(Object.keys(definition.selectors.cleanup ?? {})).toEqual(["partRow"]);
    expect(definition.selectors.cleanup?.partRow.reportOnly).toBe(true);
    expect(definition.hooks.cleanup).toBe(cleanupOshcutCart);
    expect(definition.selectors.cleanup).toEqual({ ...OSHCUT_CART_CLEANUP_SELECTORS });
    expect(definition.selectors.cleanupRow).toBe(OSHCUT_CART_CLEANUP_SELECTORS.partRow.selector);
  });
});
