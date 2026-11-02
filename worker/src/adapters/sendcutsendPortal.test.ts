// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeLiveEvaluationInput, sha256File } from "../liveEvaluationFiles";
import { VendorAutomationError, type VendorQuoteAdapterInput, type WorkerConfig } from "../types";
import {
  type ProviderPortalConfigurationCapability,
  type ProviderPortalReadCapability,
  type ProviderPortalSessionCapability,
  type ProviderPortalSessionCheckResult,
  runProviderPortalKernel,
} from "./providerPortalKernel";
import {
  assessSendCutSendSheetEligibility,
  buildSendCutSendSheetPortalDefinition,
  classifySendCutSendPortalState,
  configureSendCutSendSheet,
  extractSendCutSendSheetOffers,
  filterSendCutSendStorageState,
  inspectSendCutSendFlatPlate,
  newSendCutSendWizardWalk,
  SENDCUTSEND_ALLOWED_HOSTS,
  SENDCUTSEND_OFF_HOST_ALLOWLIST,
  SENDCUTSEND_SHEET_LOCATORS,
  SENDCUTSEND_SHEET_SELECTORS,
  type SendCutSendWizardWalk,
} from "./sendcutsendPortal";

const FAST = {
  processingWaitMs: 200, controlWaitMs: 50, priceWaitMs: 50, pollIntervalMs: 1,
  reclickAfterMs: 0, priceStableMs: 0, sessionSettleMs: 0, sessionWaitMs: 20,
};
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const PLATE_FIXTURE = new URL("./fixtures/sendcutsend-sheet-plate-0125.step", import.meta.url);

async function sheetInput(overrides: {
  cad?: string;
  cadName?: string;
  material?: string;
  spec?: Record<string, unknown>;
  quantity?: number;
  drawing?: boolean;
} = {}): Promise<VendorQuoteAdapterInput> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sendcutsend-sheet-test-"));
  tempDirs.push(tempDir);
  const cadName = overrides.cadName ?? "plate.step";
  const cadPath = path.join(tempDir, cadName);
  await fs.writeFile(cadPath, overrides.cad ?? await fs.readFile(PLATE_FIXTURE, "utf8"));
  const drawingPath = overrides.drawing ? path.join(tempDir, "plate.pdf") : null;
  if (drawingPath) await fs.writeFile(drawingPath, "drawing-bytes");
  const cadSha256 = await sha256File(cadPath);
  const drawingSha256 = drawingPath ? await sha256File(drawingPath) : null;
  const quantity = overrides.quantity ?? 1;
  const input: VendorQuoteAdapterInput = {
    executionContext: "live_evaluation",
    liveEvaluationAuthorization: { nonExportControlled: true, cadFileSha256: cadSha256, drawingFileSha256: drawingSha256 },
    organizationId: "org-sendcutsend-sheet",
    quoteRunId: "run-sendcutsend-sheet",
    requestedQuantity: quantity,
    part: {
      id: "part-sendcutsend-sheet",
      job_id: "job-sendcutsend-sheet",
      organization_id: "org-sendcutsend-sheet",
      name: "Plate",
      normalized_key: "plate",
      cad_file_id: "cad-sendcutsend-sheet",
      drawing_file_id: drawingPath ? "drawing-sendcutsend-sheet" : null,
      quantity,
    },
    cadFile: null,
    drawingFile: null,
    stagedCadFile: {
      originalName: cadName,
      localPath: cadPath,
      storageBucket: "evaluation-only",
      storagePath: `cad/${cadName}`,
      trustedContentSha256: cadSha256,
    },
    stagedDrawingFile: drawingPath ? {
      originalName: "plate.pdf",
      localPath: drawingPath,
      storageBucket: "evaluation-only",
      storagePath: "drawing/plate.pdf",
      trustedContentSha256: drawingSha256 ?? undefined,
    } : null,
    requirement: {
      id: "requirement-sendcutsend-sheet",
      part_id: "part-sendcutsend-sheet",
      description: "SendCutSend sheet evaluation",
      part_number: "PLATE-001",
      revision: "A",
      material: overrides.material ?? "6061-T6 aluminum",
      finish: "Mill finish",
      tightest_tolerance_inch: 0.005,
      quantity,
      quote_quantities: [quantity],
      requested_by_date: null,
      applicable_vendors: ["sendcutsend"],
      spec_snapshot: overrides.spec ?? {
        process: "sheet_laser_cutting",
        geometryFamily: "flat_sheet",
        sheetThicknessInch: 0.125,
      },
    },
  };
  const authorized = await authorizeLiveEvaluationInput(input);
  if (!authorized) throw new Error("test input authorization failed");
  return authorized;
}

