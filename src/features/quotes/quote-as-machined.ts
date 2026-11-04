/**
 * OVD-1163: the customer's "Quote as machined" choice, a quote-only finish
 * override stored as spec_snapshot.quoteAsMachined = { finish } by
 * public.api_set_client_part_quote_as_machined. It applies only while it names
 * the part's current finish, compared the way the server compares finishes
 * (trimmed, lowercased, every character outside a-z and 0-9 dropped). The
 * drawing finish itself is never changed.
 */
function normalizeFinish(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isQuotedAsMachined(finish: string | null | undefined, specSnapshot: unknown): boolean {
  const normalized = normalizeFinish(finish ?? "");
  if (normalized === "" || normalized === "asmachined") return false;
  const choice = isRecord(specSnapshot) ? specSnapshot.quoteAsMachined : null;
  return isRecord(choice) && typeof choice.finish === "string" && normalizeFinish(choice.finish) === normalized;
}

/** A finish that changes the price: not blank and not as machined. */
export function hasPricedFinish(finish: string | null | undefined): boolean {
  const normalized = normalizeFinish(finish ?? "");
  return normalized !== "" && normalized !== "asmachined";
}

/**
 * OVD-1163: how the part page labels its quotes. The label follows what each
 * quote was priced for (the finish its offer recorded), not the current
 * choice, so quotes priced with the finish before the choice are never
 * labelled as machined, and as-machined quotes keep their label if the choice
 * is later withdrawn.
 */
export function asMachinedQuoteLabel(
  drawingFinish: string | null | undefined,
  options: ReadonlyArray<{ finish?: string | null }>,
): string | null {
  if (!hasPricedFinish(drawingFinish)) return null;
  const asMachined = options.filter((option) => normalizeFinish(option.finish ?? "") === "asmachined").length;
  if (asMachined === 0) return null;
  const finish = (drawingFinish ?? "").trim();
  return asMachined === options.length
    ? `Quoted as machined. Prices don't include the finish (${finish}).`
    : `Some quotes are as machined. Their prices don't include the finish (${finish}).`;
}
