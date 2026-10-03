/**
 * Shared redaction for provider-portal evidence. Every adapter generation that
 * persists portal text or markup must route it through these functions so the
 * same token, cookie, and account-identifier rules apply everywhere.
 */

/** Removes credentials and account/customer identifiers without reshaping the input. */
function redactProviderIdentifiers(value: string): string {
  return scrubEmailTokens(value)
    .replace(/\b(token|session|authorization|cookie)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/\b(account|customer|order|quote)[^\r\n:#=]{0,24}[:#=][^\s]+/gi, "$1=<redacted>")
    .replace(/\+?\d[\d ().-]{8,}\d/g, "<redacted-phone>")
    .replace(/\b[a-f0-9]{32,}\b/gi, "<redacted-identifier>");
}

function scrubEmailTokens(value: string): string {
  return value.replace(/\S+/g, (token) => {
    const atIndex = token.indexOf("@");
    const lastDotIndex = token.lastIndexOf(".");
    return atIndex > 0 && lastDotIndex > atIndex + 1
      ? "<redacted-email>"
      : token;
  });
}

/** Removes common account/customer identifiers before any portal text is persisted. */
export function scrubProviderEvidenceText(value: string, maxLength = 2_000): string {
  return redactProviderIdentifiers(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

// Inline scripts carry hydrated session state (tokens, user profiles, CSRF
// values) that the text rules cannot reliably recognize inside JSON.
const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
// Attribute values that hold form input, meta tokens, or named session/account data.
const SENSITIVE_ATTRIBUTE =
  /(\s)((?:[\w:-]*(?:token|session|auth|csrf|xsrf|secret|key|email|phone|user|account|customer)[\w:-]*)|value|content)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/gi;
// URL-bearing attributes can embed signed query strings or account fragments.
const URL_ATTRIBUTE = /(\s)(href|src|srcset|action|formaction|poster)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/gi;

function stripUrlQueries(quotedValue: string): string {
  const quote = quotedValue.startsWith("\"") || quotedValue.startsWith("'") ? quotedValue[0] : "";
  const inner = quote ? quotedValue.slice(1, -1) : quotedValue;
  return `${quote}${inner.replace(/[?#][^\s,]*/g, "")}${quote}`;
}

/**
 * Redacts a captured portal DOM before it is written to disk or uploaded.
 * Structure needed for selector diagnosis is kept; scripts, form values,
 * sensitive attribute values, and URL query strings are removed, then the
 * shared identifier rules run over the remaining markup.
 */
export function redactProviderPortalHtml(html: string): string {
  const structural = html
    .replace(SCRIPT_BLOCK, "<script data-overdrafter-redacted=\"script\"></script>")
    .replace(SENSITIVE_ATTRIBUTE, "$1$2$3\"<redacted>\"")
    .replace(URL_ATTRIBUTE, (_match, space: string, name: string, equals: string, value: string) =>
      `${space}${name}${equals}${stripUrlQueries(value)}`);
  return redactProviderIdentifiers(structural);
}
