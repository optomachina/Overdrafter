export const PROVIDER_NOTES_PREVIEW_CHARS = 240;

/**
 * `raw_payload.notesSource` value that marks an offer's `notes` as text copied from the
 * provider's own page. The worker writes it (worker/src/vendorQuoteOffer.ts) only from
 * `providerNotes`; worker automation status goes to `raw_payload.workerNotes` instead.
 */
export const PROVIDER_NOTES_SOURCE = "provider";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The only path from an offer row to the customer "Provider notes" block. Rows persisted
 * before OVD-982 hold worker automation text in `notes` with no marker, so `notes` alone is
 * never trusted: it counts only when the offer's own raw_payload says it is provider-sourced.
 */
export function resolveProviderNotes(notes: unknown, offerRawPayload: unknown): string | null {
  if (typeof notes !== "string" || notes.trim().length === 0) {
    return null;
  }
  return asRecord(offerRawPayload)?.notesSource === PROVIDER_NOTES_SOURCE ? notes : null;
}

/** Worker automation status persisted in `raw_payload.workerNotes`; internal views only. */
export function readWorkerNotes(offerRawPayload: unknown): string[] {
  const workerNotes = asRecord(offerRawPayload)?.workerNotes;
  if (!Array.isArray(workerNotes)) {
    return [];
  }
  return workerNotes
    .filter((note): note is string => typeof note === "string")
    .map((note) => note.trim())
    .filter(Boolean);
}
export const PROVIDER_NOTES_MAX_CHARS = 2000;

// C0/C1 controls, zero-width and bidi-override characters, built from escapes.
// eslint-disable-next-line no-control-regex -- stripping control characters is the purpose
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

// Hard bound applied before any regex so work is linear in a small constant.
const RAW_INPUT_LIMIT = PROVIDER_NOTES_MAX_CHARS * 4;

/**
 * Reduce provider text to bounded plain text. No HTML interpretation or tag
 * stripping: React renders the result as inert text, and stripping would delete
 * legitimate notes such as "<0.005 in" or "price > $100".
 */
export function sanitizeProviderNotes(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const cleaned = raw
    .slice(0, RAW_INPUT_LIMIT)
    .replace(UNSAFE_CHARS, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
  if (!cleaned) {
    return null;
  }
  const points = Array.from(cleaned);
  return points.length > PROVIDER_NOTES_MAX_CHARS
    ? `${points.slice(0, PROVIDER_NOTES_MAX_CHARS).join("").trimEnd()}…`
    : cleaned;
}
