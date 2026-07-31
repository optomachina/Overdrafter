import { MOBILE_AUTH_LIMITS } from "./contract.js";
import {
  createRandomBase64Url,
  decodeCanonicalBase64Url,
} from "./crypto.js";

export type MobileAuthDocumentKind =
  | "ceremony"
  | "provider-callback"
  | "bootstrap"
  | "recovery";

export interface MobileAuthDocumentHeadersOptions {
  readonly kind: MobileAuthDocumentKind;
  readonly nonce?: string;
  readonly supabaseOrigin?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class MobileAuthHeaderError extends Error {
  constructor() {
    super("The mobile authentication response security policy is invalid.");
    this.name = "MobileAuthHeaderError";
  }
}

export function createMobileAuthCspNonce(): string {
  return createRandomBase64Url(MOBILE_AUTH_LIMITS.nonceBytes);
}

function validateNonce(value: string | undefined): string {
  if (!value) {
    throw new MobileAuthHeaderError();
  }

  try {
    decodeCanonicalBase64Url(value, MOBILE_AUTH_LIMITS.nonceBytes);
  } catch {
    throw new MobileAuthHeaderError();
  }

  return value;
}

function validateCspOrigin(value: string | undefined): string {
  if (!value) {
    throw new MobileAuthHeaderError();
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new MobileAuthHeaderError();
  }

  const permitsLocalTestOrigin =
    parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);

  if (
    parsed.origin !== value ||
    (parsed.protocol !== "https:" && !permitsLocalTestOrigin) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new MobileAuthHeaderError();
  }

  return parsed.origin;
}

function createContentSecurityPolicy(options: MobileAuthDocumentHeadersOptions): string {
  const directives = [
    "default-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
  ];

  if (options.kind === "recovery") {
    directives.push(
      "script-src 'none'",
      "style-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
    );
    return `${directives.join("; ")};`;
  }

  const nonce = validateNonce(options.nonce);
  const supabaseOrigin = validateCspOrigin(options.supabaseOrigin);
  if (options.kind === "bootstrap") {
    directives.push("style-src 'none'");
  } else {
    directives.push(`style-src 'nonce-${nonce}'`);
  }
  directives.push(
    `script-src 'self' 'nonce-${nonce}'`,
    `connect-src 'self' ${supabaseOrigin}`,
    options.kind === "bootstrap" ? "form-action 'none'" : "form-action 'self'",
  );

  return `${directives.join("; ")};`;
}

export function createMobileAuthDocumentHeaders(
  options: MobileAuthDocumentHeadersOptions,
): Readonly<Record<string, string>> {
  return Object.freeze({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": createContentSecurityPolicy(options),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
  });
}