describe("SendCutSend sheet portal definition", () => {
  it("declares exact hosts, no production dispatch and no cart or footer control", () => {
    const definition = buildSendCutSendSheetPortalDefinition();
    expect(definition.provider).toBe("sendcutsend");
    expect(definition.allowedHosts).toEqual(["app.sendcutsend.com", "main.realtime.ably.net"]);
    expect(definition.offHostAllowlist).toEqual(["cdn.sendcutsend.com"]);
    expect(definition.productionDispatch).toBeUndefined();
    expect(definition.selectors.quantity).toBeUndefined();
    expect(definition.selectors.drawingUpload).toBeUndefined();
    expect(definition.requirements).toEqual({ quoteOnly: true, orderProhibited: true, isolatedSession: true });
    const selectors = JSON.stringify(SENDCUTSEND_SHEET_SELECTORS);
    expect(selectors).not.toMatch(/cart|checkout|order|purchase|payment|quote-footer|is-sale/i);
    expect(Object.keys(SENDCUTSEND_SHEET_SELECTORS.configuration)).toEqual([
      "productionMethod", "materialGroup", "materialCategory", "materialType", "thickness", "quantity",
    ]);
  });

  it("refuses a production input before any browser launch or session read", async () => {
    const launch = vi.spyOn(chromium, "launch");
    const launchBrowser = vi.fn();
    const input = await sheetInput();
    await expect(runProviderPortalKernel(
      buildSendCutSendSheetPortalDefinition(),
      { workerTempDir: os.tmpdir(), browserTimeoutMs: 1_000 } as WorkerConfig,
      { ...input, executionContext: "production_dispatch" },
      { launchBrowser },
    )).rejects.toMatchObject({
      payload: { terminalState: "unsupported", reason: "exact_file_authorization_missing", providerInteractionAttempted: false },
    });
    expect(launch).not.toHaveBeenCalled();
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("refuses a live evaluation without the exact operator approval", async () => {
    const launchBrowser = vi.fn();
    await expect(runProviderPortalKernel(
      buildSendCutSendSheetPortalDefinition(),
      { workerTempDir: os.tmpdir(), browserTimeoutMs: 1_000 } as WorkerConfig,
      await sheetInput(),
      { launchBrowser },
    )).rejects.toMatchObject({ payload: { terminalState: "unsupported", reason: "exact_provider_approval_mismatch" } });
    expect(launchBrowser).not.toHaveBeenCalled();
  });
});

describe("SendCutSend sheet envelope", () => {
  it("admits the synthetic 0.125 in 6061-T6 plate", async () => {
    expect(assessSendCutSendSheetEligibility(await sheetInput())).toEqual({
      state: "eligible",
      reason: "sendcutsend_sheet_envelope_match",
    });
  });

  it.each([
    ["another material", { material: "5052-H32 aluminum" }, "sendcutsend_material_outside_sheet_envelope"],
    ["a CNC process", { spec: { process: "cnc_machining", geometryFamily: "flat_sheet", sheetThicknessInch: 0.125 } },
      "sendcutsend_process_outside_sheet_envelope"],
    ["another declared thickness", { spec: { process: "sheet_laser_cutting", geometryFamily: "flat_sheet", sheetThicknessInch: 0.25 } },
      "sendcutsend_thickness_outside_sheet_envelope"],
    ["a quantity above the evaluated range", { quantity: 101 }, "sendcutsend_quantity_outside_sheet_envelope"],
    ["a drawing", { drawing: true }, "sendcutsend_sheet_files_outside_envelope"],
    ["a DXF", { cadName: "plate.dxf" }, "sendcutsend_file_type_outside_sheet_envelope"],
  ])("refuses %s", async (_label, overrides, reason) => {
    expect(assessSendCutSendSheetEligibility(await sheetInput(overrides))).toEqual({ state: "unsupported", reason });
  });

  it("refuses a model whose thinnest dimension is not the stock thickness", async () => {
    const plate = await fs.readFile(PLATE_FIXTURE, "utf8");
    const thick = plate.replaceAll("1.5875", "3.175");
    expect(assessSendCutSendSheetEligibility(await sheetInput({ cad: thick }))).toEqual({
      state: "unsupported",
      reason: "sendcutsend_geometry_thickness_mismatch",
    });
  });

  it.each([
    ["tapered sides", (plate: string) => plate.replace(
      /CARTESIAN_POINT\('',\((-?12\.7),(-?6\.35),1\.5875\)\)/g,
      (_match: string, x: string, y: string) => `CARTESIAN_POINT('',(${Number(x) * 0.9},${y},1.5875))`,
    )],
    ["a vertex between the caps (wedge, pocket floor or step)", (plate: string) => plate.replace(
      /CARTESIAN_POINT\('',\(-12\.7,-6\.35,1\.5875\)\)/,
      "CARTESIAN_POINT('',(-12.7,-6.35,0.5))",
    )],
  ])("refuses a 0.125 in bounding box that is not a straight extrusion: %s", async (_label, mutate) => {
    const plate = await fs.readFile(PLATE_FIXTURE, "utf8");
    const changed = mutate(plate);
    expect(changed).not.toBe(plate);
    expect(inspectSendCutSendFlatPlate({ fileName: "plate.step", buffer: Buffer.from(changed) })).toBeNull();
    expect(assessSendCutSendSheetEligibility(await sheetInput({ cad: changed }))).toEqual({
      state: "unsupported",
      reason: "sendcutsend_sheet_geometry_unverified",
    });
  });

  it("matches cap profiles by tolerance, not by a rounding grid", async () => {
    const plate = await fs.readFile(PLATE_FIXTURE, "utf8");
    // Tolerance here is 2.54e-5 mm. Shift the low cap by 0.45 and the high cap by 0.55 tolerances in x:
    // the caps still match within tolerance, but a rounding grid would split them.
    const tolerance = 25.4 * 1e-6;
    const shifted = plate.replace(/CARTESIAN_POINT\('',\(([^)]*)\)\)/g, (_match: string, coordinates: string) => {
      const [x, y, z] = coordinates.split(",").map(Number);
      return `CARTESIAN_POINT('',(${x + (z > 0 ? 0.55 : 0.45) * tolerance},${y},${z}))`;
    });
    expect(shifted).not.toBe(plate);
    expect(inspectSendCutSendFlatPlate({ fileName: "plate.step", buffer: Buffer.from(shifted) })).toBeCloseTo(0.125, 9);
  });

  it("accepts a straight extrusion when two dimensions tie for thinnest", async () => {
    const plate = await fs.readFile(PLATE_FIXTURE, "utf8");
    const bar = plate.replaceAll("6.35", "1.5875");
    expect(inspectSendCutSendFlatPlate({ fileName: "bar.step", buffer: Buffer.from(bar) })).toBeCloseTo(0.125, 9);
  });

  it("measures the thickness of a straight extrusion", async () => {
    const plate = await fs.readFile(PLATE_FIXTURE);
    expect(inspectSendCutSendFlatPlate({ fileName: "plate.step", buffer: plate })).toBeCloseTo(0.125, 9);
  });

  it("refuses geometry the deterministic STEP reader cannot verify", async () => {
    const curved = await fs.readFile(new URL("./fixtures/sendcutsend-curved.step", import.meta.url), "utf8");
    expect(assessSendCutSendSheetEligibility(await sheetInput({ cad: curved }))).toEqual({
      state: "unsupported",
      reason: "sendcutsend_sheet_geometry_unverified",
    });
  });
});

describe("SendCutSend portal state", () => {
  const quote = "https://app.sendcutsend.com/customer#/quote";

  it.each([
    ["ready", { url: quote, bodyText: "Blaine W\nDrop up to 10 files here to get started" }, "ready"],
    ["logged out", { url: quote, bodyText: "LOGIN\nDrop up to 10 files here to get started" }, "login_required"],
    ["expired", { url: quote, bodyText: "Your session has expired" }, "login_required"],
    ["captcha", { url: quote, bodyText: "Verify you are human" }, "captcha"],
    ["Cloudflare challenge", { url: quote, bodyText: "Verifying you are human. This may take a few seconds." }, "captcha"],
    ["Cloudflare review", { url: quote, bodyText: "app.sendcutsend.com needs to review the security of your connection" }, "captcha"],
    ["custom quote", { url: quote, bodyText: "Subtotal:\nContact us for a custom quote" }, "manual_review"],
    ["other origin", { url: "https://sendcutsend.com/", bodyText: "" }, "unexpected_origin"],
    ["realtime origin", { url: "https://main.realtime.ably.net/", bodyText: "" }, "unexpected_origin"],
  ])("classifies %s", (_label, snapshot, state) => {
    expect(classifySendCutSendPortalState({ passwordInputCount: 0, ...snapshot })).toBe(state);
  });

  it("does not read the upload page's custom-quote card as a manual review", () => {
    expect(classifySendCutSendPortalState({
      url: quote,
      bodyText: "Custom quote\nHave something complex? We'll quote it for you.\nGET STARTED",
      passwordInputCount: 0,
    })).toBe("ready");
  });
});

type WizardStep = "processing" | "format" | "group" | "category" | "type" | "sku";

/** A synthetic wizard: one step visible at a time, as SendCutSend's tile view renders it. */
function fakeWizard(options: {
  start?: WizardStep;
  processingPolls?: number;
  thicknesses?: string[];
  quantityControl?: boolean;
  /** The first N type clicks report success but the wizard does not advance. */
  ignoredTypeClicks?: number;
  /** After the first type click, the wizard re-renders at the group step once. */
  bounceAfterType?: boolean;
} = {}) {
  let ignoredTypeClicks = options.ignoredTypeClicks ?? 0;
  let bounce = options.bounceAfterType ?? false;
  let step: WizardStep = options.start ?? "processing";
  let processingPolls = options.processingPolls ?? 0;
  const calls: string[] = [];
  const next: Record<string, [WizardStep, string, WizardStep]> = {
    productionMethod: ["format", "Sheet Cutting", "group"],
    materialGroup: ["group", "Metals", "category"],
    materialCategory: ["category", "Aluminum", "type"],
    materialType: ["type", "6061 T6 Aluminum", "sku"],
  };
  const state = { selected: null as string | null, quantity: null as string | null };
  const configuration: ProviderPortalConfigurationCapability = {
    click: async (field, text) => {
      if (step === "processing") {
        if (processingPolls-- <= 0) step = "format";
        return false;
      }
      if (field === "thickness") {
        if (step !== "sku" || !(options.thicknesses ?? [".125"]).includes(text ?? "")) return false;
        calls.push(`thickness:${text}`);
        state.selected = text ?? null;
        return true;
      }
      const rule = next[field];
      if (!rule || rule[0] !== step || rule[1] !== text) return false;
      calls.push(`${field}:${text}`);
      if (field === "materialType" && ignoredTypeClicks-- > 0) return true;
      if (field === "materialType" && bounce) {
        bounce = false;
        step = "group";
        return true;
      }
      step = rule[2];
      return true;
    },
    fill: async (field, value) => {
      if (field !== "quantity" || !state.selected || options.quantityControl === false) return false;
      calls.push(`quantity:${value}`);
      state.quantity = value;
      return true;
    },
    select: async () => false,
  };
  return { configuration, calls, state, step: () => step };
}

describe("SendCutSend wizard walk", () => {
  it("walks method, group, category, type and thickness in order, then sets the quantity", async () => {
    const wizard = fakeWizard({ processingPolls: 3 });
    const walk = newSendCutSendWizardWalk();
    await configureSendCutSendSheet(wizard.configuration, { requestedQuantity: 1 }, walk, FAST);
    expect(wizard.calls).toEqual([
      "productionMethod:Sheet Cutting",
      "materialGroup:Metals",
      "materialCategory:Aluminum",
      "materialType:6061 T6 Aluminum",
      "thickness:.125",
      "quantity:1",
    ]);
    expect(walk).toEqual({ typeSelected: true, thicknessSelected: true, sessionConfirmed: false });
  });

  it("starts from whichever step the wizard opens on", async () => {
    const wizard = fakeWizard({ start: "group" });
    const walk = newSendCutSendWizardWalk();
    await configureSendCutSendSheet(wizard.configuration, { requestedQuantity: 1 }, walk, FAST);
    expect(wizard.calls[0]).toBe("materialGroup:Metals");
    expect(walk.thicknessSelected).toBe(true);
  });

  it("does not trust a thickness picked under a type it did not choose", async () => {
    const wizard = fakeWizard({ start: "sku" });
    const walk = newSendCutSendWizardWalk();
    await configureSendCutSendSheet(wizard.configuration, { requestedQuantity: 1 }, walk, FAST);
    expect(walk).toEqual({ typeSelected: false, thicknessSelected: false, sessionConfirmed: false });
    expect(wizard.calls).toEqual(["thickness:.125"]);
  });

  it("re-clicks a type tile that ignored the click, then proves the walk", async () => {
    const wizard = fakeWizard({ start: "type", ignoredTypeClicks: 1 });
    const walk = newSendCutSendWizardWalk();
    await configureSendCutSendSheet(wizard.configuration, { requestedQuantity: 1 }, walk, FAST);
    expect(wizard.calls).toEqual(["materialType:6061 T6 Aluminum", "materialType:6061 T6 Aluminum", "thickness:.125", "quantity:1"]);
    expect(walk.thicknessSelected).toBe(true);
  });

  it("spaces re-clicks so a still-processing tile is not exhausted at once", async () => {
    const wizard = fakeWizard({ start: "type", ignoredTypeClicks: 5 });
    const walk = newSendCutSendWizardWalk();
    await configureSendCutSendSheet(wizard.configuration, { requestedQuantity: 1 }, walk, { ...FAST, reclickAfterMs: 1_000 });
    expect(wizard.calls).toEqual(["materialType:6061 T6 Aluminum"]);
    expect(walk.thicknessSelected).toBe(false);
  });

  it("clears the type when the wizard falls back to an earlier step", async () => {
    const wizard = fakeWizard({ start: "type", bounceAfterType: true });
    const walk = newSendCutSendWizardWalk();
    await configureSendCutSendSheet(wizard.configuration, { requestedQuantity: 1 }, walk, FAST);
    expect(wizard.calls).toEqual([
      "materialType:6061 T6 Aluminum",
      "materialGroup:Metals",
      "materialCategory:Aluminum",
      "materialType:6061 T6 Aluminum",
      "thickness:.125",
      "quantity:1",
    ]);
    expect(walk).toEqual({ typeSelected: true, thicknessSelected: true, sessionConfirmed: false });
  });

  it("never substitutes a neighbouring thickness", async () => {
    const wizard = fakeWizard({ start: "format", thicknesses: [".100", ".187"] });
    const walk = newSendCutSendWizardWalk();
    await configureSendCutSendSheet(wizard.configuration, { requestedQuantity: 1 }, walk, FAST);
    expect(walk).toEqual({ typeSelected: true, thicknessSelected: false, sessionConfirmed: false });
    expect(wizard.calls.some((call) => call.startsWith("thickness"))).toBe(false);
    expect(wizard.state.quantity).toBeNull();
  });

  it("ends the walk without a guess when no wizard step appears", async () => {
    const wizard = fakeWizard({ processingPolls: 10_000 });
    const walk = newSendCutSendWizardWalk();
    await configureSendCutSendSheet(wizard.configuration, { requestedQuantity: 1 }, walk, FAST);
    expect(wizard.calls).toEqual([]);
    expect(walk.thicknessSelected).toBe(false);
  });

  it("stops in selector drift when the quantity control never appears", async () => {
    const wizard = fakeWizard({ start: "format", quantityControl: false });
    await expect(configureSendCutSendSheet(wizard.configuration, { requestedQuantity: 1 }, newSendCutSendWizardWalk(), FAST))
      .rejects.toMatchObject({ payload: { terminalState: "selector_drift", reason: "sendcutsend_quantity_control_missing" } });
  });
});

const L = SENDCUTSEND_SHEET_LOCATORS;

/** Selector-keyed synthetic summary; each read can return the next value of a sequence. */
function fakeReader(texts: Record<string, string[] | string[][]>): ProviderPortalReadCapability & { reads: string[] } {
  const cursor = new Map<string, number>();
  const reads: string[] = [];
  const next = (selector: string): string[] => {
    reads.push(selector);
    const value = texts[selector];
    if (!value) return [];
    if (!Array.isArray(value[0])) return value as string[];
    const sequence = value as string[][];
    const index = cursor.get(selector) ?? 0;
    cursor.set(selector, index + 1);
    return sequence[Math.min(index, sequence.length - 1)];
  };
  return {
    reads,
    count: async (selector) => next(selector).length,
    readText: async (selector) => next(selector)[0] ?? null,
    readTexts: async (selector) => next(selector),
    readAttribute: async () => null,
  };
}

const walked: SendCutSendWizardWalk = { typeSelected: true, thicknessSelected: true, sessionConfirmed: true };
const CRUMBS = { [L.materialCrumbs]: ["Categories", "Metals", "Aluminum", "6061 T6 Aluminum"] };
/** A repricing summary that changes on every read. */
const ALTERNATING = Array.from({ length: 10_000 }, (_value, index) => [index % 2 === 0 ? "$31.40" : "$31.50"]);

describe("SendCutSend summary price", () => {
  it("returns one anchored USD offer once the price settles", async () => {
    const reader = fakeReader({
      ...CRUMBS,
      [L.selectedSkuTitles]: [".125"],
      [L.unitPrice]: [["$--"], ["$31.40"], ["$31.40"], ["$31.40"]],
      [L.totalPrice]: [["$0.00"], ["$31.40"], ["$31.40"], ["$31.40"]],
      [L.shipDate]: ["Ships as soon as: Oct 28"],
    });
    const offers = await extractSendCutSendSheetOffers(reader, 1, walked, FAST);
    expect(offers).toEqual([expect.objectContaining({
      providerOptionId: "ALU6061-125",
      providerOptionIdSource: "provider_label",
      quantity: 1,
      unitPriceUsd: { value: 31.4, source: "selector", selector: L.unitPrice },
      totalPriceUsd: { value: 31.4, source: "selector", selector: L.totalPrice },
      leadTimeBusinessDays: { value: null, source: "none", selector: null },
      containerSelector: L.summary,
      shipReceiveBy: "Oct 28",
      rawPayload: expect.objectContaining({ shipDateQualifier: "ships" }),
    })]);
  });

  it("checks the unit price against the subtotal at the requested quantity", async () => {
    const reader = fakeReader({
      ...CRUMBS,
      [L.selectedSkuTitles]: [".125"],
      [L.unitPrice]: ["$1,204.10"],
      [L.totalPrice]: ["$2,408.20"],
    });
    const [offer] = await extractSendCutSendSheetOffers(reader, 2, walked, FAST);
    expect(offer.unitPriceUsd.value).toBe(1204.1);
    expect(offer.totalPriceUsd.value).toBe(2408.2);
    expect(offer.shipReceiveBy).toBeNull();
  });

  it.each([
    ["a subtotal that disagrees", { [L.unitPrice]: ["$31.40"], [L.totalPrice]: ["$62.80"] },
      "selector_drift", "sendcutsend_price_arithmetic_mismatch"],
    ["a price that never settles", { [L.unitPrice]: ALTERNATING, [L.totalPrice]: ALTERNATING },
      "selector_drift", "sendcutsend_price_pending"],
    ["no price", { [L.unitPrice]: ["$--"], [L.totalPrice]: [] }, "selector_drift", "sendcutsend_price_pending"],
    ["two prices that persist", { [L.unitPrice]: ["$31.40", "$12.00"], [L.totalPrice]: ["$31.40"] }, "selector_drift", "sendcutsend_price_ambiguous"],
    ["a non-USD amount", { [L.unitPrice]: ["€31,40"], [L.totalPrice]: ["€31,40"] }, "selector_drift", "sendcutsend_price_pending"],
    ["a custom quote", { [L.subtotal]: ["Subtotal: Custom quote"] }, "manual_review", "sendcutsend_custom_quote"],
  ])("withholds the offer for %s", async (_label, texts, terminalState, reason) => {
    const reader = fakeReader({ ...CRUMBS, [L.selectedSkuTitles]: [".125"], ...texts });
    // Long enough for three reads under a loaded test runner; the never-settling cases run it out.
    await expect(extractSendCutSendSheetOffers(reader, 1, walked, { ...FAST, priceWaitMs: 300 }))
      .rejects.toMatchObject({ payload: { terminalState, reason, vendor: "sendcutsend" } });
  });

  const typed: SendCutSendWizardWalk = { typeSelected: true, thicknessSelected: false, sessionConfirmed: true };
  it.each([
    ["the thickness is disabled", typed, { ...CRUMBS, [L.disabledSkuTitles]: [".125"], [L.skuTitles]: [".100", ".125"] },
      "configuration_required", "sendcutsend_thickness_unavailable"],
    ["the thickness is not offered", typed, { ...CRUMBS, [L.skuTitles]: [".100", ".187"] },
      "configuration_required", "sendcutsend_thickness_not_offered"],
    ["a disabled .125 belongs to another type", typed,
      { [L.materialCrumbs]: ["Categories", "Metals", "Aluminum", "5052 H32 Aluminum"], [L.disabledSkuTitles]: [".125"] },
      "selector_drift", "sendcutsend_material_path_incomplete"],
    ["the walk never reached the stock", { ...newSendCutSendWizardWalk(), sessionConfirmed: true }, {}, "selector_drift", "sendcutsend_material_path_incomplete"],
    ["another thickness is selected", walked, { ...CRUMBS, [L.selectedSkuTitles]: [".100"], [L.skuTitles]: [".100", ".125"] },
      "selector_drift", "sendcutsend_material_path_incomplete"],
    ["the type was not chosen this run", { typeSelected: false, thicknessSelected: false, sessionConfirmed: true }, { ...CRUMBS, [L.selectedSkuTitles]: [".125"] },
      "selector_drift", "sendcutsend_material_path_incomplete"],
    ["the page shows another alloy", walked,
      { [L.materialCrumbs]: ["Categories", "Metals", "Aluminum", "5052 H32 Aluminum"], [L.selectedSkuTitles]: [".125"] },
      "selector_drift", "sendcutsend_material_unverified"],
    ["the page shows no material", walked, { [L.selectedSkuTitles]: [".125"] }, "selector_drift", "sendcutsend_material_unverified"],
    // OVD-1056 review: no price is read unless the pre-upload guard confirmed a non-guest session.
    ["the session was never confirmed", { ...walked, sessionConfirmed: false }, { ...CRUMBS, [L.selectedSkuTitles]: [".125"] },
      "login_required", "sendcutsend_session_unconfirmed"],
    ["the session signed out after upload", walked, { ...CRUMBS, [L.selectedSkuTitles]: [".125"], [L.visibleLoginLink]: ["LOGIN"] },
      "login_required", "sendcutsend_signed_out"],
  ])("stops before reading a price when %s", async (_label, walk, texts, terminalState, reason) => {
    const reader = fakeReader({ [L.unitPrice]: ["$31.40"], [L.totalPrice]: ["$31.40"], ...texts });
    await expect(extractSendCutSendSheetOffers(reader, 1, walk, FAST))
      .rejects.toMatchObject({ payload: { terminalState, reason } });
    expect(reader.reads).not.toContain(L.unitPrice);
  });

  it("waits out a transient duplicate price and requires a stable window", async () => {
    const reader = fakeReader({
      ...CRUMBS,
      [L.selectedSkuTitles]: [".125"],
      [L.unitPrice]: [["$31.40", "$30.00"], ["$31.40"], ["$31.40"], ["$31.40"]],
      [L.totalPrice]: [["$31.40"], ["$31.40"], ["$31.40"], ["$31.40"]],
    });
    const [offer] = await extractSendCutSendSheetOffers(reader, 1, walked, { ...FAST, priceWaitMs: 500, priceStableMs: 20 });
    expect(offer.totalPriceUsd.value).toBe(31.4);
    const unitReads = reader.reads.filter((selector) => selector === L.unitPrice).length;
    expect(unitReads).toBeGreaterThanOrEqual(4);
  });

  it("does not settle on an old price while the dialog shows its loading overlay", async () => {
    // The old, arithmetically valid price stays visible while the dialog reprices;
    // a reader that ignored the overlay would settle on it.
    let polls = 0;
    const repricing = () => polls < 30;
    const base = fakeReader({ ...CRUMBS, [L.selectedSkuTitles]: [".125"] });
    const reader: ProviderPortalReadCapability = {
      ...base,
      count: async (selector) => {
        if (selector !== L.activeLoading) return base.count(selector);
        polls += 1;
        return repricing() ? 1 : 0;
      },
      readTexts: async (selector) => selector === L.unitPrice || selector === L.totalPrice
        ? [repricing() ? "$12.00" : "$31.40"]
        : base.readTexts(selector),
    };
    const [offer] = await extractSendCutSendSheetOffers(reader, 1, walked, { ...FAST, priceWaitMs: 2_000, priceStableMs: 0 });
    expect(offer.unitPriceUsd.value).toBe(31.4);
    expect(polls).toBeGreaterThan(30);
  });

  it("does not count a read that a reprice started during", async () => {
    // The overlay is absent before each read but appears before the read ends, for the first polls.
    let checks = 0;
    const base = fakeReader({ ...CRUMBS, [L.selectedSkuTitles]: [".125"] });
    const reader: ProviderPortalReadCapability = {
      ...base,
      count: async (selector) => {
        if (selector !== L.activeLoading) return base.count(selector);
        checks += 1;
        return checks < 20 && checks % 2 === 0 ? 1 : 0;
      },
      readTexts: async (selector) => selector === L.unitPrice || selector === L.totalPrice
        ? [checks < 20 ? "$12.00" : "$31.40"]
        : base.readTexts(selector),
    };
    const [offer] = await extractSendCutSendSheetOffers(reader, 1, walked, { ...FAST, priceWaitMs: 2_000, priceStableMs: 0 });
    expect(offer.unitPriceUsd.value).toBe(31.4);
  });

  it("withholds the offer when the price changes after it settled", async () => {
    const reader = fakeReader({
      ...CRUMBS,
      [L.selectedSkuTitles]: [".125"],
      [L.unitPrice]: [["$31.40"], ["$31.40"], ["$31.40"], ["$32.00"]],
      [L.totalPrice]: [["$31.40"], ["$31.40"], ["$31.40"], ["$32.00"]],
    });
    await expect(extractSendCutSendSheetOffers(reader, 1, walked, FAST))
      .rejects.toMatchObject({ payload: { reason: "sendcutsend_price_pending" } });
  });

  it("withholds the offer when the loading overlay never clears", async () => {
    const reader = fakeReader({
      ...CRUMBS,
      [L.selectedSkuTitles]: [".125"],
      [L.activeLoading]: [""],
      [L.unitPrice]: ["$12.00"],
      [L.totalPrice]: ["$12.00"],
    });
    await expect(extractSendCutSendSheetOffers(reader, 1, walked, { ...FAST, priceWaitMs: 20 }))
      .rejects.toMatchObject({ payload: { reason: "sendcutsend_price_pending" } });
    expect(reader.reads).not.toContain(L.unitPrice);
  });

  it("re-checks the material and session after the price read", async () => {
    const reader = fakeReader({
      // One read before the price, one after it.
      [L.materialCrumbs]: [CRUMBS[L.materialCrumbs], ["Categories", "Metals", "Aluminum", "7075 T6 Aluminum"]],
      [L.selectedSkuTitles]: [".125"],
      [L.unitPrice]: ["$31.40"],
      [L.totalPrice]: ["$31.40"],
    });
    await expect(extractSendCutSendSheetOffers(reader, 1, walked, FAST))
      .rejects.toMatchObject({ payload: { reason: "sendcutsend_material_unverified" } });
  });

  it("records scrubbed page text for a stop the reader throws, without replacing the stop", async () => {
    const definition = buildSendCutSendSheetPortalDefinition({
      ...FAST,
      writeDiagnostic: async (diagnostic) => [{ kind: "json", label: diagnostic.reason, localPath: "/tmp/x.json", contentType: "application/json" }],
    });
    const reader = fakeReader({ body: ["page text"] });
    const error = await Promise.resolve(definition.hooks.extractOffers(reader, await sheetInput())).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VendorAutomationError);
    expect(error).toMatchObject({
      payload: { reason: "sendcutsend_session_unconfirmed" },
      artifacts: [{ label: "sendcutsend_session_unconfirmed" }],
    });
  });
});

