/**
 * Raw observer records -> the scrubbed element table the model sees (profile
 * `driver_labels.v1`, docs/jev-quote-driver.md §6). Pure.
 *
 * A name or `near` string survives only when the WHOLE normalized label is in
 * a reviewed vocabulary; anything else becomes a typed placeholder. Values are
 * never sent: code turns them into `value_state` / `matches_required`.
 */
import { createHash } from "node:crypto";
import { normalizeLabel } from "../../fixtureHeal/fingerprint.js";
import type { RawRecord } from "./snapshot.js";

export type DriverField = "panel" | "dialog" | "overlay" | "process" | "material" | "finish" | "quantity" | "save";
export type OptionField = "process" | "material" | "finish";
export const OPTION_FIELDS: readonly OptionField[] = ["process", "material", "finish"];

export type Vocabulary = {
  labels: ReadonlySet<string>;
  fields: Readonly<Record<OptionField | "quantity", ReadonlySet<string>>>;
  digest: string;
};

export function buildVocabulary(labels: readonly string[], fields: Record<OptionField | "quantity", readonly string[]>): Vocabulary {
  const normalizedFields = Object.fromEntries(Object.entries(fields).map(([field, phrases]) =>
    [field, new Set(phrases.map(normalizeLabel))])) as unknown as Vocabulary["fields"];
  const all = new Set([...labels.map(normalizeLabel), ...Object.values(normalizedFields).flatMap((set) => [...set])]);
  all.delete("");
  const digest = createHash("sha256").update(JSON.stringify([...all].sort())).digest("hex").slice(0, 16);
  return { labels: all, fields: normalizedFields, digest };
}

const AMOUNT = /[$€£¥]\s*\d|\d[\d,]*\.\d{2}\b|^\s*[\d\s.,:/x×±″'"-]+\s*$/;
const ID_LIKE = /\bQ\d{2}-|\d{6,}|\b[0-9a-f]{8}-[0-9a-f]{4}-/i;
const FILE_LIKE = /\.(step|stp|sldprt|stl|dxf|iges?|pdf|x_t|x_b|3mf|prt|sat|jt)\b/i;
const CONTACT = /@|\+?\d[\d\s().-]{8,}\d/;

export function placeholderFor(raw: string) {
  const text = raw.trim();
  if (!normalizeLabel(text)) return "«icon»";
  if (ID_LIKE.test(text)) return "«id»";
  if (CONTACT.test(text)) return "«contact»";
  if (FILE_LIKE.test(text)) return "«file»";
  if (AMOUNT.test(text)) return "«amount»";
  return "«text»";
}

export function projectLabel(raw: string, vocabulary: Vocabulary) {
  const label = normalizeLabel(raw);
  return label && vocabulary.labels.has(label) ? label : placeholderFor(raw);
}

/** The field a fill-compatible control belongs to, from its whole name or `near` label. */
export function fieldOfLabels(record: Pick<RawRecord, "name" | "near">, vocabulary: Vocabulary): OptionField | "quantity" | null {
  for (const raw of [record.name, record.near]) {
    const label = normalizeLabel(raw);
    if (!label) continue;
    for (const [field, phrases] of Object.entries(vocabulary.fields)) if (phrases.has(label)) return field as OptionField | "quantity";
  }
  return null;
}

export type ValueState = "matches_required" | "differs" | "empty" | "search_typed";

export type ProjectedElement = {
  id: string;
  role: string;
  name: string;
  near?: string;
  value_state?: ValueState;
  matches_required?: boolean;
  expanded?: boolean;
  checked?: boolean;
  selected?: boolean;
  disabled?: boolean;
  offscreen?: boolean;
  occluded?: boolean;
  /** Inside the fixed layer that covers an occluded control. */
  covering_layer?: boolean;
  submit?: boolean;
};

export function hashState(state: unknown) {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 24);
}
