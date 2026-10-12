import { types as nodeTypes } from "node:util";
import { isObservedXometryQuoteDocument, isObservedXometryPresentation } from "../adapters/xometryOffers.js";
import type { QuoteEvidenceInput } from "../quoteIntelligence/quoteEvidence.js";
import type { XometryProviderObservation, XometryQuoteDocument } from "./providerObservations.js";
import type { RequirementProvenanceProjection, AvailableRequirementProvenance } from "./requirementProvenance.js";

/** Aggregate limits, not per-observation allowances. Nothing is truncated. */
export const QUOTE_DOCUMENT_LIMITS = Object.freeze({
  observations: 132, documents: 64, textCodeUnits: 65_536, attributeCodeUnits: 16_384,
  spans: 256, lines: 2048, lineCodeUnits: 2000,
});
export type QuoteDocumentRefusal = "incomplete_source" | "invalid_source" | "source_budget"
  | "requirement_unavailable" | "unsupported_context" | "conflicting_context"
  | "missing_firm_total" | "competing_firm_totals";
type Span = QuoteEvidenceInput["spans"][number];
type Money = Readonly<{ amount: number; decimal: string }>;
type Role =
  | Readonly<{ kind: "firm_total"; money: Money; quantity: number; revision: string }>
  | Readonly<{ kind: "auxiliary_total" | "unit"; money: Money }>
  | Readonly<{ kind: "quantity"; quantity: number }>
  | Readonly<{ kind: "revision"; revision: string }>
  | Readonly<{ kind: "engineering" | "reference" | "presentation" }>;
export type ParsedQuoteLine = Readonly<{ start: number; end: number; text: string; role: Role }>;
export type QuoteDocumentResult = Readonly<{
  status: "unavailable"; reason: QuoteDocumentRefusal; publicationAllowed: false;
}> | Readonly<{
  status: "available";
  /** Entirely local; source text, prices and requirement values must not be disclosed. */
  candidate: Readonly<{ document: XometryQuoteDocument; span: Readonly<Span> }>;
  documents: readonly Readonly<{ document: XometryQuoteDocument; lines: readonly ParsedQuoteLine[] }>[];
  evidenceInput: QuoteEvidenceInput;
  /** The only model-facing projection. Its single candidate is established before inference. */
  facts: Readonly<{ candidates: readonly [Readonly<{
    key: "span_0"; firmTotal: true; quantityMatches: true; revisionMatches: true; explicitUsd: true;
  }>] }>;
  publicationAllowed: false;
}>;
export type QuoteDocumentInput = Readonly<{
  /** Pass the entire capture, including unavailable records. Never filter/deduplicate it. */
  observations: readonly XometryProviderObservation[];
  overflow: boolean;
  requirement: RequirementProvenanceProjection;
}>;

