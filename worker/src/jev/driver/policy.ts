/**
 * Code-owned rails for the Jev quote driver (docs/jev-quote-driver.md §7, §12).
 * Pure: no I/O. Nothing here can be overridden by a model answer.
 */
import type { RawRecord } from "./snapshot.js";

export const DRIVER_OPS = ["CLICK", "FILL_REQUIRED_VALUE", "SELECT_REQUIRED_VALUE", "WAIT", "DONE", "BLOCKED"] as const;
export type DriverOp = (typeof DRIVER_OPS)[number];

/**
 * Extends PROHIBITED_CONFIGURATION_SELECTOR (providerPortalKernel.ts). The
 * benchmark added `manual quote`, `forward to`, `repeat part`, `revise cad`
 * and `discard` after the synthetic decoys showed the design list missed them.
 */
export const DENY_PATTERN = String.raw`check\s?out|place\s?order|submit\s?order|order\s?now|purchase|\bbuy\b|\bpay(ment)?\b|add\s?to\s?cart|\bcart\b|request\s?(a\s)?quote|manual\s?quote|share\s?quote|forward\s?to|delete|remove\s?part|repeat\s?part|duplicate|revise\s?cad|discard|log\s?out|sign\s?out|upload|choose\s?file|drag\s?and\s?drop|attach|expedite|add[- ]?on`;
export const DENY = new RegExp(DENY_PATTERN, "i");

/** Network paths aborted for the whole driver window; a hit stops the run. */
export const BOUNDARY_PATH = /checkout|\/orders?\b|payment|\/cart\b/i;

const CLICK_ROLES = new Set(["button", "tab", "combobox", "menuitem", "switch"]);
const NUMERIC_ROLES = new Set(["spinbutton", "textbox"]);
const SEARCH_ROLES = new Set(["combobox", "searchbox"]);

export function isEditable(record: RawRecord) {
  return !record.readOnly && !record.disabled && (record.tag === "input" || record.tag === "textarea");
}

/** CLICK opens, reveals or dismisses. Never a value choice, never save/submit, never deny-listed. */
export function clickCompatible(record: RawRecord) {
  if (record.denied || record.disabled || record.submit) return false;
  if (!CLICK_ROLES.has(record.role)) return false;
  if (record.role === "combobox" && record.tag === "select") return false;
  return true;
}

export function fillCompatible(record: RawRecord, kind: "quantity" | "option") {
  if (record.denied || !isEditable(record)) return false;
  if (kind === "quantity") {
    return NUMERIC_ROLES.has(record.role) && record.role !== "combobox"
      && ["number", "text", ""].includes(record.type) && (record.type !== "text" || record.inputmode === "numeric" || record.inputmode === "");
  }
  return SEARCH_ROLES.has(record.role) && record.tag === "input";
}

export function selectCandidate(record: RawRecord) {
  return !record.denied && !record.disabled && (record.role === "option" || record.role === "radio");
}

/** (p_max - 1/n) / (1 - 1/n): 0 at uniform, 1 when one option holds all the mass. */
export function normalizedConfidence(probabilities: Record<string, number>) {
  const values = Object.values(probabilities);
  const n = values.length;
  if (n < 2) return 1;
  return Math.max(0, (Math.max(...values) - 1 / n) / (1 - 1 / n));
}
