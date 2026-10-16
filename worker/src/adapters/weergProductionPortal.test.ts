// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quoteWithRoutedDispatchPreflight } from "../dispatchRouting";
import { sha256File } from "../liveEvaluationFiles";
import {
  canonicalizeProviderDispatchEnvelope,
  fingerprintProviderDispatchEnvelope,
  WEERG_DISPATCH_ENVELOPE,
} from "../providerDispatchEnvelope";
import type { VendorQuoteAdapterInput, VendorQuoteAdapterOutput, WorkerConfig } from "../types";
import { quickpartsDispatchAuthorization, quickpartsDispatchEnvelope } from "../../test-support/quickpartsDispatchFixture";
import {
  registerProductionPortalAuthorizationRefusals,
  registerProductionPortalRoutingRefusals,
  type ProductionPortalDefaultDenyHarness,
} from "../../test-support/productionPortalDefaultDeny";
import { weergDispatchAuthorization, weergDispatchEnvelope } from "../../test-support/weergDispatchFixture";
import { buildAdapterRegistry } from "./index";
import type { LocalNativeCurrencyOffer } from "./localEvaluationResult";
import { providerDispatchAuthorizationDenial } from "./providerDispatchAuthorization";
import { normalizeAnchoredNativeOffers, runProviderPortalKernel, type ProviderPortalReadCapability } from "./providerPortalKernel";
import { productionNativeOfferDisposition } from "./productionNativeOffers";
import {
  buildWeergProductionPortalDefinition,
  createWeergPortalDefinition,
  extractWeergProductionOffers,
  isWeergEnvelopeMaterial,
  parseWeergAmount,
  WEERG_ALLOWED_HOSTS,
  WEERG_PRODUCTION_LOCATORS,
} from "./weergPortal";
import { providerDispatchReservation } from "../../test-support/providerDispatchReservation";

/**
 * OVD-675: the production Weerg branch is default-off. Without a current
 * generic provider-dispatch authorization for the Weerg envelope (reviewed in
 * code only in #655, not here), bound to the staged bytes and quantity, there
 * is zero provider interaction:
 * no session is read and no browser launches. EUR stays native and is never
 * relabelled as USD. Synthetic data only.
 */

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const STORAGE_STATE = JSON.stringify({ cookies: [], origins: [] });

/** A live config whose session lookups are observable. */
function observedConfig() {
  const sessionRead = vi.fn(() => ({ weerg: STORAGE_STATE }));
  const config = {
    workerMode: "live",
    workerLiveAdapters: ["weerg"],
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

async function stagedCad(name = "part.step", bytes = "synthetic weerg cad bytes") {
  // realpath: the kernel refuses symlinked path components (macOS /var -> /private/var).
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "weerg-production-")));
  tempDirs.push(dir);
  const localPath = path.join(dir, name);
  await fs.writeFile(localPath, bytes);
  return { originalName: name, localPath, storageBucket: "job-files", storagePath: `cad/${name}`, trustedContentSha256: await sha256File(localPath) };
}

async function authorizedInput(overrides: Partial<VendorQuoteAdapterInput> = {}): Promise<VendorQuoteAdapterInput> {
  const cad = await stagedCad();
  const envelope = weergDispatchEnvelope({ cadSha256: cad.trustedContentSha256, requestedQuantity: 3 });
  return {
    organizationId: envelope.subject.organizationId,
    quoteRunId: envelope.task.quoteRunId,
    requestedQuantity: 3,
    requirement: { material: "EN AW-6082 T6 aluminium" },
    executionContext: "production_dispatch",
    stagedCadFile: cad,
    stagedDrawingFile: null,
    providerDispatchAuthorization: weergDispatchAuthorization(envelope),
    ...overrides,
  } as unknown as VendorQuoteAdapterInput;
}