const amountSyntax = String.raw`(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.[0-9]{2})?`;
const firmSyntax = new RegExp(String.raw`^Firm total (USD) (${amountSyntax}) quantity: ([1-9][0-9]*) revision: ([A-Za-z0-9_-]{1,80})$`, "i");
const auxiliarySyntax = new RegExp(String.raw`^(USD) \$?(${amountSyntax})(?: (ea\.|each|per piece))?$`, "i");
const labelSyntax = /^(?:Standard|Economy|Expedited|Rush|Least Expensive|Fastest|Best Value)$/i;
const leadSyntax = /^(?:Lead time: )?([1-9][0-9]*) (?:business|working|calendar) days?$/i;
const combinedTierSyntax = /^(?:Standard|Economy|Expedited|Rush|Least Expensive|Fastest|Best Value) - Lead Time: ([1-9][0-9]*) (?:business|working|calendar) days?$/i;
const identifierSyntax = /^[A-Za-z0-9._-]{1,80}$/;
// These identifiers would be interpreted as contrary basis/firmness or another money
// token by the existing verbatim-span validator. Refuse, never rewrite the revision.
const ambiguousRevision = /\b(?:unit|each|per|piece|not|non|no|estimate|estimated|budgetary|indicative)\b|(?:USD|EUR)[0-9]/i;
function refuse(reason: QuoteDocumentRefusal): never { throw new Refusal(reason); }
class Refusal extends Error { constructor(readonly reason: QuoteDocumentRefusal) { super(reason); } }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Array.isArray(value)) return refuse("invalid_source");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return refuse("invalid_source");
  return value as Record<string, unknown>;
}
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return refuse("invalid_source");
  return descriptor.value;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) refuse("invalid_source");
    own(value, key);
  }
}
function array(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return refuse("invalid_source");
  if (value.length > max) return refuse("source_budget");
  if (Reflect.ownKeys(value).length !== value.length + 1) return refuse("invalid_source");
  for (let i = 0; i < value.length; i++) own(value, String(i));
  return value;
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string") return refuse("invalid_source");
  if (value.length > max) return refuse("source_budget");
  // No invisible separators or control characters masquerading as harmless whitespace.
  if (/[^\x20-\x7e\t\r\n]/.test(value) || /\r(?!\n)/.test(value)) return refuse("unsupported_context");
  return value;
}
function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return refuse("invalid_source");
  return value;
}
function money(currency: string, token: string): Money {
  // Existing selectQuoteEvidence requires literal uppercase USD in the verbatim span.
  // The one parser refuses all other currency spellings; there is no second extraction dialect.
  if (currency !== "USD") return refuse("unsupported_context");
  const [whole, fractional = "00"] = token.replaceAll(",", "").split(".");
  const cents = BigInt(whole + fractional);
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) return refuse("unsupported_context");
  return Object.freeze({ amount: Number(token.replaceAll(",", "")), decimal: `${whole}.${fractional}` });
}
function presentation(line: string): boolean {
  if (labelSyntax.test(line)) return true;
  const match = leadSyntax.exec(line) ?? combinedTierSyntax.exec(line);
  return !!match && Number.isSafeInteger(Number(match[1]));
}
/** Sole grammar and extraction implementation. An unparsed line never becomes ignorable. */
function parseLine(line: string, requirement: AvailableRequirementProvenance): Role {
  const firm = firmSyntax.exec(line);
  if (firm) return Object.freeze({ kind: "firm_total", money: money(firm[1], firm[2]),
    quantity: positiveInteger(Number(firm[3])), revision: firm[4] });
  const auxiliary = auxiliarySyntax.exec(line);
  if (auxiliary) return Object.freeze({ kind: auxiliary[3] ? "unit" : "auxiliary_total", money: money(auxiliary[1], auxiliary[2]) });
  const quantity = /^(?:Qty|Quantity)[:=] ([1-9][0-9]*)$/i.exec(line);
  if (quantity) return Object.freeze({ kind: "quantity", quantity: positiveInteger(Number(quantity[1])) });
  const revision = /^(?:Rev|Revision)[:=] ([A-Za-z0-9_-]{1,80})$/i.exec(line);
  if (revision) return Object.freeze({ kind: "revision", revision: revision[1] });
  if (/^(?:Reference|Quote ID|Quote reference|Part number): [A-Za-z0-9._-]{1,80}$/.test(line)) return Object.freeze({ kind: "reference" });
  const engineering = /^(Material|Finish|Process): (.+)$/.exec(line);
  if (engineering) {
    const field = engineering[1].toLowerCase() as "material" | "finish" | "process";
    const fact = record(own(record(own(requirement, "fields")), field));
    if (own(fact, "state") === "observed" && own(fact, "value") === engineering[2]) return Object.freeze({ kind: "engineering" });
    return refuse("conflicting_context");
  }
  if (presentation(line)) return Object.freeze({ kind: "presentation" });
  return refuse("unsupported_context");
}
function freezeTree<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Pure local complete-source parser. Each quote document must pass the existing collector-origin
 * guard. This grants no permission to disclose/publish. Pass the ENTIRE capture here, including
 * overflow/unavailable records, before reservation.
 * Do not call once per record and retain successes. There is deliberately no exported single-doc
 * success API. Unknown records and any invalid line deny the entire aggregate with no candidate.
 *
 * Supported source is ASCII, LF/CRLF, bounded references, exact approved engineering fields,
 * tier/lead labels, explicit quantities/revisions, USD unit/auxiliary lines and one firm total.
 * All currency tokens must literally be USD. Other keyword case is accepted. Unit prices are
 * retained with unit basis only; no arithmetic, price derivation or unit-to-total fallback occurs.
 * Auxiliary totals require an equal explicit total in their own document. Duplicate firm lines,
 * documents and observations are competing evidence, even when their amounts are equal.
 * Ordinary catalog/presentation records are validated as separate noncommercial collector roles;
 * every quote document's text, tier text and attributes are checked. No source text is rewritten.
 */
