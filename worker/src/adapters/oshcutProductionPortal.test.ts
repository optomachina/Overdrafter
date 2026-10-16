// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256File } from "../liveEvaluationFiles";
import type { SupabaseClient } from "@supabase/supabase-js";
import { quoteWithRoutedDispatchPreflight } from "../dispatchRouting";
import {
  canonicalizeProviderDispatchEnvelope,
  fingerprintProviderDispatchEnvelope,
  REVIEWED_PROVIDER_DISPATCH_ENVELOPES,
} from "../providerDispatchEnvelope";
import { ProviderAbortedError, withProviderAbortSignal } from "../providerAbort";
import type { VendorQuoteAdapterInput, VendorQuoteAdapterOutput, WorkerConfig } from "../types";
import {
  registerProductionPortalAuthorizationRefusals,
  registerProductionPortalRoutingRefusals,
  type ProductionPortalDefaultDenyHarness,
} from "../../test-support/productionPortalDefaultDeny";
import { quickpartsDispatchAuthorization, quickpartsDispatchEnvelope } from "../../test-support/quickpartsDispatchFixture";
import { oshcutDispatchAuthorization, oshcutDispatchEnvelope } from "../../test-support/oshcutDispatchFixture";
import { buildAdapterRegistry } from "./index";
import { OSHCUT_DISPATCH_ENVELOPE, oshcutDispatchAuthorizationDenial } from "./oshcutDispatchAuthorization";
import { cleanupOshcutCart, OSHCUT_CART_CLEANUP_SELECTORS } from "./oshcutCartCleanup";
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
  type ProviderPortalCleanupCapability,
  type ProviderPortalConfigurationCapability,
  type ProviderPortalReadCapability,
} from "./providerPortalKernel";

/**
 * OVD-677: the production OSH Cut branch is default-off. Without a current
 * generic provider-dispatch authorization for the OSH Cut envelope, bound to
 * the staged bytes and quantity, there is zero provider interaction: no
 * session is read and no browser launches. The envelope is reviewed in code
 * (OVD-677), so a real permit can name it only behind an approved admission.
 * Synthetic data only.
 */

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const STORAGE_STATE = JSON.stringify({ cookies: [], origins: [] });

/** The only package the OSH Cut envelope admits: flat-sheet laser cutting in 6061-T6. */
const OSHCUT_REQUIREMENT = {
  material: "Aluminum 6061-T6",
  spec_snapshot: { process: "Laser Cutting", geometryFamily: "flat_sheet", sheetThicknessInch: 0.125 },
};

/** A live config whose session lookups are observable. */
function observedConfig() {
  const sessionRead = vi.fn(() => ({ oshcut: STORAGE_STATE }));
  const config = {
    workerMode: "live",
    workerLiveAdapters: ["oshcut"],
    workerTempDir: os.tmpdir(),
    browserTimeoutMs: 100,
    playwrightHeadless: true,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: false,
    vendorStorageStatePaths: {},
    vendorStorageStateDir: null,
  } as unknown as WorkerConfig;
  Object.defineProperty(config, "vendorStorageStateJson", { get: sessionRead, enumerable: true });
  return { config, sessionRead };
}

async function stagedCad(name = "part.step", bytes = "synthetic oshcut cad bytes") {
  // realpath: the kernel refuses symlinked path components (macOS /var -> /private/var).
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oshcut-production-")));
  tempDirs.push(dir);
  const localPath = path.join(dir, name);
  await fs.writeFile(localPath, bytes);
  return { originalName: name, localPath, storageBucket: "job-files", storagePath: `cad/${name}`, trustedContentSha256: await sha256File(localPath) };
}

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

