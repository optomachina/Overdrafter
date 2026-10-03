/** Local source observations only. Never serialize these records into a model
 * request, audit or customer payload; a separately admitted projector owns that
 * boundary. Text/attributes are untrusted provider evidence, not instructions. */
export type ProviderObservedSpan = Readonly<{
  field: "amount" | "currency" | "quantity" | "revision" | "firmness";
  start: number;
  end: number;
  text: string;
}>;

export type XometryQuoteDocument = Readonly<{
  /** Unique within this observation, not a claimed provider-stable identity. */
  evidenceId: string;
  selector: string;
  text: string;
  tierText: string | null;
  attributes: Readonly<Record<string, string>>;
  spans: readonly ProviderObservedSpan[];
  unavailableFields: readonly ProviderObservedSpan["field"][];
}>;

export type XometryQuoteObservation = Readonly<{
  kind: "quote";
  provider: "xometry";
  /** Request context only; never proof of a provider-observed quantity. */
  requestedQuantity: number;
  documents: readonly XometryQuoteDocument[];
}>;

export type XometryCatalogObservation = Readonly<{
  kind: "catalog";
  provider: "xometry";
  field: "material" | "finish";
  controlSelector: string;
  optionSelector: string;
  label: string | null;
  attributes: Readonly<Record<string, string>>;
  deterministicTerm: string;
  /** Custom widgets expose no reviewed complete engineering catalog. Even an
   * observed DOM id/value does not establish stable catalog identity. */
  catalogStatus: "unavailable";
  reason: "custom_widget_engineering_catalog_unavailable";
}>;

export type XometryPresentationObservation = Readonly<{
  kind: "presentation";
  provider: "xometry";
  evidenceId: string;
  parentEvidenceId: string;
  origin: "xometry_tier_presentation_badge";
  optionalCategory: "marketing";
  selector: '[data-testid="tierAndLeadTime"]';
  field: "tierText";
  text: "Least Expensive" | "Fastest" | "Best Value";
  start: number;
  end: number;
}>;

export type XometryUnavailableObservation = Readonly<{
  kind: "unavailable";
  provider: "xometry";
  boundary: "quote" | "catalog";
  reason: "observation_budget_exceeded" | "observation_capture_failed";
}>;

export const XOMETRY_OBSERVATION_LIMITS = Object.freeze({
  documents: 64, textCodeUnits: 65_536, attributeCodeUnits: 16_384, spans: 256,
});

export function unavailableXometryObservation(
  boundary: "quote" | "catalog",
  reason: XometryUnavailableObservation["reason"] = "observation_budget_exceeded",
): XometryUnavailableObservation {
  return Object.freeze({ kind: "unavailable", provider: "xometry", boundary, reason });
}

export type XometryProviderObservation = XometryQuoteObservation | XometryCatalogObservation | XometryPresentationObservation | XometryUnavailableObservation;
/** Synchronous local capture only. Enqueue an immutable record for later scoped
 * review; do not start inference, network work or mutate provider state here. */
export type XometryProviderObserver = (
  observation: XometryProviderObservation,
) => undefined;

/** A lexical span is an exact candidate, never an assertion of commercial
 * truth: e.g. "not a firm quote" remains that complete line. Offsets address
 * the exact extractor-observed (trimmed) text, not HTML or a made-up document. */
function observedSpans(text: string, remaining: number): readonly ProviderObservedSpan[] | null {
  const patterns: readonly [ProviderObservedSpan["field"], RegExp][] = [
    ["amount", /(?:US\$|\$|€|£|¥)\s*[\d,]+(?:\.\d+)?/g],
    ["currency", /\b(?:USD|CAD|AUD|NZD|HKD|SGD|EUR|GBP|JPY|CNY)\b/g],
    ["quantity", /^[^\r\n]*\b(?:quantity|qty)\s*[:=][^\r\n]*/gim],
    ["revision", /^[^\r\n]*\b(?:revision|rev)\s*[:=][^\r\n]*/gim],
    ["firmness", /^[^\r\n]*\b(?:firm|estimate|estimated|budgetary|nonbinding|non-binding)\b[^\r\n]*/gim],
  ];
  const spans: ProviderObservedSpan[] = [];
  for (const [field, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (spans.length >= remaining) return null;
      spans.push(Object.freeze({ field, start: match.index!, end: match.index! + match[0].length, text: match[0] }));
    }
  }
  return Object.freeze(spans);
}

export function createXometryQuoteObservation(
  snapshots: readonly {
    selector: string; text: string; tierText?: string; attributes: Record<string, string>;
  }[],
  requestedQuantity: number,
): XometryQuoteObservation | XometryUnavailableObservation {
  if (snapshots.length > XOMETRY_OBSERVATION_LIMITS.documents) return unavailableXometryObservation("quote");
  let textCodeUnits = 0;
  let attributeCodeUnits = 0;
  for (const snapshot of snapshots) {
    textCodeUnits += snapshot.text.length + (snapshot.tierText?.length ?? 0) + snapshot.selector.length;
    if (textCodeUnits > XOMETRY_OBSERVATION_LIMITS.textCodeUnits) return unavailableXometryObservation("quote");
    for (const [name, value] of Object.entries(snapshot.attributes)) {
      attributeCodeUnits += name.length + value.length;
      if (attributeCodeUnits > XOMETRY_OBSERVATION_LIMITS.attributeCodeUnits) return unavailableXometryObservation("quote");
    }
  }
  let remainingSpans = XOMETRY_OBSERVATION_LIMITS.spans;
  const documents: XometryQuoteDocument[] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    const spans = observedSpans(snapshot.text, remainingSpans);
    if (!spans) return unavailableXometryObservation("quote");
    remainingSpans -= spans.length;
    const fields: ProviderObservedSpan["field"][] = ["amount", "currency", "quantity", "revision", "firmness"];
    documents.push(Object.freeze({
      evidenceId: `xometry-quote-option-${index}`, selector: snapshot.selector,
      text: snapshot.text, tierText: snapshot.tierText ?? null,
      attributes: Object.freeze({ ...snapshot.attributes }), spans,
      unavailableFields: Object.freeze(fields.filter((field) => !spans.some((span) => span.field === field))),
    }));
  }
  return Object.freeze({
    kind: "quote", provider: "xometry", requestedQuantity,
    documents: Object.freeze(documents),
  });
}

/** Never await a callback on the provider path. Runtime callers that violate
 * the synchronous contract have their returned promise rejection consumed;
 * their own work cannot be cancelled or made safe by this capture boundary. */
export function notifyXometryObserver(
  observer: XometryProviderObserver | undefined,
  observation: XometryProviderObservation,
): void {
  if (!observer) return;
  try {
    const returned: unknown = observer(observation);
    if (returned !== undefined) {
      void Promise.resolve(returned).catch(() => undefined);
    }
  } catch { /* Non-authoritative observation. */ }
}
