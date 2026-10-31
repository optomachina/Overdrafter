import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { normalizeLabel, UI_LABEL_PHRASES } from "../fixtureHeal/fingerprint.js";
import { createPlaywrightSurface } from "../jev/driver/executor.js";
import { buildDrivenLocatorCandidate } from "../jev/driver/fixer.js";
import { runQuoteDriver } from "../jev/driver/loop.js";
import { deniedText, isSaveControl, POLICY_REVISION } from "../jev/driver/policy.js";
import { admissibleElements } from "../jev/driver/projection.js";
import type {
  ConfigField, DriverBinding, DriverOutcome, FieldSpec, JevDriverCapability, PageClass, PageSignal, RawObservation,
} from "../jev/driver/types.js";
import {
  buildFinishSearchTerms,
  buildMaterialSearchTerms,
  buildMaterialSummaryTerms,
  findExactTermMatch,
  readQuoteSummaryField,
  XOMETRY_AS_MACHINED_FINISH_TERMS,
  XOMETRY_CNC_PROCESS_TERMS,
  XOMETRY_LOCATORS,
  XOMETRY_URLS,
} from "./xometryConstraints.js";

/**
 * Xometry binding for the Jev quote driver (docs/jev-quote-driver.md §19).
 * Supplies sub-goal specs whose values come from the approved requirement,
 * the reviewed vocabulary, the page-signal classifier and the save lookup.
 * Off unless a host passes a JevDriverCapability to XometryAdapter.
 */
export const XOMETRY_DRIVER_BINDING_REVISION = "xometry-driver-binding.v1";
const XOMETRY_ORIGIN = new URL(XOMETRY_URLS.quoteHome).origin;

/** Locator constant each driven field's repair candidate is inserted ahead of. */
export const XOMETRY_DRIVER_LOCATOR_TARGETS: Readonly<Record<ConfigField, string>> = {
  process: "processButtons", material: "materialButtons", finish: "finishButtons", quantity: "quantityInputs",
};

const CONFIGURATION_PHRASES = [
  "quantity", "qty", "material", "search material", "finish", "search finish", "process", "search process",
  "post processing", "surface finish", "tolerance", "precision tolerance", "configure part", "part configuration",
  "edit configuration", "edit specifications", "save configuration", "save changes", "update quote", "update configuration",
  "units", "model units", "confirm model units", "millimeters", "millimetres", "mm", "inches", "inch",
  "ok", "okay", "got it", "confirm", "yes", "no", "apply", "done", "options", "show more", "more options",
];
const SAVE_PHRASES = ["save configuration", "save", "save changes", "update quote", "update configuration"];