function defaultDenyHarness(): ProductionPortalDefaultDenyHarness {
  return {
    vendor: "oshcut",
    envelopeId: "oshcut-quote-envelope",
    taskId: "00000000-0000-4000-8000-4912acd7fd0b",
    vendorQuoteResultId: "00000000-0000-4000-8000-4912acd7fd09",
    claimedAt: "2026-10-10T12:04:00.000Z",
    unauthorizedCadName: "part.stl",
    otherProviderAuthorization: (input: VendorQuoteAdapterInput) =>
      quickpartsDispatchAuthorization(quickpartsDispatchEnvelope({
        cadSha256: input.stagedCadFile!.trustedContentSha256!,
        requestedQuantity: 3,
      })),
    buildDefinition: buildOshcutProductionPortalDefinition,
    observedConfig,
    authorizedInput,
    stagedCad,
  };
}

describe("OSH Cut production dispatch envelope (OVD-677)", () => {
  it("declares its envelope on the production portal definition", () => {
    expect(buildOshcutProductionPortalDefinition().productionDispatch).toEqual({
      envelope: { ...OSHCUT_DISPATCH_ENVELOPE },
    });
  });

  it("lists the OSH Cut envelope as reviewed for generic dispatch (OVD-677 approval)", () => {
    expect(REVIEWED_PROVIDER_DISPATCH_ENVELOPES.filter((reviewed) => reviewed.provider === "oshcut")).toEqual([{
      provider: "oshcut",
      id: "oshcut-quote-envelope",
      version: 1,
      requiredAdmission: "generic_dispatch",
    }]);
  });

  it("accepts exactly the authorized bytes and quantity at the adapter seam", async () => {
    expect(oshcutDispatchAuthorizationDenial(await authorizedInput())).toBeNull();
  });
});