function defaultDenyHarness(): ProductionPortalDefaultDenyHarness {
  return {
    vendor: "weerg",
    envelopeId: "weerg-quote-envelope",
    taskId: "00000000-0000-4000-8000-00000000675b",
    vendorQuoteResultId: "00000000-0000-4000-8000-000000006759",
    claimedAt: "2026-10-11T12:04:00.000Z",
    unauthorizedCadName: "part.stl",
    otherProviderAuthorization: (input: VendorQuoteAdapterInput) => {
      const quickparts = quickpartsDispatchEnvelope({
        cadSha256: input.stagedCadFile!.trustedContentSha256!,
        requestedQuantity: 3,
      });
      return quickpartsDispatchAuthorization(quickparts);
    },
    buildDefinition: buildWeergProductionPortalDefinition,
    observedConfig,
    authorizedInput,
    stagedCad,
  };
}

describe("Weerg production dispatch envelope (OVD-675)", () => {
  it("declares the Weerg envelope on the production portal definition", () => {
    expect(buildWeergProductionPortalDefinition().productionDispatch).toEqual({
      envelope: { ...WEERG_DISPATCH_ENVELOPE },
    });
  });

  it("keeps the offline evaluation definition out of production dispatch", () => {
    expect(createWeergPortalDefinition().productionDispatch).toBeUndefined();
  });
});

describe("Weerg production branch default-deny (OVD-675)", () => {
  registerProductionPortalAuthorizationRefusals(defaultDenyHarness());

  it.each([
    ["a material outside the envelope", { requirement: { material: "6061-T6 aluminum" } }, "weerg_material_outside_envelope"],
    ["a quantity above the envelope", { requestedQuantity: 10_001 }, "quantity_outside_envelope"],
  ])("ends %s as unsupported before any session read or launch", async (_name, change, reason) => {
    const base = await authorizedInput();
    const quantity = (change as { requestedQuantity?: number }).requestedQuantity ?? 3;
    const envelope = weergDispatchEnvelope({ cadSha256: base.stagedCadFile!.trustedContentSha256!, requestedQuantity: quantity });
    const input = { ...base, ...change, providerDispatchAuthorization: weergDispatchAuthorization(envelope) } as VendorQuoteAdapterInput;
    const { config, sessionRead } = observedConfig();
    const launchBrowser = vi.fn();
    await expect(runProviderPortalKernel(buildWeergProductionPortalDefinition(), config, input, { launchBrowser }))
      .resolves.toMatchObject({ state: "unsupported", reason, providerMutationPossible: false });
    expect(launchBrowser).not.toHaveBeenCalled();
    expect(sessionRead).not.toHaveBeenCalled();
  });

  it("accepts exactly the authorized bytes and quantity at the adapter seam", async () => {
    expect(providerDispatchAuthorizationDenial(await authorizedInput(), {
      provider: "weerg", ...WEERG_DISPATCH_ENVELOPE,
    })).toBeNull();
  });
});

describe("Weerg envelope material (OVD-675)", () => {
  it.each(["6082", "EN AW-6082", "Aluminium 6082-T6", "AL6082"])("accepts %j", (material) => {
    expect(isWeergEnvelopeMaterial(material)).toBe(true);
  });
  it.each(["6061-T6", "60820", "16082", "", null, undefined])("refuses %j", (material) => {
    expect(isWeergEnvelopeMaterial(material)).toBe(false);
  });
});

describe("Weerg native amounts (OVD-675)", () => {
  it.each([
    ["12.50", "EUR", 12.5],
    ["12,50", "EUR", 12.5],
    ["€ 1.234,50", "EUR", 1234.5],
    ["1.234,50 €", "EUR", 1234.5],
    ["1 234,50 EUR", "EUR", 1234.5],
    ["€1,234.50", "EUR", 1234.5],
    ["37", "EUR", 37],
    ["$1,234.50", "USD", 1234.5],
    ["1234.50 USD", "USD", 1234.5],
  ] as const)("parses %j as %s", (text, currency, expected) => {
    expect(parseWeergAmount(text, currency)).toBe(expected);
  });

  it.each([
    ["1.234", "EUR", "grouping or decimals is ambiguous"],
    ["1,234", "EUR", "grouping or decimals is ambiguous"],
    ["1.234.50", "EUR", "decimal separator equals the group separator"],
    ["1,2", "EUR", "a single decimal digit"],
    ["$12.50", "EUR", "a USD symbol on an EUR anchor"],
    ["€12.50", "USD", "an EUR symbol on a USD anchor"],
    ["12.50 GBP", "EUR", "another currency code"],
    ["£12.50", "EUR", "another currency symbol"],
    ["â‚¬ 12,50", "EUR", "a mis-decoded euro sign"],
    ["0.00", "EUR", "a zero amount"],
    ["-12.50", "EUR", "a negative amount"],
    ["Request quote", "EUR", "text"],
    ["", "EUR", "an empty field"],
  ] as const)("refuses %j for %s (%s)", (text, currency) => {
    expect(parseWeergAmount(text, currency)).toBeNull();
  });
});