function locatorPhrases() {
  const phrases: string[] = [];
  for (const value of Object.values(XOMETRY_LOCATORS)) {
    for (const entry of Array.isArray(value) ? value : []) {
      if (typeof entry !== "string") continue;
      for (const match of entry.matchAll(/(?:has-text|text-is)\("([^"]+)"\)|(?:placeholder|aria-label)="([^"]+)"/g)) {
        phrases.push(match[1] ?? match[2]);
      }
    }
  }
  return phrases;
}

/** Reviewed phrases only: UI chrome, Xometry locator text, and configuration words. */
export const XOMETRY_DRIVER_VOCABULARY: ReadonlySet<string> = new Set(
  [...UI_LABEL_PHRASES, ...locatorPhrases(), ...CONFIGURATION_PHRASES].map(normalizeLabel).filter(Boolean),
);
// Code-unit order keeps the digest byte-stable across locales.
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
export const XOMETRY_DRIVER_VOCABULARY_DIGEST = createHash("sha256")
  .update([...XOMETRY_DRIVER_VOCABULARY].sort(compareCodeUnits).join("\n")).digest("hex").slice(0, 16);

const CATALOG_TERMS = [
  ...["6061", "7075", "2024", "303", "304", "316", "17-4", "1018", "4140", "brass", "copper", "titanium", "peek", "nylon", "abs", "delrin"]
    .flatMap((needle) => [...(buildMaterialSearchTerms(needle) ?? []), ...(buildMaterialSummaryTerms(needle) ?? [])]),
  ...["type iii", "type ii black", "type ii", "bead blast", "chem film", "passivation", "powder coat", "media blast", "tumble"]
    .flatMap((finish) => buildFinishSearchTerms(finish) ?? []),
  ...XOMETRY_AS_MACHINED_FINISH_TERMS, ...XOMETRY_CNC_PROCESS_TERMS,
];

const isAny = (text: string, patterns: readonly RegExp[]) => patterns.some((pattern) => pattern.test(text));

export function classifyXometryDriverPage(
  observation: RawObservation,
  blockingSignal: (input: { text: string; url: string }) => string | null,
): PageClass {
  const signals: PageSignal[] = [];
  const text = observation.bodyText;
  if (isAny(text, XOMETRY_LOCATORS.quoteReadySignals)) signals.push("configuration_panel");
  if (isAny(text, XOMETRY_LOCATORS.quoteLoadingSignals)) signals.push("loading");
  if (XOMETRY_LOCATORS.quotePagePathPattern.test(observation.url) && isAny(text, XOMETRY_LOCATORS.quotePricingInProgressSignals)) {
    signals.push("pricing_in_progress");
  }
  if (isAny(text, XOMETRY_LOCATORS.manualReviewSignals)) signals.push("manual_review");
  if (blockingSignal({ text, url: observation.url })) signals.push("blocking");
  const dialogText = observation.dialogs[0]?.text ?? null;
  let dialog: PageClass["dialog"] = null;
  if (dialogText !== null) {
    // Export control is decided from the modal itself; the model never answers it.
    if (isAny(dialogText, XOMETRY_LOCATORS.itarPopupSignals)) dialog = "export_control";
    else if (/\bunits?\b/i.test(dialogText) && /\b(mm|millimet(er|re)s?|inch(es)?)\b/i.test(dialogText)) dialog = "units_prompt";
    else if (isAny(dialogText, XOMETRY_LOCATORS.renamePartsPopupSignals)
      || /\b(continue\?|are you sure|resets?|recalculate|reprice|confirm)\b/i.test(dialogText)) dialog = "confirm_prompt";
    else dialog = "unknown";
    if (dialog !== "unknown") signals.push(dialog);
  }
  return { signals, dialog };
}

export type XometryDriverRequirement = {
  quantity: number;
  materialSearchTerms: readonly string[];
  materialSummaryTerms: readonly string[];
  /** Requested finish terms; empty means as-machined. */
  finishTerms: readonly string[];
  includeProcess: boolean;
  includeFinish: boolean;
  /** No approved code source exists yet (STEP-header parser follow-up), so production passes null. */
  cadUnits: "mm" | "inch" | null;
};

export function buildXometryDriverBinding(input: XometryDriverRequirement & {
  beforeAction: () => Promise<void>;
  blockingSignal: (input: { text: string; url: string }) => string | null;
  signal?: AbortSignal;
  /** Test seam for synthetic pages served at a non-Xometry origin. */
  origin?: string;
}): DriverBinding {
  const origin = input.origin ?? XOMETRY_ORIGIN;
  const finishTerms = input.finishTerms.length > 0 ? input.finishTerms : XOMETRY_AS_MACHINED_FINISH_TERMS;
  const fields: FieldSpec[] = [
    ...(input.includeProcess ? [{ field: "process" as const, kind: "option" as const, keywords: ["process"],
      fillValues: XOMETRY_CNC_PROCESS_TERMS, acceptTerms: XOMETRY_CNC_PROCESS_TERMS, summaryLabel: "Process" }] : []),
    { field: "material", kind: "option", keywords: ["material"], fillValues: input.materialSearchTerms,
      acceptTerms: input.materialSummaryTerms, summaryLabel: "Material" },
    ...(input.includeFinish ? [{ field: "finish" as const, kind: "option" as const, keywords: ["finish", "post processing"],
      fillValues: finishTerms, acceptTerms: finishTerms, summaryLabel: "Finish" }] : []),
    { field: "quantity", kind: "number", keywords: ["quantity", "qty"], fillValues: [String(input.quantity)], acceptTerms: [String(input.quantity)], summaryLabel: null },
  ];
  const routeAllowed = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.origin === origin && XOMETRY_LOCATORS.quotePagePathPattern.test(parsed.pathname);
    } catch {
      return false;
    }
  };
  return Object.freeze({
    vendor: "xometry",
    policyRevision: `${POLICY_REVISION}+${XOMETRY_DRIVER_BINDING_REVISION}`,
    fields, vocabulary: XOMETRY_DRIVER_VOCABULARY, vocabularyDigest: XOMETRY_DRIVER_VOCABULARY_DIGEST,
    catalogTerms: CATALOG_TERMS, saveVocabulary: SAVE_PHRASES.map(normalizeLabel), cadUnits: input.cadUnits,
    classify: (observation: RawObservation) => classifyXometryDriverPage(observation, input.blockingSignal),
    routeAllowed,
    matchTerm: (text: string, terms: readonly string[]) => findExactTermMatch(text, terms),
    summaryField: readQuoteSummaryField,
    beforeAction: input.beforeAction,
    signal: input.signal,
  });
}

function surfaceFor(page: Page, binding: DriverBinding, origin: string) {
  return createPlaywrightSurface(page, {
    vocabulary: [...binding.vocabulary],
    excludeSelectors: [XOMETRY_LOCATORS.priceTierCard],
    frameAllowed: (url) => { try { return new URL(url).origin === origin; } catch { return false; } },
    routeAllowed: binding.routeAllowed,
  });
}

/** Runs the driven configuration segment on the live page. The boundary guards exist only for this window. */
export async function runXometryConfigurationDriver(page: Page, binding: DriverBinding, capability: JevDriverCapability, origin = XOMETRY_ORIGIN) {
  const surface = surfaceFor(page, binding, origin);
  try {
    return await runQuoteDriver({ surface, binding, capability });
  } finally {
    await surface.dispose();
  }
}

/**
 * Shortcut (c): exactly one visible, enabled, non-denied control named as a
 * save action. Save is never a model target; the caller runs the existing
 * save-and-settle macro with the returned click.
 */
export async function findXometryDriverSave(page: Page, binding: DriverBinding, origin = XOMETRY_ORIGIN) {
  const surface = surfaceFor(page, binding, origin);
  try {
    const observation = await surface.observe();
    const admissible = admissibleElements(observation);
    const saves = admissible.filter((element) => !element.inDialog && !element.disabled && isSaveControl(element, binding));
    if (saves.length !== 1) return null;
    const live = await surface.inspect(saves[0].id, { scroll: saves[0].offscreen, forFill: false });
    if (!live?.connected || !live.actionable || !live.point || deniedText(live.denyText)) return null;
    const point = live.point;
    return { click: async () => { await page.mouse.click(point.x, point.y); } };
  } finally {
    await surface.dispose();
  }
}

export function xometryDrivenRepairCandidate(outcome: DriverOutcome) {
  return buildDrivenLocatorCandidate({
    vendor: "xometry", routeClass: "quote_configuration", outcome, targets: XOMETRY_DRIVER_LOCATOR_TARGETS,
    vocabulary: XOMETRY_DRIVER_VOCABULARY, bindingRevision: XOMETRY_DRIVER_BINDING_REVISION,
  });
}