describe("OSH Cut production branch default-deny (OVD-677)", () => {
  registerProductionPortalAuthorizationRefusals(defaultDenyHarness());

  it.each([
    ["a material outside the envelope", { requirement: { ...OSHCUT_REQUIREMENT, material: "Aluminum 5052-H32" } }, 3, "material_outside_envelope"],
    ["a process outside the envelope", { requirement: { ...OSHCUT_REQUIREMENT, spec_snapshot: { process: "CNC Milling", geometryFamily: "flat_sheet" } } }, 3, "cnc_milling_not_supported"],
    ["formed sheet geometry", { requirement: { ...OSHCUT_REQUIREMENT, spec_snapshot: { process: "Laser Cutting", geometryFamily: "formed_sheet" } } }, 3, "geometry_outside_envelope"],
    ["a quantity above the envelope", { requestedQuantity: 10_001 }, 10_001, "quantity_outside_envelope"],
  ])("ends %s as unsupported before any session read or launch", async (_name, change, quantity, reason) => {
    const base = await authorizedInput();
    const envelope = oshcutDispatchEnvelope({ cadSha256: base.stagedCadFile!.trustedContentSha256!, requestedQuantity: quantity });
    const input = { ...base, ...change, providerDispatchAuthorization: oshcutDispatchAuthorization(envelope) } as VendorQuoteAdapterInput;
    const { config, sessionRead } = observedConfig();
    const launchBrowser = vi.fn();
    await expect(runProviderPortalKernel(buildOshcutProductionPortalDefinition(), config, input, { launchBrowser }))
      .resolves.toMatchObject({ state: "unsupported", reason, providerMutationPossible: false });
    expect(launchBrowser).not.toHaveBeenCalled();
    expect(sessionRead).not.toHaveBeenCalled();
  });

  it("ends an unconfirmed process as unavailable before any session read or launch", async () => {
    const input = await authorizedInput({ requirement: { ...OSHCUT_REQUIREMENT, spec_snapshot: {} } } as Partial<VendorQuoteAdapterInput>);
    const { config, sessionRead } = observedConfig();
    const launchBrowser = vi.fn();
    await expect(runProviderPortalKernel(buildOshcutProductionPortalDefinition(), config, input, { launchBrowser }))
      .resolves.toMatchObject({ state: "unavailable", reason: "process_confirmation_required" });
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

describe("OSH Cut cart configuration (OVD-677)", () => {
  it("opens the material slideover and checks the reviewed material and thickness filters", async () => {
    const configuration = cartConfiguration(ALL_CONTROLS);
    await configureOshcutCart(configuration, { requirement: OSHCUT_REQUIREMENT } as VendorQuoteAdapterInput, 0);
    expect(configuration.clicks).toEqual(ALL_CONTROLS);
  });

  it.each([
    ["the Select material link", "openMaterial", "oshcut_material_control_missing"],
    ["the 6061 T6 Aluminum filter", "materialFilter:6061 T6 Aluminum", "oshcut_material_option_missing"],
    ["the requested thickness filter", 'thicknessFilter:0.125"', "oshcut_thickness_option_missing"],
  ])("stops in selector drift when %s is missing", async (_name, missing, reason) => {
    const configuration = cartConfiguration(ALL_CONTROLS.filter((control) => control !== missing));
    await expect(configureOshcutCart(configuration, { requirement: OSHCUT_REQUIREMENT } as VendorQuoteAdapterInput, 0))
      .rejects.toMatchObject({ payload: { terminalState: "selector_drift", reason, providerMutationPossible: true } });
  });

  it("stops in configuration required, clicking nothing, when the thickness is unknown", async () => {
    const configuration = cartConfiguration(ALL_CONTROLS);
    const requirement = { ...OSHCUT_REQUIREMENT, spec_snapshot: { process: "Laser Cutting", geometryFamily: "flat_sheet" } };
    await expect(configureOshcutCart(configuration, { requirement } as unknown as VendorQuoteAdapterInput, 0))
      .rejects.toMatchObject({ payload: { terminalState: "configuration_required", reason: "oshcut_thickness_unknown" } });
    expect(configuration.clicks).toEqual([]);
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

  registerProductionPortalRoutingRefusals(defaultDenyHarness());

  it("hands a database-admitted, owner-approved OSH Cut decision to the adapter", async () => {
    const input = await authorizedInput({ providerDispatchAuthorization: undefined });
    const envelope = oshcutDispatchEnvelope({ cadSha256: input.stagedCadFile!.trustedContentSha256!, requestedQuantity: 3 });
    const fingerprint = fingerprintProviderDispatchEnvelope(envelope);
    const admitted = {
      schema: "provider-dispatch-authorization.v1",
      authorized: true,
      permitId: envelope.permit.permitId,
      provider: "oshcut",
      envelopeFingerprint: fingerprint,
      canonicalEnvelope: canonicalizeProviderDispatchEnvelope(envelope),
      expiresAt: envelope.expiresAt,
      sessionBindingId: envelope.sessionBindingId,
      evidence: {
        now: "2026-10-10T12:05:00.000Z",
        permitState: "active",
        admission: {
          policy_present: true, provider_admitted: true, generically_dispatchable: true,
          provider: "oshcut", admission_state: "approved",
          policy_revision: envelope.admission.policyRevision,
          evidence_reference: envelope.admission.evidenceReference,
          permission_basis: "owner_approved",
          supported_processes: ["laser_cutting"], accepted_file_extensions: ["dxf", "step"],
          session_owner: "overdrafter_managed", reviewed_at: "2026-10-10T11:00:00+00:00",
          expires_at: null, reason_code: "provider_approved",
        },
        rollout: { capability: "automatic_quote_collection", enabled: true, revision: envelope.rollout.revision },
      },
    };
    const quote = vi.fn().mockResolvedValue({ artifacts: [] } as unknown as VendorQuoteAdapterOutput);
    await expect(quoteWithRoutedDispatchPreflight({
      supabase: { rpc: vi.fn().mockResolvedValue({ data: admitted, error: null }) } as unknown as SupabaseClient,
      config: { workerMode: "live", workerName: "worker-1" },
      task: {
        id: envelope.task.workQueueTaskId,
        payload: { providerDispatchPermitId: envelope.permit.permitId, providerDispatchEnvelopeFingerprint: fingerprint },
      },
      vendorQuoteResultId: envelope.task.vendorQuoteResultId,
      claimedAt: "2026-10-10T12:04:00.000Z",
      vendor: "oshcut",
      scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: "oshcut" },
      adapter: { quote },
      quoteInput: input,
      killSwitchReader: async (provider) => ({
        schema: "provider-kill-switch-state.v1", provider, engaged: false, globalEngaged: false,
      }),
    })).resolves.toEqual({ artifacts: [] });
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it("stops an aborted authorized run before any session read or launch (OVD-748)", async () => {
    const launch = vi.spyOn(chromium, "launch");
    const { config, sessionRead } = observedConfig();
    const controller = new AbortController();
    controller.abort();
    const adapter = buildAdapterRegistry(config).oshcut!;
    await expect(adapter.quote(withProviderAbortSignal(await authorizedInput(), controller.signal)))
      .rejects.toBeInstanceOf(ProviderAbortedError);
    expect(launch).not.toHaveBeenCalled();
    expect(sessionRead).not.toHaveBeenCalled();
  });

  it("declares the same hosts as the governed egress contract", async () => {
    const { STABLE_EGRESS_PROVIDER_HOSTS } = await import("../../../scripts/xometry-stable-egress-contract.mjs");
    expect([...STABLE_EGRESS_PROVIDER_HOSTS.oshcut]).toEqual([...OSHCUT_ALLOWED_HOSTS]);
    expect([...buildOshcutProductionPortalDefinition().allowedHosts]).toEqual([...OSHCUT_ALLOWED_HOSTS]);
  });
});

/** A cart of rows by file name; `removable` controls whether the remove control exists. */
function fakeCart(rows: string[], options: { removable?: boolean; confirmRequired?: boolean } = {}) {
  const cart = [...rows];
  let pendingConfirm: string | null = null;
  const clicks: string[] = [];
  const capability: ProviderPortalCleanupCapability = {
    count: async (field, scopeText) => (field === "partRow" ? cart.filter((row) => row === scopeText).length : 0),
    click: async (field, scopeText) => {
      if (field === "removePart") {
        const index = cart.indexOf(scopeText ?? "");
        if (options.removable === false || index < 0) return false;
        clicks.push(`remove:${scopeText}`);
        if (options.confirmRequired) pendingConfirm = scopeText!;
        else cart.splice(index, 1);
        return true;
      }
      if (field === "confirmRemove" && pendingConfirm) {
        clicks.push("confirm");
        cart.splice(cart.indexOf(pendingConfirm), 1);
        pendingConfirm = null;
        return true;
      }
      return false;
    },
  };
  return { capability, cart, clicks };
}

describe("OSH Cut cart cleanup (standing rule, OVD-677)", () => {
  const input = { stagedCadFile: { originalName: "part.step" } } as VendorQuoteAdapterInput;

  it("is declared on the production definition with cart-scoped click rules", () => {
    const definition = buildOshcutProductionPortalDefinition();
    expect(definition.hooks.cleanup).toBe(cleanupOshcutCart);
    expect(definition.selectors.cleanup).toEqual({ ...OSHCUT_CART_CLEANUP_SELECTORS });
  });

  it("removes only the rows that show the uploaded file name", async () => {
    const { capability, cart } = fakeCart(["part.step", "customer-bracket.dxf"]);
    await expect(cleanupOshcutCart(capability, input)).resolves.toEqual({ removed: 1, remaining: 0 });
    expect(cart).toEqual(["customer-bracket.dxf"]);
  });

  it("confirms an in-page dialog when one appears", async () => {
    const { capability, cart, clicks } = fakeCart(["part.step"], { confirmRequired: true });
    await expect(cleanupOshcutCart(capability, input)).resolves.toEqual({ removed: 1, remaining: 0 });
    expect(clicks).toEqual(["remove:part.step", "confirm"]);
    expect(cart).toEqual([]);
  });

  it("reports a row it could not remove", async () => {
    const { capability } = fakeCart(["part.step"], { removable: false });
    await expect(cleanupOshcutCart(capability, input)).resolves.toEqual({ removed: 0, remaining: 1 });
  });

  it("reports nothing to remove when no row shows the file name", async () => {
    const { capability } = fakeCart(["customer-bracket.dxf"]);
    await expect(cleanupOshcutCart(capability, input)).resolves.toEqual({ removed: 0, remaining: 0 });
  });
});