type Card = { id: string; label: string; quantity: string; unit: string; total: string; currency: string; lead?: string };

/** A reader over synthetic cards addressed through the reviewed locator table. */
function cardReader(cards: Card[]): ProviderPortalReadCapability {
  const { card, fields, optionIdAttribute } = WEERG_PRODUCTION_LOCATORS;
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

const EUR_CARD: Card = { id: "standard-10", label: "Standard", quantity: "3", unit: "€ 411,50", total: "€ 1.234,50", currency: "EUR", lead: "10" };

describe("Weerg production offer extraction (OVD-675)", () => {
  it("reads anchored EUR cards as native money, never as USD", async () => {
    const candidates = await extractWeergProductionOffers(cardReader([
      EUR_CARD,
      { id: "fast-5", label: "Fast", quantity: "3", unit: "616,67", total: "1850,00", currency: "EUR" },
    ]), 3);
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate).not.toHaveProperty("unitPriceUsd");
      expect(candidate).not.toHaveProperty("totalPriceUsd");
      expect(candidate.money.unitCurrency).toMatchObject({ value: "EUR", source: "selector" });
      expect(candidate.money.totalCurrency).toMatchObject({ value: "EUR", source: "selector" });
    }
    expect(candidates.map((candidate) => [candidate.providerOptionId, candidate.money.unitAmount.value, candidate.money.totalAmount.value, candidate.leadTimeBusinessDays.value]))
      .toEqual([["standard-10", 411.5, 1234.5, 10], ["fast-5", 616.67, 1850, null]]);
    const normalized = normalizeAnchoredNativeOffers(candidates, { expectedQuantity: 3, allowedHosts: WEERG_ALLOWED_HOSTS });
    expect(normalized.map((offer) => offer.money.currency)).toEqual(["EUR", "EUR"]);
  });

  it.each([
    ["mixed currencies", { currency: "USD", unit: "411.50", total: "1234.50" }],
    ["a bare currency symbol instead of an ISO code", { currency: "€" }],
    ["a lowercase currency code", { currency: "eur" }],
    ["a missing currency", { currency: "" }],
    ["an ambiguous amount", { unit: "1.234", total: "3.702" }],
    ["a total that disagrees with unit times quantity", { total: "€ 1.300,00" }],
    ["another quantity", { quantity: "2" }],
    ["a duplicate option id", { id: "standard-10" }],
    ["an unpriced option", { unit: "Request quote" }],
  ])("withholds every offer when one card carries %s", async (_name, change) => {
    const second = { ...EUR_CARD, id: "second", ...change };
    expect(await extractWeergProductionOffers(cardReader([EUR_CARD, second]), 3)).toEqual([]);
  });
});

function nativeOffer(currency: "EUR" | "USD", id = "standard-10"): LocalNativeCurrencyOffer {
  const anchor = (selector: string) => ({ source: "selector" as const, selector });
  return {
    providerOptionId: id, providerLabel: "Standard", quantity: 3,
    money: {
      currency, unitAmount: 411.5, totalAmount: 1234.5,
      provenance: { unitAmount: anchor("[u]"), totalAmount: anchor("[t]"), unitCurrency: anchor("[c]"), totalCurrency: anchor("[c]") },
    },
    leadTimeBusinessDays: 10, shipReceiveBy: null, tier: null, sourcing: null, geographicOrigin: "unknown",
    provenance: { containerSelector: "[card]", providerOptionIdSource: "attribute", leadTimeSource: "selector", geographicOriginSource: "none" },
    validUntil: null, validityDurationDays: null, validitySource: null, validityTerms: null, artifactRefs: [],
  };
}

