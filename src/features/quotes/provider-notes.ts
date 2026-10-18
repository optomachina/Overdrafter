export const PROVIDER_NOTES_PREVIEW_CHARS = 240;
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
