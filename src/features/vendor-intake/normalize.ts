// Pure vendor-intake normalizer, validator and dedupe-key builder (VI-2).
// No I/O: nothing here fetches, resolves DNS, reads files or touches the network.
// Callers map the stable `reason` codes to UI copy.

export const VENDOR_INTAKE_LIMITS = {
  urlMaxLength: 2048,
  hostMaxLength: 253,
  labelMaxLength: 63,
  nameMaxLength: 120,
  notesMaxLength: 2000,
} as const;

export type VendorIntakeReason =
  | "empty"
  | "too_long"
  | "url_invalid"
  | "url_scheme_unsupported"
  | "url_has_userinfo"
  | "url_port_unsupported"
  | "host_is_ip_literal"
  | "host_not_public"
  | "host_invalid"
  | "host_mixed_script";

export type VendorIntakeResult<T> = { ok: true; value: T } | { ok: false; reason: VendorIntakeReason };

export type CanonicalVendorUrl = {
  /** Canonical https URL: no www, tracking params, fragment or trailing slash. */
  url: string;
  /** Lowercase ASCII (punycode) host without leading www. */
  host: string;
  dedupeKey: string;
};

export type VendorIntakeInput = { name: string; url: string; notes?: string | null };
export type VendorIntakeValue = CanonicalVendorUrl & { name: string; notes: string };
export type VendorIntakeFieldResult =
  | { ok: true; value: VendorIntakeValue }
  | { ok: false; field: "name" | "url" | "notes"; reason: VendorIntakeReason };

const fail = (reason: VendorIntakeReason): { ok: false; reason: VendorIntakeReason } => ({ ok: false, reason });

const TRACKING_PARAM = /^(utm_.*|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi)$/i;
const NON_PUBLIC_SUFFIXES = [
  "internal", "local", "localhost", "localdomain", "lan", "home", "home.arpa", "corp", "intranet",
  "test", "example", "invalid", "onion",
];
const LETTER_SCRIPTS = ["Latin", "Cyrillic", "Greek", "Armenian", "Hebrew", "Arabic", "Han", "Hiragana", "Katakana", "Hangul"];
const SCRIPT_PATTERNS = LETTER_SCRIPTS.map((script) => new RegExp(`\\p{Script=${script}}`, "u"));
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const ASCII_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const URL_FORBIDDEN_CHARS = /[\p{Cc}\s]/u;

function hasMixedScriptLabel(host: string): boolean {
  return host.split(".").some((label) => SCRIPT_PATTERNS.filter((pattern) => pattern.test(label)).length > 1);
}

