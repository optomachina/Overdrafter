/**
 * The three modes of docs/jev-quote-driver.md §2 on one configured page:
 *   A  scripted only: the production configure segment of xometry.ts, ported
 *      line for line onto the exported production helpers;
 *   B  scripted first; a handoff-eligible `selector_failure` hands the rest
 *      of the segment to the Jev driver (§19.4);
 *   C  the Jev driver from the start (code shortcuts on);
 *   C0 ablation: C with every code shortcut off, so Jev makes each choice.
 * Read-back is always the production gates (§15).
 */
import type { Page } from "playwright";
import type { Page as AdapterPage } from "patchright";
import {
  autoSelectedRequirementMismatches, configureRequiredOption, lineItemQuantityFailure, openPartConfigurationIfNeeded,
  overwriteAutoSelectedRequirements, readQuoteSummaryText, saveConfiguration, selectToleranceTier, setQuantity, setTolerance,
  verifySavedRequirements, xometryPriceTiersSettled, type AutoSelectedField, type SavedRequirementCheck,
} from "../../adapters/xometry.js";
import {
  XOMETRY_AS_MACHINED_FINISH_TERMS, XOMETRY_CNC_PROCESS_TERMS, XOMETRY_LOCATORS,
  buildFinishSearchTerms, buildMaterialSearchTerms, buildMaterialSummaryTerms,
} from "../../adapters/xometryConstraints.js";
import { collectXometryOffers, selectCompatibilityOffer } from "../../adapters/xometryOffers.js";
import { VendorAutomationError } from "../../types.js";
import { JevQuoteDriver, type DriverOutcome, type DriverOptions } from "../../jev/driver/loop.js";
import { createXometryDriverBinding } from "../../jev/driver/xometryBinding.js";
import type { BenchRequirement } from "./variants.js";

export type Mode = "A" | "B" | "C" | "C0";
export const SCRIPTED_HANDOFF_STEPS = new Set(["open", "quantity", "process", "material", "finish", "save"]);

export type StepTrace = { step: string; ms: number; ok: boolean; error?: string; code?: string };
export type ModeResult = {
  mode: Mode;
  scripted: { steps: StepTrace[]; failedStep: string | null; handoff: boolean } | null;
  driver: { fields: DriverOutcome | null; save: DriverOutcome | null } | null;
  toleranceAfterDriver: StepTrace | null;
  finalError: { step: string; message: string; code: string | null } | null;
  checkpoints: number;
  segmentMs: number;
};

function describe(error: unknown) {
  if (error instanceof VendorAutomationError) return { message: error.message, code: error.code };
  if (error instanceof Error) return { message: `${error.name}: ${error.message.split("\n")[0].slice(0, 200)}`, code: error.name === "TimeoutError" ? "playwright_timeout" : null };
  return { message: String(error), code: null };
}

class Handoff extends Error {}

export function requirementTerms(requirement: BenchRequirement) {
  const materialTerms = buildMaterialSearchTerms(requirement.material);
  const materialSummaryTerms = buildMaterialSummaryTerms(requirement.material);
  const finishTerms = buildFinishSearchTerms(requirement.finish);
  if (!materialTerms || !materialSummaryTerms || finishTerms === null) throw new Error("requirement_unmapped");
  const requestedTolerance = selectToleranceTier(requirement.toleranceInch);
  const check: SavedRequirementCheck = {
    quantity: requirement.quantity, processTerms: XOMETRY_CNC_PROCESS_TERMS, materialTerms: materialSummaryTerms,
    finishTerms, toleranceTier: requestedTolerance.tier, drawingName: null,
  };
  return { materialTerms, materialSummaryTerms, finishTerms, requestedTolerance, check };
}

/**
 * Port of the `else` branch of the configure segment in
 * XometryAdapter.quoteWithoutSnapshotLock (xometry.ts), same order and calls.
 */
async function runScripted(playwrightPage: Page, requirement: BenchRequirement, timeoutMs: number, checkpoint: () => Promise<void>, steps: StepTrace[]) {
  // The production helpers are typed with patchright's Page; production casts the same way for Camoufox pages.
  const page = playwrightPage as unknown as AdapterPage;
  const { materialTerms, finishTerms, check } = requirementTerms(requirement);
  const overwriteTerms: Record<AutoSelectedField, string[]> = {
    process: XOMETRY_CNC_PROCESS_TERMS, material: materialTerms,
    finish: finishTerms.length > 0 ? finishTerms : XOMETRY_AS_MACHINED_FINISH_TERMS,
  };
  const uploadedSummaryText = await readQuoteSummaryText(page);
  if (verifySavedRequirements(uploadedSummaryText, check).length === 0) return;
  const uploadedAutoSelections = autoSelectedRequirementMismatches(uploadedSummaryText, check);
  const step = async (name: string, run: () => Promise<unknown>) => {
    const started = performance.now();
    try {
      await run();
      steps.push({ step: name, ms: Math.round(performance.now() - started), ok: true });
    } catch (error) {
      const info = error instanceof Handoff ? { message: "overwrite returned null", code: "selector_failure" } : describe(error);
      steps.push({ step: name, ms: Math.round(performance.now() - started), ok: false, error: info.message, code: info.code ?? undefined });
      throw error;
    }
  };
  await checkpoint();
  await step("open", () => openPartConfigurationIfNeeded(page, timeoutMs));
  await step("quantity", () => setQuantity(page, requirement.quantity, undefined, checkpoint));
  await step("process", async () => {
    const result = await overwriteAutoSelectedRequirements(page, uploadedAutoSelections.filter((field) => field === "process"), overwriteTerms, checkpoint);
    if (result.process === null) throw new Handoff();
  });
  await checkpoint();
  await step("material", () => configureRequiredOption(page, materialTerms, XOMETRY_LOCATORS.materialButtons, XOMETRY_LOCATORS.materialOptions, "material"));
  if (finishTerms.length > 0) {
    await checkpoint();
    await step("finish", () => configureRequiredOption(page, finishTerms, XOMETRY_LOCATORS.finishButtons, XOMETRY_LOCATORS.finishOptions, "finish"));
  } else if (uploadedAutoSelections.includes("finish")) {
    await step("finish", async () => {
      const result = await overwriteAutoSelectedRequirements(page, ["finish"], overwriteTerms, checkpoint);
      if (result.finish === null) throw new Handoff();
    });
  }
  await checkpoint();
  await step("tolerance", () => setTolerance(page, requirement.toleranceInch));
  await step("save", () => saveConfiguration(page, timeoutMs, checkpoint));
}