export function parseQuoteDocuments(input: QuoteDocumentInput): QuoteDocumentResult {
  try {
    record(input);
    if (own(input, "overflow") !== false) return refuse("incomplete_source");
    const requirement = record(own(input, "requirement"));
    if (own(requirement, "status") !== "available") return refuse("requirement_unavailable");
    const fields = record(own(requirement, "fields"));
    const revisionFact = record(own(fields, "revision"));
    if (own(revisionFact, "state") !== "observed") return refuse("requirement_unavailable");
    const requestedRevision = string(own(revisionFact, "value"), 80);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(requestedRevision) || ambiguousRevision.test(requestedRevision)) return refuse("requirement_unavailable");
    const requestedQuantity = positiveInteger(own(record(own(requirement, "binding")), "requestedQuantity"));
    const observations = array(own(input, "observations"), QUOTE_DOCUMENT_LIMITS.observations);
    let textBudget = 0, attributeBudget = 0, spansBudget = 0, lineBudget = 0;
    const parsed: Array<{ document: XometryQuoteDocument; lines: readonly ParsedQuoteLine[] }> = [];
    const candidates: Array<{ document: XometryQuoteDocument; span: Span }> = [];
    const consumeText = (value: unknown, max: number = QUOTE_DOCUMENT_LIMITS.textCodeUnits) => {
      const result = string(value, max);
      textBudget += result.length;
      if (textBudget > QUOTE_DOCUMENT_LIMITS.textCodeUnits) refuse("source_budget");
      return result;
    };
    for (const rawObservation of observations) {
      const observation = record(rawObservation);
      if (own(observation, "provider") !== "xometry") refuse("invalid_source");
      const kind = own(observation, "kind");
      // Separate non-quote records cannot establish or cancel commercial claims.
      if (kind === "catalog") {
        keys(observation, ["kind", "provider", "field", "controlSelector", "optionSelector", "label", "attributes", "deterministicTerm", "catalogStatus", "reason"]);
        if (own(observation, "field") !== "material" && own(observation, "field") !== "finish"
          || own(observation, "catalogStatus") !== "unavailable"
          || own(observation, "reason") !== "custom_widget_engineering_catalog_unavailable") refuse("invalid_source");
        for (const name of ["controlSelector", "optionSelector", "deterministicTerm"]) consumeText(own(observation, name));
        const label = own(observation, "label");
        if (label !== null) consumeText(label);
        const attributes = record(own(observation, "attributes"));
        if (Reflect.ownKeys(attributes).length > 128) refuse("source_budget");
        for (const name of Reflect.ownKeys(attributes)) {
          if (typeof name !== "string") refuse("invalid_source");
          attributeBudget += name.length + string(own(attributes, name), QUOTE_DOCUMENT_LIMITS.attributeCodeUnits).length;
          if (attributeBudget > QUOTE_DOCUMENT_LIMITS.attributeCodeUnits) refuse("source_budget");
        }
        continue;
      }
      if (kind === "presentation") {
        if (!isObservedXometryPresentation(rawObservation)) refuse("invalid_source");
        keys(observation, ["kind", "provider", "evidenceId", "parentEvidenceId", "origin", "optionalCategory", "selector", "field", "text", "start", "end"]);
        if (own(observation, "origin") !== "xometry_tier_presentation_badge" || own(observation, "optionalCategory") !== "marketing"
          || own(observation, "field") !== "tierText" || !["Least Expensive", "Fastest", "Best Value"].includes(consumeText(own(observation, "text")))) refuse("invalid_source");
        for (const name of ["evidenceId", "parentEvidenceId", "selector"]) consumeText(own(observation, name));
        continue;
      }
      if (kind === "unavailable") return refuse("incomplete_source");
      if (kind !== "quote") return refuse("invalid_source");
      keys(observation, ["kind", "provider", "requestedQuantity", "documents"]);
      if (own(observation, "requestedQuantity") !== requestedQuantity) refuse("conflicting_context");
      const documents = array(own(observation, "documents"), QUOTE_DOCUMENT_LIMITS.documents);
      if (!documents.length) refuse("incomplete_source");
      for (const rawDocument of documents) {
        if (parsed.length >= QUOTE_DOCUMENT_LIMITS.documents) refuse("source_budget");
        if (!isObservedXometryQuoteDocument(rawDocument)) refuse("invalid_source");
        const document = record(rawDocument);
        keys(document, ["evidenceId", "selector", "text", "tierText", "attributes", "spans", "unavailableFields"]);
        if (!identifierSyntax.test(consumeText(own(document, "evidenceId"), 80))) refuse("invalid_source");
        const selector = consumeText(own(document, "selector"), 500);
        if (!selector.trim() || /[\r\n]/.test(selector)) refuse("invalid_source");
        const text = consumeText(own(document, "text"));
        const tierText = own(document, "tierText");
        if (tierText !== null) {
          const tier = consumeText(tierText);
          if (tier && !presentation(tier)) refuse("unsupported_context");
        }
        const attributes = record(own(document, "attributes"));
        keys(attributes, ["data-option-id", "data-tier-id", "data-testid", "value", "id", "aria-label", "disabled", "aria-disabled", "data-disabled", "data-available"]);
        for (const name of Object.keys(attributes)) {
          const value = string(own(attributes, name), QUOTE_DOCUMENT_LIMITS.attributeCodeUnits);
          attributeBudget += name.length + value.length;
          if (attributeBudget > QUOTE_DOCUMENT_LIMITS.attributeCodeUnits) refuse("source_budget");
          if (name === "aria-label") { if (!presentation(value)) refuse("unsupported_context"); }
          else if (name === "disabled") refuse("conflicting_context");
          else if (["aria-disabled", "data-disabled"].includes(name)) { if (value !== "false") refuse("conflicting_context"); }
          else if (name === "data-available") { if (value !== "true") refuse("conflicting_context"); }
          else if (!identifierSyntax.test(value)) refuse("unsupported_context");
        }
        const spans = array(own(document, "spans"), QUOTE_DOCUMENT_LIMITS.spans);
        spansBudget += spans.length;
        if (spansBudget > QUOTE_DOCUMENT_LIMITS.spans) refuse("source_budget");
        // Lexical collector spans are never used to omit any part of the full text.
        for (const rawSpan of spans) {
          const span = record(rawSpan);
          keys(span, ["field", "start", "end", "text"]);
          const start = own(span, "start"), end = own(span, "end");
          if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0
            || typeof end !== "number" || !Number.isSafeInteger(end) || end <= start || end > text.length
            || own(span, "text") !== text.slice(start, end)
            || !["amount", "currency", "quantity", "revision", "firmness"].includes(string(own(span, "field"), 16))) refuse("invalid_source");
        }
        for (const field of array(own(document, "unavailableFields"), 5)) {
          if (typeof field !== "string" || !["amount", "currency", "quantity", "revision", "firmness"].includes(field)) refuse("invalid_source");
        }
        const lines: ParsedQuoteLine[] = [];
        const localFirm: Array<{ line: ParsedQuoteLine; role: Extract<Role, { kind: "firm_total" }> }> = [];
        for (const match of text.matchAll(/[^\r\n]+/g)) {
          if (++lineBudget > QUOTE_DOCUMENT_LIMITS.lines || match[0].length > QUOTE_DOCUMENT_LIMITS.lineCodeUnits) refuse("source_budget");
          const line = match[0].replace(/^[ \t]+|[ \t]+$/g, "");
          if (!line) continue;
          const role = parseLine(line, input.requirement as AvailableRequirementProvenance);
          const parsedLine = Object.freeze({ start: match.index!, end: match.index! + match[0].length, text: match[0], role });
          lines.push(parsedLine);
          if ((role.kind === "firm_total" || role.kind === "quantity") && role.quantity !== requestedQuantity
            || (role.kind === "firm_total" || role.kind === "revision") && role.revision !== requestedRevision) refuse("conflicting_context");
          if (role.kind === "firm_total") localFirm.push({ line: parsedLine, role });
        }
        if (!lines.length) refuse("incomplete_source");
        if (localFirm.length > 1) refuse("competing_firm_totals");
        if (!localFirm.length) refuse("missing_firm_total");
        const firm = localFirm[0];
        if (lines.some((line) => line.role.kind === "auxiliary_total" && line.role.money.decimal !== firm.role.money.decimal)) refuse("conflicting_context");
        const span: Span = { id: "candidate-0", start: firm.line.start, end: firm.line.end, text: firm.line.text,
          amount: firm.role.money.amount, currency: "USD", basis: "total", firmness: "firm", quantity: firm.role.quantity,
          revision: firm.role.revision, source: "selector", selector };
        // The actual collector freezes the complete source. Preserve its origin and identity.
        parsed.push({ document: rawDocument, lines }); candidates.push({ document: rawDocument, span });
      }
    }
    if (!candidates.length) refuse("missing_firm_total");
    if (candidates.length !== 1) refuse("competing_firm_totals");
    const candidate = candidates[0];
    return freezeTree({ status: "available", candidate, documents: parsed,
      evidenceInput: { document: candidate.document.text, spans: [candidate.span], requestedQuantity, requestedRevision, requestedCurrency: "USD" },
      facts: { candidates: [{ key: "span_0", firmTotal: true, quantityMatches: true, revisionMatches: true, explicitUsd: true }] },
      publicationAllowed: false });
  } catch (error) {
    return Object.freeze({ status: "unavailable", reason: error instanceof Refusal ? error.reason : "invalid_source", publicationAllowed: false });
  }
}
