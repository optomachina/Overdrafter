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
// Text areas hold user-entered form input; keep the element, drop its content.
const TEXTAREA_BLOCK = /(<textarea\b[^>]*>)[\s\S]*?(<\/textarea\s*>)/gi;
// Any attribute assignment. The attribute name and value decide what happens,
// which keeps the pattern linear instead of backtracking over name variants.
const ATTRIBUTE = /(\s)([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/g;
// Attribute names that hold meta tokens or named session/account data.
const SENSITIVE_ATTRIBUTE_NAME = /token|session|auth|csrf|xsrf|secret|key|email|phone|user|account|customer/i;
// Attributes that hold form input or meta values.
const VALUE_ATTRIBUTES = new Set(["value", "content"]);
// URL-bearing attributes can embed signed query strings or account fragments.
const URL_ATTRIBUTES = new Set(["href", "src", "srcset", "action", "formaction", "poster"]);
// Any other attribute whose value is a URL (for example xlink:href or data-src)
// can carry the same signed query string: absolute and protocol-relative URLs,
// and root- or dot-relative paths such as "/asset?Signature=..." or "./a?sig=",
// including directory-only ones whose query or fragment follows the slash
// directly, such as "/?Signature=..." or "../#frag".
const URL_VALUE = /^["']?\s*(?:(?:[a-z][a-z\d+.-]*:)?\/\/[^\s"'/]|\.{0,2}\/[\w~%.?#-])/i;
// Hydration payloads (JSON, usually entity-encoded) can hold tokens under any attribute name.
const STRUCTURED_VALUE = /\{|\[\s*(?:"|&quot;)/;
// Signed asset URLs in CSS, in style attributes and <style> blocks.
const CSS_URL_QUERY = /(url\(\s*(?:["']|&quot;)?[^"'()?#\s]*)[?#][^"'()\s]*/gi;
// Bearer credentials and JWT-shaped tokens, wherever they appear.
const BEARER_CREDENTIAL = /\b(bearer)\s+[\w.~+/=-]+/gi;
const JWT_SHAPE = /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g;

function stripUrlQueries(quotedValue: string): string {
  const quote = quotedValue.startsWith("\"") || quotedValue.startsWith("'") ? quotedValue[0] : "";
  const inner = quote ? quotedValue.slice(1, -1) : quotedValue;
  return `${quote}${inner.replace(/[?#][^\s,]*/g, "")}${quote}`;
}

function redactAttribute(match: string, space: string, name: string, equals: string, value: string): string {
  const lowerName = name.toLowerCase();
  if (VALUE_ATTRIBUTES.has(lowerName) || SENSITIVE_ATTRIBUTE_NAME.test(lowerName) || STRUCTURED_VALUE.test(value)) {
    return `${space}${name}${equals}"<redacted>"`;
  }
  if (URL_ATTRIBUTES.has(lowerName) || URL_VALUE.test(value)) {
    return `${space}${name}${equals}${stripUrlQueries(value)}`;
  }
  return match;
}

/**
 * Redacts a captured portal DOM before it is written to disk or uploaded.
 * Structure needed for selector diagnosis is kept. Scripts, text-area input,
 * form values, sensitive or structured attribute values, URL query strings
 * (in URL attributes and in any attribute whose value is a URL or path), bearer
 * credentials, and JWT-shaped tokens are removed, then the shared
 * identifier rules run over the remaining markup.
 */
export function redactProviderPortalHtml(html: string): string {
  const structural = html
    .replace(SCRIPT_BLOCK, "<script data-overdrafter-redacted=\"script\"></script>")
    .replace(TEXTAREA_BLOCK, "$1$2")
    .replace(ATTRIBUTE, redactAttribute)
    .replace(CSS_URL_QUERY, "$1")
    .replace(BEARER_CREDENTIAL, "$1 <redacted>")
    .replace(JWT_SHAPE, "<redacted-token>");
  return redactProviderIdentifiers(structural);
}