function handoffEligible(error: unknown, steps: StepTrace[]) {
  const failed = steps.at(-1);
  if (!failed || failed.ok || !SCRIPTED_HANDOFF_STEPS.has(failed.step)) return false;
  return error instanceof Handoff || (error instanceof VendorAutomationError && error.code === "selector_failure");
}

export type DriverFactory = (page: Page, requirement: BenchRequirement, shortcuts: boolean) => JevQuoteDriver;

export function driverFactory(options: Omit<DriverOptions, "shortcuts" | "checkpoint"> & { checkpoint: () => Promise<void> }): DriverFactory {
  return (page, requirement, shortcuts) => new JevQuoteDriver(page, createXometryDriverBinding({
    quantity: requirement.quantity, material: requirement.material, finish: requirement.finish, cadUnits: requirement.cadUnits,
  }), { ...options, shortcuts, checkpoint: async () => options.checkpoint() });
}

export async function runMode(mode: Mode, page: Page, requirement: BenchRequirement, timeoutMs: number, makeDriver: DriverFactory): Promise<ModeResult> {
  let checkpoints = 0;
  const checkpoint = async () => { checkpoints += 1; };
  const started = performance.now();
  const result: ModeResult = { mode, scripted: null, driver: null, toleranceAfterDriver: null, finalError: null, checkpoints: 0, segmentMs: 0 };
  const finish = () => { result.checkpoints = checkpoints; result.segmentMs = Math.round(performance.now() - started); return result; };
  if (mode === "A" || mode === "B") {
    const steps: StepTrace[] = [];
    result.scripted = { steps, failedStep: null, handoff: false };
    try {
      await runScripted(page, requirement, timeoutMs, checkpoint, steps);
      return finish();
    } catch (error) {
      result.scripted.failedStep = steps.at(-1)?.step ?? "pre";
      const eligible = handoffEligible(error, steps);
      if (mode === "A" || !eligible) {
        const info = error instanceof Handoff ? { message: "overwrite returned null", code: "selector_failure" } : describe(error);
        result.finalError = { step: result.scripted.failedStep, message: info.message, code: info.code };
        return finish();
      }
      result.scripted.handoff = true;
    }
  }
  const driver = makeDriver(page, requirement, mode !== "C0");
  await driver.install();
  try {
    const fields = await driver.runFields();
    result.driver = { fields, save: null };
    if (fields.status !== "completed") {
      result.finalError = { step: "driver_fields", message: fields.reason, code: fields.reason };
      return finish();
    }
    const started2 = performance.now();
    try {
      await checkpoint();
      await setTolerance(page as unknown as AdapterPage, requirement.toleranceInch);
      result.toleranceAfterDriver = { step: "tolerance", ms: Math.round(performance.now() - started2), ok: true };
    } catch (error) {
      const info = describe(error);
      result.toleranceAfterDriver = { step: "tolerance", ms: Math.round(performance.now() - started2), ok: false, error: info.message, code: info.code ?? undefined };
      result.finalError = { step: "tolerance", message: info.message, code: info.code };
      return finish();
    }
    const save = await driver.save();
    result.driver.save = save;
    if (save.status !== "completed") result.finalError = { step: "driver_save", message: save.reason, code: save.reason };
    return finish();
  } finally {
    await driver.uninstall();
  }
}

export type Readback = {
  ran: boolean;
  mismatches: string[];
  quantityFailure: string | null;
  offers: number;
  offerError: string | null;
  priceUsd: number | null;
  accepted: boolean;
  ms: number;
};

/** The production read-back and price gates, unchanged (§15). */
export async function productionReadback(playwrightPage: Page, requirement: BenchRequirement, timeoutMs: number): Promise<Readback> {
  const page = playwrightPage as unknown as AdapterPage;
  const started = performance.now();
  const { check } = requirementTerms(requirement);
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForFunction(xometryPriceTiersSettled, undefined, { timeout: timeoutMs }).catch(() => undefined);
  const bodyText = await readQuoteSummaryText(page);
  const mismatches = verifySavedRequirements(bodyText, check);
  const quantity = await lineItemQuantityFailure(page, requirement.quantity);
  let offers: Awaited<ReturnType<typeof collectXometryOffers>> = [];
  let offerError: string | null = null;
  try {
    offers = await collectXometryOffers(page, requirement.quantity);
  } catch (error) {
    offerError = describe(error).message;
  }
  const best = selectCompatibilityOffer(offers);
  return {
    ran: true, mismatches, quantityFailure: quantity?.reason ?? null, offers: offers.length, offerError,
    priceUsd: best?.totalPriceUsd ?? null,
    accepted: mismatches.length === 0 && !quantity && offers.length > 0 && best !== null,
    ms: Math.round(performance.now() - started),
  };
}
