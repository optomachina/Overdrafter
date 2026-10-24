/**
 * Xometry binding for the Jev quote driver (benchmark prototype). Supplies the
 * reviewed vocabulary, the code-owned value sources (§9), the option matcher,
 * display verification (§15) and page-signal classification (§6). Every value
 * typed or selected comes from the requirement through these functions.
 */
import { UI_LABEL_PHRASES } from "../../fixtureHeal/fingerprint.js";
import {
  XOMETRY_AS_MACHINED_FINISH_TERMS, XOMETRY_CNC_PROCESS_TERMS, XOMETRY_LOCATORS,
  buildFinishSearchTerms, buildMaterialSearchTerms, buildMaterialSummaryTerms,
} from "../../adapters/xometryConstraints.js";
import { buildVocabulary, type OptionField, type Vocabulary } from "./projection.js";

export type DriverRequirement = {
  quantity: number;
  material: string;
  finish: string | null;
  cadUnits: "mm" | "inch" | null;
};

export const PAGE_SIGNALS = [
  "configuration_panel", "loading", "pricing_in_progress", "manual_review", "export_control", "blocking",
  "units_prompt", "confirm_prompt", "unknown_dialog",
] as const;
export type PageSignal = (typeof PAGE_SIGNALS)[number];

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Same rule as xometry.ts `findExactTermMatch`. */
export function exactTermIndex(text: string, terms: readonly string[]) {
  return terms.findIndex((term) => new RegExp(`(?:^|[^a-z0-9])${escapeRegex(term)}(?=$|[^a-z0-9])`, "i").test(text));
}

const XOMETRY_PHRASES = [
  "edit configuration", "configure part", "part configuration", "save configuration", "edit specifications", "specifications",
  "search process", "search material", "search finish", "post processing", "precision tolerance", "units", "model units",
  "millimeters", "inches", "mm", "inch", "ok", "okay", "got it", "confirm", "accept", "accept all", "accept all cookies",
  "reject all", "dismiss", "increase quantity", "decrease quantity", "price and lead time", "cookie consent",
];

export const AS_MACHINED_DISPLAY = /^(?:Standard|As Machined|None)\b/i;

export type XometryDriverBinding = ReturnType<typeof createXometryDriverBinding>;

export function createXometryDriverBinding(requirement: DriverRequirement) {
  const materialSearch = buildMaterialSearchTerms(requirement.material);
  const materialSummary = buildMaterialSummaryTerms(requirement.material);
  const finishTerms = buildFinishSearchTerms(requirement.finish);
  if (!materialSearch || !materialSummary || finishTerms === null) {
    // The production precondition sends unmapped values to manual follow-up before any driver runs.
    throw new Error("driver_requirement_unmapped");
  }
  const asMachined = finishTerms.length === 0;
  const vocabulary: Vocabulary = buildVocabulary([...UI_LABEL_PHRASES, ...XOMETRY_PHRASES], {
    process: ["process", "search process", "manufacturing process"],
    material: ["material", "search material"],
    finish: ["finish", "search finish", "post processing", "surface finish"],
    quantity: ["quantity", "qty"],
  });
  const searchTerms: Record<OptionField, readonly string[]> = {
    process: XOMETRY_CNC_PROCESS_TERMS,
    material: materialSearch,
    finish: asMachined ? XOMETRY_AS_MACHINED_FINISH_TERMS : finishTerms,
  };
  /** Accept terms in preference order; search terms are appended for option labels (§9). */
  const acceptTerms: Record<OptionField, readonly string[]> = {
    process: XOMETRY_CNC_PROCESS_TERMS,
    material: [...materialSummary, ...materialSearch],
    finish: asMachined ? XOMETRY_AS_MACHINED_FINISH_TERMS : finishTerms,
  };

  return {
    requirement,
    vocabulary,
    searchTerms,
    quantityValue: String(requirement.quantity),
    /** The value code types for an option field's search box, or null when terms are exhausted. */
    searchValue(field: OptionField, attempt: number) {
      return searchTerms[field][attempt] ?? null;
    },
    /** Preference index of an option label, or -1. */
    optionRank(field: OptionField, label: string) {
      return exactTermIndex(label, acceptTerms[field]);
    },
    /** Whether a combobox's displayed value already satisfies the requirement. */
    displaySatisfies(field: OptionField, display: string) {
      if (!display.trim()) return false;
      if (field === "process") return exactTermIndex(display, XOMETRY_CNC_PROCESS_TERMS) >= 0;
      if (field === "material") return exactTermIndex(display, materialSummary) >= 0;
      return asMachined ? AS_MACHINED_DISPLAY.test(display.trim()) : exactTermIndex(display, finishTerms) >= 0;
    },
    signals(text: string, modalText: string | null, url: string): Set<PageSignal> {
      const signals = new Set<PageSignal>();
      const test = (patterns: readonly RegExp[], value: string) => patterns.some((pattern) => pattern.test(value));
      if (test(XOMETRY_LOCATORS.quoteLoadingSignals, text)) signals.add("loading");
      if (XOMETRY_LOCATORS.quotePagePathPattern.test(new URL(url).pathname) && test(XOMETRY_LOCATORS.quotePricingInProgressSignals, text)) {
        signals.add("pricing_in_progress");
      }
      if (test(XOMETRY_LOCATORS.manualReviewSignals, text)) signals.add("manual_review");
      if (test(XOMETRY_LOCATORS.captchaSignals, text) || test(XOMETRY_LOCATORS.loginSignals, text) || test(XOMETRY_LOCATORS.genericErrorSignals, text)) {
        signals.add("blocking");
      }
      if (modalText !== null) {
        if (test(XOMETRY_LOCATORS.itarPopupSignals, modalText)) signals.add("export_control");
        else if (/model units|units of (?:the|this|your)? ?(?:cad )?model|confirm (?:the )?units/i.test(modalText)) signals.add("units_prompt");
        else if (/\bresets?\b|will (?:change|replace)|\bcontinue\?/i.test(modalText)) signals.add("confirm_prompt");
        else signals.add("unknown_dialog");
      }
      return signals;
    },
    unitsLabel(label: string) {
      const normalized = label.trim().toLowerCase();
      if (requirement.cadUnits === "mm") return /^(millimeters?|mm)\b/.test(normalized);
      if (requirement.cadUnits === "inch") return /^(inch(es)?|in)\b/.test(normalized);
      return false;
    },
    saveNames: new Set(["save configuration", "save"]),
    openNames: new Set(["edit configuration"]),
  };
}