describe("SendCutSend pre-upload guard", () => {
  const signedInPage = { [L.navbar]: ["Quote"], [L.uploadInput]: [""] };
  const confirmed = { signedIn: true, detail: "status 200" };
  const sessionReporting = (result: ProviderPortalSessionCheckResult) => ({ confirmSignedIn: vi.fn(async () => result) });
  const guard = (texts: Record<string, string[]>, session: ProviderPortalSessionCapability | undefined = sessionReporting(confirmed)) =>
    Promise.resolve(buildSendCutSendSheetPortalDefinition(FAST).hooks.beforeUpload?.(fakeReader(texts), session as ProviderPortalSessionCapability));

  it("passes a rendered page with one upload input once the app confirms a non-guest user", async () => {
    const session = sessionReporting(confirmed);
    await expect(guard(signedInPage, session)).resolves.toBeUndefined();
    expect(session.confirmSignedIn).toHaveBeenCalledWith();
  });

  it.each([
    ["a visible sign-in link", { ...signedInPage, [L.visibleLoginLink]: ["LOGIN"] }, "login_required", "sendcutsend_signed_out"],
    ["a header that never renders", { [L.uploadInput]: [""] }, "selector_drift", "sendcutsend_header_missing"],
    ["two upload inputs", { ...signedInPage, [L.uploadInput]: ["", ""] }, "selector_drift", "sendcutsend_upload_input_ambiguous"],
    ["no upload input", { [L.navbar]: ["Quote"] }, "selector_drift", "sendcutsend_upload_input_ambiguous"],
    ["an open quote dialog", { ...signedInPage, [L.quoteDialog]: [""] }, "manual_review", "sendcutsend_quote_dialog_already_open"],
  ])("stops before upload on %s", async (_label, texts, terminalState, reason) => {
    await expect(guard(texts)).rejects.toMatchObject({ payload: { terminalState, reason, providerMutationPossible: false } });
  });

  // OVD-1056 review: a navbar without a LOGIN link is not proof of a session.
  it.each([
    ["a guest user", { signedIn: false, detail: "guest user" }],
    ["a user without a guest flag", { signedIn: false, detail: "status 200 without a guest flag" }],
    ["a failed lookup", { signedIn: false, detail: "status 401" }],
  ])("stops before upload when the app reports %s", async (_label, result) => {
    await expect(guard(signedInPage, sessionReporting(result))).rejects.toMatchObject({
      payload: { terminalState: "login_required", reason: "sendcutsend_session_unconfirmed", providerMutationPossible: false },
      message: expect.stringContaining(result.detail),
    });
  });

  it("stops before upload when no session check is available", async () => {
    const beforeUpload = buildSendCutSendSheetPortalDefinition(FAST).hooks.beforeUpload!;
    await expect(Promise.resolve(beforeUpload(fakeReader(signedInPage), undefined as never))).rejects.toMatchObject({
      payload: { terminalState: "login_required", reason: "sendcutsend_session_unconfirmed" },
    });
  });

  it("lets the offer reader run only after the guard confirmed the session", async () => {
    const definition = buildSendCutSendSheetPortalDefinition(FAST);
    const priced = fakeReader({ ...CRUMBS, [L.selectedSkuTitles]: [".125"], [L.unitPrice]: ["$31.40"], [L.totalPrice]: ["$31.40"] });
    await expect(Promise.resolve(definition.hooks.beforeUpload?.(fakeReader(signedInPage), sessionReporting({ signedIn: false, detail: "guest user" }))))
      .rejects.toMatchObject({ payload: { reason: "sendcutsend_session_unconfirmed" } });
    await expect(Promise.resolve(definition.hooks.extractOffers(priced, await sheetInput())))
      .rejects.toMatchObject({ payload: { terminalState: "login_required", reason: "sendcutsend_session_unconfirmed" } });
    expect(priced.reads).not.toContain(L.unitPrice);
  });
});