describe("Production native-offer disposition (OVD-675)", () => {
  it("records EUR as explicit non-comparable native evidence without converting it", () => {
    const disposition = productionNativeOfferDisposition([nativeOffer("EUR")]);
    expect(disposition).toMatchObject({ comparable: false, currency: "EUR", reason: "native_currency_not_comparable" });
    expect(disposition && !disposition.comparable && disposition.offers[0].money).toMatchObject({
      currency: "EUR", unitAmount: 411.5, totalAmount: 1234.5,
    });
    expect(JSON.stringify(disposition)).not.toMatch(/PriceUsd/);
  });

  it("passes a provider-priced USD batch through unchanged as comparable USD offers", () => {
    const disposition = productionNativeOfferDisposition([nativeOffer("USD")]);
    expect(disposition).toMatchObject({
      comparable: true,
      currency: "USD",
      offers: [{
        providerOptionId: "standard-10", unitPriceUsd: 411.5, totalPriceUsd: 1234.5, leadTimeBusinessDays: 10,
        provenance: { priceSource: "selector" },
        rawPayload: { anchoredCurrency: "USD", currencyConversion: "none" },
      }],
    });
  });

  it("refuses an empty or mixed-currency batch", () => {
    expect(productionNativeOfferDisposition([])).toBeNull();
    expect(productionNativeOfferDisposition([nativeOffer("EUR"), nativeOffer("USD", "other")])).toBeNull();
  });
});

describe("Weerg production registry and routing (OVD-675)", () => {
  it("is absent from a live worker that does not list weerg", () => {
    const { config } = observedConfig();
    expect(buildAdapterRegistry({ ...config, workerLiveAdapters: ["xometry", "quickparts"] } as WorkerConfig).weerg)
      .toBeUndefined();
  });

  registerProductionPortalRoutingRefusals(defaultDenyHarness());

  it("hands a database-admitted Weerg decision to the adapter as an authorization it accepts", async () => {
    const input = await authorizedInput({ providerDispatchAuthorization: undefined });
    const envelope = weergDispatchEnvelope({
      cadSha256: input.stagedCadFile!.trustedContentSha256!, requestedQuantity: 3,
    });
    const fingerprint = fingerprintProviderDispatchEnvelope(envelope);
    const admitted = {
      schema: "provider-dispatch-authorization.v1",
      authorized: true,
      permitId: envelope.permit.permitId,
      provider: "weerg",
      envelopeFingerprint: fingerprint,
      canonicalEnvelope: canonicalizeProviderDispatchEnvelope(envelope),
      expiresAt: envelope.expiresAt,
      sessionBindingId: envelope.sessionBindingId,
      evidence: {
        now: "2026-10-11T12:05:00.000Z",
        permitState: "active",
        admission: {
          policy_present: true, provider_admitted: true, generically_dispatchable: true,
          provider: "weerg", admission_state: "approved",
          policy_revision: envelope.admission.policyRevision,
          evidence_reference: envelope.admission.evidenceReference,
          permission_basis: "written_provider_authorization",
          supported_processes: ["cnc_milling"], accepted_file_extensions: ["step", "stp"],
          session_owner: "overdrafter_managed", reviewed_at: "2026-10-11T11:00:00+00:00",
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
      claimedAt: "2026-10-11T12:04:00.000Z",
      vendor: "weerg",
      scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: "weerg" },
      adapter: { quote },
      quoteInput: input,
      reserveDispatch: async (provider) => providerDispatchReservation(provider),
      killSwitchReader: async (provider) => ({
        schema: "provider-kill-switch-state.v1", provider, engaged: false, globalEngaged: false,
      }),
    })).resolves.toEqual({ artifacts: [] });
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it("declares the same hosts as the governed egress contract", async () => {
    const { STABLE_EGRESS_PROVIDER_HOSTS } = await import("../../../scripts/xometry-stable-egress-contract.mjs");
    expect([...STABLE_EGRESS_PROVIDER_HOSTS.weerg]).toEqual([...WEERG_ALLOWED_HOSTS]);
    expect([...buildWeergProductionPortalDefinition().allowedHosts]).toEqual([...WEERG_ALLOWED_HOSTS]);
    expect([...createWeergPortalDefinition().allowedHosts]).toEqual([...WEERG_ALLOWED_HOSTS]);
  });
});
