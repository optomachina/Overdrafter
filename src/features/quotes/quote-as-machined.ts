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