describe("SendCutSend saved session filter", () => {
  it("keeps only exact-host cookies and origins and names the dropped domains", () => {
    const filtered = filterSendCutSendStorageState({
      cookies: [
        { name: "app", value: "v", domain: "app.sendcutsend.com" },
        { name: "rt", value: "v", domain: ".main.realtime.ably.net" },
        { name: "cf", value: "v", domain: ".sendcutsend.com", path: "/" },
        { name: "w", value: "v", domain: "www.sendcutsend.com" },
        { name: "g", value: "v", domain: ".google.com" },
        { name: "i", value: "v", domain: ".intercom.io" },
      ],
      origins: [
        { origin: "https://app.sendcutsend.com", localStorage: [] },
        { origin: "https://sendcutsend.com", localStorage: [] },
        { origin: "http://app.sendcutsend.com", localStorage: [] },
      ],
    });
    expect(filtered.keptCookies).toBe(3);
    // The parent-domain cookie is rescoped to the app host, so it never reaches the CDN.
    expect(filtered.state.cookies).toEqual([
      { name: "app", value: "v", domain: "app.sendcutsend.com" },
      { name: "rt", value: "v", domain: ".main.realtime.ably.net" },
      { name: "cf", value: "v", domain: "app.sendcutsend.com", path: "/" },
    ]);
    expect(filtered.state.origins).toEqual([{ origin: "https://app.sendcutsend.com", localStorage: [] }]);
    expect(filtered.droppedCookieDomains).toEqual(["google.com", "intercom.io", "www.sendcutsend.com"]);
    expect(JSON.stringify(filtered.droppedCookieDomains)).not.toContain("value");
  });

  it("keeps an app-host cookie over a parent-domain cookie of the same name and path", () => {
    const filtered = filterSendCutSendStorageState({
      cookies: [
        { name: "_session", value: "parent", domain: ".sendcutsend.com", path: "/" },
        { name: "_session", value: "app", domain: "app.sendcutsend.com", path: "/" },
        { name: "sendcutsend.com", value: "v", domain: "sendcutsend.com", path: "/x" },
      ],
      origins: [],
    });
    expect(filtered.state.cookies).toEqual([
      { name: "_session", value: "app", domain: "app.sendcutsend.com", path: "/" },
      { name: "sendcutsend.com", value: "v", domain: "app.sendcutsend.com", path: "/x" },
    ]);
    expect(filtered.droppedCookieDomains).toEqual([]);
  });

  it("treats a missing path as / when an app-host cookie shadows a parent one", () => {
    const filtered = filterSendCutSendStorageState({
      cookies: [
        { name: "_session", value: "parent", domain: ".sendcutsend.com" },
        { name: "_session", value: "app", domain: "app.sendcutsend.com", path: "/" },
        { name: "z", value: "v", domain: ".zeta.example" },
        { name: "a", value: "v", domain: ".alpha.example" },
      ],
      origins: [],
    });
    expect(filtered.state.cookies).toEqual([
      { name: "_session", value: "app", domain: "app.sendcutsend.com", path: "/" },
    ]);
    expect(filtered.droppedCookieDomains).toEqual(["alpha.example", "zeta.example"]);
  });

  it("orders dropped domains by locale, not by UTF-16 code unit", () => {
    const filtered = filterSendCutSendStorageState({
      cookies: [
        { name: "f", value: "v", domain: ".f.example" },
        { name: "e", value: "v", domain: ".\u00e9.example" },
        { name: "d", value: "v", domain: ".e.example" },
      ],
      origins: [],
    });
    // A plain .sort() would place "\u00e9.example" after "f.example".
    expect(filtered.droppedCookieDomains).toEqual(["e.example", "\u00e9.example", "f.example"]);
  });

  it("returns an empty state for malformed input", () => {
    expect(filterSendCutSendStorageState(null)).toEqual({
      state: { cookies: [], origins: [] },
      keptCookies: 0,
      droppedCookieDomains: [],
    });
  });

  it("uses the same host list the definition declares", () => {
    expect([...SENDCUTSEND_ALLOWED_HOSTS]).toEqual(buildSendCutSendSheetPortalDefinition().allowedHosts);
    expect(SENDCUTSEND_OFF_HOST_ALLOWLIST).not.toContain("app.sendcutsend.com");
    // A listed parent domain would let the kernel accept cookies that ride along on CDN requests.
    expect(SENDCUTSEND_ALLOWED_HOSTS).not.toContain("sendcutsend.com");
  });
});
