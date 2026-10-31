import { createHash } from "node:crypto";
import { normalizeLabel } from "../../fixtureHeal/fingerprint.js";
import { fieldOf, isDenied, optionMatch, valueState, type ValueState } from "./policy.js";
import type { DriverBinding, FieldSpec, RawElement, RawObservation } from "./types.js";

/**
 * Raw records -> the scrubbed element table (profile `driver_labels.v1`, §6).
 * Pure. A name or `near` text survives only when the whole normalized label
 * is a reviewed phrase; anything else becomes a typed placeholder. Values
 * become code-computed statuses. URLs, ids, classes, test ids, prices, file
 * names and page text never appear in the output.
 */
export const PROJECTION_PROFILE = "driver_labels.v1";
export const MAX_ADMISSIBLE_ELEMENTS = 120;

export type ProjectedElement = {
  id: string;
  role: string;
  name: string;
  near?: string;
  value_state?: ValueState;
  matches_required?: true;
  expanded?: boolean;
  checked?: boolean;
  disabled?: true;
  offscreen?: true;
  in_dialog?: true;
};

export function placeholderFor(raw: string, binding: Pick<DriverBinding, "catalogTerms" | "matchTerm">) {
  const text = raw.trim();
  if (!text) return "";
  if (text.includes("@")) return "«contact»";
  if (/\bQ\d{2}-/i.test(text)) return "«id»";
  if (/\+?\d[\d\s().-]{8,}\d/.test(text)) return "«contact»";
  if (/\.(step|stp|iges|igs|stl|pdf|dxf|dwg|sldprt|sldasm|x_t|x_b|3mf|obj|zip|png|jpe?g|txt|csv|docx?|xlsx?)\b/i.test(text)) return "«file»";
  if (/\d{6,}/.test(text)) return "«id»";
  if (/[$€£¥]\s*\d|\d[\d,.]*\s*(usd|eur|gbp)\b|^[\d\s,.]+$/i.test(text)) return "«amount»";
  if (binding.matchTerm(text, binding.catalogTerms)) return "«catalog»";
  return "«text»";
}

export function scrubLabel(raw: string, binding: Pick<DriverBinding, "vocabulary" | "catalogTerms" | "matchTerm">) {
  const normalized = normalizeLabel(raw);
  if (!normalized) return "";
  return binding.vocabulary.has(normalized) ? normalized : placeholderFor(raw, binding);
}

/** Indexable records: deny-listed and excluded elements are dropped before any id is assigned to a request. */
export function admissibleElements(observation: RawObservation) {
  return observation.elements.filter((element) => !isDenied(element));
}

export function projectElement(element: RawElement, current: FieldSpec | null, binding: DriverBinding): ProjectedElement {
  const projected: ProjectedElement = { id: element.id, role: element.role, name: scrubLabel(element.name || element.placeholder, binding) || element.role };
  const near = scrubLabel(element.near, binding);
  if (near && near !== projected.name) projected.near = near;
  const owner = fieldOf(element, binding.fields);
  const ownerSpec = owner ? binding.fields.find((spec) => spec.field === owner) ?? null : null;
  if (ownerSpec && element.role !== "option" && element.role !== "radio") {
    const state = valueState(element, ownerSpec, binding);
    if (state) projected.value_state = state;
  }
  if (current?.kind === "option" && (element.role === "option" || element.role === "radio") && optionMatch(element, current, binding)) {
    projected.matches_required = true;
  }
  if (element.expanded !== null) projected.expanded = element.expanded;
  if (element.checked !== null && (element.role === "radio" || element.role === "checkbox" || element.role === "option")) projected.checked = element.checked;
  if (element.disabled) projected.disabled = true;
  if (element.offscreen) projected.offscreen = true;
  if (element.inDialog) projected.in_dialog = true;
  return projected;
}

export function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
