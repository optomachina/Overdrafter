// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256File } from "../liveEvaluationFiles";
import { REVIEWED_PROVIDER_DISPATCH_ENVELOPES } from "../providerDispatchEnvelope";
import { ProviderAbortedError, withProviderAbortSignal } from "../providerAbort";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";
import {
  registerProductionPortalAuthorizationRefusals,
  registerProductionPortalRoutingRefusals,
  type ProductionPortalDefaultDenyHarness,
} from "../../test-support/productionPortalDefaultDeny";
import { quickpartsDispatchAuthorization, quickpartsDispatchEnvelope } from "../../test-support/quickpartsDispatchFixture";
import { oshcutDispatchAuthorization, oshcutDispatchEnvelope } from "../../test-support/oshcutDispatchFixture";
import { buildAdapterRegistry } from "./index";
import { OSHCUT_DISPATCH_ENVELOPE, oshcutDispatchAuthorizationDenial } from "./oshcutDispatchAuthorization";
import {
  buildOshcutProductionPortalDefinition,
  extractOshcutProductionOffers,
  OSHCUT_ALLOWED_HOSTS,
  OSHCUT_PRODUCTION_LOCATORS,
} from "./oshcutProductionPortal";
import { normalizeAnchoredProviderOffers, runProviderPortalKernel, type ProviderPortalReadCapability } from "./providerPortalKernel";

/**
 * OVD-677: the production OSH Cut branch is default-off. Without a current
 * generic provider-dispatch authorization for the OSH Cut envelope, bound to
 * the staged bytes and quantity, there is zero provider interaction: no
 * session is read and no browser launches. The envelope is not reviewed in
 * code, so no real permit can name it. Synthetic data only.
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
  spec_snapshot: { process: "Laser Cutting", geometryFamily: "flat_sheet" },
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
    envelopeId: OSHCUT_DISPATCH_ENVELOPE.id,
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

  it("keeps the OSH Cut envelope out of the reviewed dispatch envelopes", () => {
    expect(REVIEWED_PROVIDER_DISPATCH_ENVELOPES.filter((reviewed) => reviewed.provider === "oshcut")).toEqual([]);
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

type Card = { id: string; label: string; quantity: string; unit: string; total: string; currency: string; lead?: string };

/** A reader over synthetic cards addressed through the reviewed locator table. */
function cardReader(cards: Card[]): ProviderPortalReadCapability {
  const { card, fields, optionIdAttribute } = OSHCUT_PRODUCTION_LOCATORS;
  const cardAt = (selector: string) => {
    const match = new RegExp(`^${card.replace(/[[\]]/g, "\\$&")} >> nth=(\\d+)`).exec(selector);
    return match ? cards[Number(match[1])] : undefined;
  };
  const fieldOf = (selector: string): keyof Card | null => {
    const entry = Object.entries(fields).find(([, value]) => selector.endsWith(` >> ${value}`));
    if (!entry) return null;
    return ({ label: "label", quantity: "quantity", unitPrice: "unit", totalPrice: "total", currency: "currency", leadBusinessDays: "lead" } as const)[entry[0] as keyof typeof fields];
  };
  return {
    count: async (selector) => (selector === card ? cards.length : 0),
    readText: async (selector) => {
      const current = cardAt(selector);
      const field = fieldOf(selector);
      return current && field ? current[field] ?? null : null;
    },
    readTexts: async () => [],
    readAttribute: async (selector, attribute) =>
      attribute === optionIdAttribute ? cardAt(selector)?.id ?? null : null,
  };
}

const STANDARD: Card = { id: "standard", label: "Standard", quantity: "3", unit: "$411.50", total: "$1,234.50", currency: "USD", lead: "4" };

describe("OSH Cut production offer extraction (OVD-677)", () => {
  it("normalizes anchored USD cards into offers", async () => {
    const candidates = await extractOshcutProductionOffers(cardReader([
      STANDARD,
      { id: "expedited", label: "Expedited", quantity: "3", unit: "616.67", total: "1850.00", currency: "USD" },
    ]), 3);
    const offers = normalizeAnchoredProviderOffers(candidates, { expectedQuantity: 3, allowedHosts: OSHCUT_ALLOWED_HOSTS });
    expect(offers.map((offer) => [offer.providerOptionId, offer.unitPriceUsd, offer.totalPriceUsd, offer.leadTimeBusinessDays]))
      .toEqual([["standard", 411.5, 1234.5, 4], ["expedited", 616.67, 1850, null]]);
    expect(candidates[0].rawPayload).toEqual({
      adapterRevision: "oshcut-production-adapter.v1",
      locatorRevision: "oshcut-production-locators.v1",
    });
  });

  it.each([
    ["a non-USD currency", { currency: "EUR" }],
    ["a missing currency", { currency: "" }],
    ["a total that disagrees with unit times quantity", { total: "$1,300.00" }],
    ["another quantity", { quantity: "2" }],
    ["a duplicate option id", { id: "standard" }],
    ["an unpriced option", { unit: "Request quote" }],
  ])("withholds every offer when one card carries %s", async (_name, change) => {
    const second = { ...STANDARD, id: "second", ...change };
    expect(await extractOshcutProductionOffers(cardReader([STANDARD, second]), 3)).toEqual([]);
  });
});

describe("OSH Cut production registry and routing (OVD-677)", () => {
  it("is absent from a live worker that does not list oshcut", () => {
    const { config } = observedConfig();
    expect(buildAdapterRegistry({ ...config, workerLiveAdapters: ["xometry", "quickparts"] } as WorkerConfig).oshcut)
      .toBeUndefined();
  });

  registerProductionPortalRoutingRefusals(defaultDenyHarness());

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