/** RFC 3492 punycode decoder (pure). Returns null when the label is not valid punycode. */
function decodePunycode(input: string): string | null {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  const lastDash = input.lastIndexOf("-");
  const output: number[] = [];
  for (let j = 0; j < Math.max(lastDash, 0); j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return null;
    output.push(c);
  }
  const adapt = (delta: number, numPoints: number, first: boolean): number => {
    let d = first ? Math.floor(delta / damp) : delta >> 1;
    d += Math.floor(d / numPoints);
    let k = 0;
    while (d > ((base - tMin) * tMax) >> 1) {
      d = Math.floor(d / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * d) / (d + skew));
  };
  let n = 0x80, i = 0, bias = 72;
  let index = lastDash > 0 ? lastDash + 1 : 0;
  while (index < input.length) {
    const oldI = i;
    for (let w = 1, k = base; ; k += base) {
      if (index >= input.length) return null;
      const c = input.charCodeAt(index++);
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : c >= 65 && c <= 90 ? c - 65 : base;
      if (digit >= base) return null;
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    const len = output.length + 1;
    bias = adapt(i - oldI, len, oldI === 0);
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff) return null;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

/** Decodes xn-- labels to Unicode; null if any xn-- label is not valid punycode. */
function decodeHostLabels(host: string): string | null {
  const decoded: string[] = [];
  for (const label of host.split(".")) {
    if (label.startsWith("xn--")) {
      const u = decodePunycode(label.slice(4));
      if (u === null || u === "") return null;
      decoded.push(u);
    } else decoded.push(label);
  }
  return decoded.join(".");
}

function rawAuthority(input: string): string {
  const afterScheme = input.includes("://") ? input.slice(input.indexOf("://") + 3) : input;
  return afterScheme.split(/[/?#]/, 1)[0] ?? "";
}

export function canonicalizeVendorUrl(raw: string): VendorIntakeResult<CanonicalVendorUrl> {
  const input = raw.trim();
  if (input === "") return fail("empty");
  if (input.length > VENDOR_INTAKE_LIMITS.urlMaxLength) return fail("too_long");
  if (URL_FORBIDDEN_CHARS.test(input)) return fail("url_invalid");

  let candidate = input;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    if (!/^https?:\/\//i.test(input)) return fail("url_scheme_unsupported");
  } else if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(input) || input.includes("\\")) {
    // javascript:, data:, mailto:, ... and backslash tricks; "host:8080" falls through to port handling.
    return fail("url_scheme_unsupported");
  } else {
    candidate = `https://${input}`;
  }

  // Homograph check runs on the author-supplied host, before the URL parser punycodes it.
  const authority = rawAuthority(candidate);
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "");
  if (hasMixedScriptLabel(hostPart.normalize("NFKC").toLowerCase())) return fail("host_mixed_script");

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return fail("url_invalid");
  }
  if (parsed.username !== "" || parsed.password !== "" || authority.includes("@")) return fail("url_has_userinfo");
  if (parsed.port !== "") return fail("url_port_unsupported");

  const hostname = parsed.hostname.replace(/\.$/, "").toLowerCase();
  if (hostname.startsWith("[") || IPV4.test(hostname)) return fail("host_is_ip_literal");
  if (hostname.length > VENDOR_INTAKE_LIMITS.hostMaxLength) return fail("too_long");
  if (!ASCII_HOST.test(hostname)) return fail("host_invalid");
  // Punycode (xn--) hosts must get the same homograph check as Unicode-form hosts.
  const unicodeHost = decodeHostLabels(hostname);
  if (unicodeHost === null) return fail("host_invalid");
  if (hasMixedScriptLabel(unicodeHost.normalize("NFKC").toLowerCase())) return fail("host_mixed_script");
  const labels = hostname.split(".");
  if (labels.some((l) => l.length > VENDOR_INTAKE_LIMITS.labelMaxLength || l.startsWith("-") || l.endsWith("-"))) {
    return fail("host_invalid");
  }
  if (labels.length < 2) return fail("host_not_public");
  if (NON_PUBLIC_SUFFIXES.some((s) => hostname === s || hostname.endsWith(`.${s}`))) return fail("host_not_public");
  if (/^\d+$/.test(labels[labels.length - 1])) return fail("host_invalid");

  const host = labels[0] === "www" && labels.length > 2 ? labels.slice(1).join(".") : hostname;
  const kept = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
  const path = parsed.pathname.replace(/\/+$/, "");
  return { ok: true, value: { url: `https://${host}${path}${query}`, host, dedupeKey: vendorDedupeKey(host) } };
}

/** Stable dedupe key for a canonical host (lowercase, no leading www). */
export function vendorDedupeKey(canonicalHost: string): string {
  return `vendor-host:v1:${canonicalHost}`;
}

// Control (Cc) and invisible format characters (zero-width, bidi overrides, BOM).
const CONTROL_AND_FORMAT = /[\p{Cc}\p{Cf}]/gu;
// Same set, except the newline that notes keep.
const NOTES_STRIP = /(?!\n)[\p{Cc}\p{Cf}]/gu;

export function normalizeVendorName(raw: string): VendorIntakeResult<string> {
  const name = raw.normalize("NFKC").replace(/\s+/g, " ").replace(CONTROL_AND_FORMAT, "").replace(/\s+/g, " ").trim();
  if (name === "") return fail("empty");
  if ([...name].length > VENDOR_INTAKE_LIMITS.nameMaxLength) return fail("too_long");
  return { ok: true, value: name };
}

/** Notes are optional; newlines are kept, other control characters are removed. */
export function validateVendorNotes(raw: string | null | undefined): VendorIntakeResult<string> {
  const notes = (raw ?? "").normalize("NFKC").replace(/\r\n?/g, "\n").replace(NOTES_STRIP, "").trim();
  if ([...notes].length > VENDOR_INTAKE_LIMITS.notesMaxLength) return fail("too_long");
  return { ok: true, value: notes };
}

export function normalizeVendorIntake(input: VendorIntakeInput): VendorIntakeFieldResult {
  const name = normalizeVendorName(input.name);
  if (name.ok === false) return { ok: false, field: "name", reason: name.reason };
  const url = canonicalizeVendorUrl(input.url);
  if (url.ok === false) return { ok: false, field: "url", reason: url.reason };
  const notes = validateVendorNotes(input.notes);
  if (notes.ok === false) return { ok: false, field: "notes", reason: notes.reason };
  return { ok: true, value: { ...url.value, name: name.value, notes: notes.value } };
}
