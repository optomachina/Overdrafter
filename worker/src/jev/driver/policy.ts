import { normalizeLabel } from "../../fixtureHeal/fingerprint.js";
import type { ConfigField, DialogClass, DriverBinding, DriverOp, FieldSpec, RawElement } from "./types.js";

/**
 * Pure rails (docs/jev-quote-driver.md §7, §9, §12). Nothing here can be
 * overridden by a model answer: a denied element is never indexed, so no id
 * for it ever reaches a request, and execution re-runs the same check on the
 * live node.
 */
export const POLICY_REVISION = "jev-driver-policy.v1";

/** Extends PROHIBITED_CONFIGURATION_SELECTOR (providerPortalKernel.ts). */
export const DENY_PATTERN =
  /check\s?out|place\s?order|submit\s?order|order\s?now|purchase|\bbuy\b|\bpay(ment)?\b|add\s?to\s?cart|\bcart\b|request\s?(a\s)?quote|share\s?quote|delete|remove\s?part|duplicate|log\s?out|sign\s?out|upload|choose\s?file|drag\s?and\s?drop|attach|expedite|add[- ]?on/i;

const STEPPER_NAME = /^\s*(\+|-|−|–|increase|decrease|increment|decrement|plus|minus|add one|remove one)\s*$/i;

export function deniedText(text: string) {
  return DENY_PATTERN.test(text);
}

/** Removal before indexing: deny-listed strings, links, file inputs, offer/payment scopes. */
export function isDenied(element: RawElement) {
  if (element.excluded || element.href !== null || element.role === "link" || element.type === "file") return true;
  return [element.name, element.text, element.value, element.title ?? "", element.href ?? "", element.testId ?? "",
    element.domId ?? "", element.placeholder, element.nameAttr ?? "", element.scopeText].some(deniedText);
}

function hasKeyword(text: string, keywords: readonly string[]) {
  const words = ` ${normalizeLabel(text)} `;
  return keywords.some((keyword) => words.includes(` ${keyword} `));
}

/**
 * Which configuration field a control belongs to. The control's own name,
 * placeholder, name attribute and test id decide first; `near` text is used
 * only when they name no field. More than one field is no field.
 */
export function fieldOf(element: RawElement, fields: readonly FieldSpec[]): ConfigField | null {
  for (const sources of [[element.name, element.placeholder, element.nameAttr ?? "", element.testId ?? ""], [element.near]]) {
    const matches = fields.filter((spec) => sources.some((text) => hasKeyword(text, spec.keywords)));
    if (matches.length > 0) return matches.length === 1 ? matches[0].field : null;
  }
  return null;
}

export function isSaveControl(element: RawElement, binding: Pick<DriverBinding, "saveVocabulary">) {
  return ["button", "generic"].includes(element.role) && binding.saveVocabulary.includes(normalizeLabel(element.name));
}

/** Code's exact-term matcher with preference order: the lowest accepted term index wins. */
export function optionMatch(element: RawElement, spec: FieldSpec, binding: Pick<DriverBinding, "matchTerm">) {
  const label = element.name || element.text;
  const terms = [...spec.acceptTerms, ...spec.fillValues.filter((term) => !spec.acceptTerms.includes(term))];
  for (let index = 0; index < terms.length; index += 1) {
    if (binding.matchTerm(label, [terms[index]])) return { term: terms[index], rank: index };
  }
  return null;
}

export type ValueState = "matches_required" | "differs" | "empty";

/** Status of a field control against the requirement. Typed search text is never evidence. */
export function valueState(element: RawElement, spec: FieldSpec, binding: Pick<DriverBinding, "matchTerm">): ValueState | null {
  if (spec.kind === "number") {
    if (!element.editable || element.role === "combobox") return null;
    const value = element.value.trim();
    if (!value) return "empty";
    return value === spec.fillValues[0] ? "matches_required" : "differs";
  }
  if (element.expanded === true) return null;
  // A disclosure that shows only the field's own label ("Finish") carries no value.
  const labelWords = new Set(spec.keywords.flatMap((keyword) => keyword.split(" ")));
  const shown = normalizeLabel(element.display).split(" ").some((word) => word && !labelWords.has(word)) ? element.display.trim() : "";
  if (!shown) return element.role === "combobox" || element.tag === "select" ? "empty" : null;
  return binding.matchTerm(shown, spec.acceptTerms) ? "matches_required" : "differs";
}

export type OpContext = {
  spec: FieldSpec | null;
  dialog: DialogClass | null;
  /** Units dialog: code checked the code-chosen radio, so the confirm button may be offered. */
  unitsConfirmed: boolean;
  /** The next search term exists; once terms run out FILL is not offered for option fields. */
  fillValue: string | null;
};

function isQuantityInput(element: RawElement) {
  return element.role !== "combobox" && element.role !== "searchbox" && element.tag === "input"
    && (["spinbutton", "textbox"].includes(element.role)) && ["number", "text", "tel", ""].includes(element.type);
}

function isSearchInput(element: RawElement) {
  return (element.role === "combobox" && ["input", "textarea"].includes(element.tag)) || element.role === "searchbox"
    || (element.role === "textbox" && /\b(search|find)\b/i.test(`${element.placeholder} ${element.name}`));
}

/** Code-filtered targets per operation (§7). Elements must already be admissible. */
export function compatibleTargets(op: DriverOp, elements: readonly RawElement[], context: OpContext, binding: DriverBinding): RawElement[] {
  const { spec } = context;
  const scoped = context.dialog ? elements.filter((element) => element.inDialog) : elements.filter((element) => !element.inDialog);
  switch (op) {
    case "CLICK":
      if (context.dialog === "units_prompt" && !context.unitsConfirmed) return [];
      return scoped.filter((element) => !element.disabled && element.optionIndex === null && element.tag !== "select"
        && ["button", "tab", "combobox", "generic", "menuitem"].includes(element.role)
        && !isSaveControl(element, binding) && !STEPPER_NAME.test(element.name) && !STEPPER_NAME.test(element.text));
    case "FILL_REQUIRED_VALUE":
      if (!spec || context.dialog || context.fillValue === null) return [];
      return scoped.filter((element) => {
        if (!element.editable || element.disabled) return false;
        const owner = fieldOf(element, binding.fields);
        if (spec.kind === "number") {
          return isQuantityInput(element) && (owner === spec.field
            || (owner === null && (element.type === "number" || element.inputMode === "numeric" || element.role === "spinbutton")));
        }
        return isSearchInput(element) && (owner === spec.field || owner === null);
      });
    case "SELECT_REQUIRED_VALUE":
      if (!spec || spec.kind !== "option" || context.dialog) return [];
      return scoped.filter((element) => !element.disabled && (element.role === "option" || element.role === "radio")
        && element.checked !== true && optionMatch(element, spec, binding) !== null);
    default:
      return [];
  }
}

/** Visible copies sharing role, projected name and near text form one class (§5.6). */
export function equivalenceKey(element: { role: string; name: string; near?: string }) {
  return `${element.role}\u0000${element.name}\u0000${element.near ?? ""}`;
}
