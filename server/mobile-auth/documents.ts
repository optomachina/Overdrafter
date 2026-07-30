import {
  MOBILE_AUTH_ASSET_PATHS,
  MOBILE_AUTH_CONTRACT_VERSION,
  MOBILE_AUTH_ERROR_CODES,
  MOBILE_AUTH_LIMITS,
  MOBILE_AUTH_MESSAGE_VERSION,
  MOBILE_AUTH_PATHS,
  MOBILE_AUTH_RETRY_INSTRUCTIONS,
  type MobileAuthErrorCode,
  type MobileAuthFailureMessage,
  type MobileAuthProviderError,
  type MobileAuthRetryInstruction,
} from "./contract";
import { decodeCanonicalBase64Url } from "./crypto";
import {
  createMobileAuthCspNonce,
  createMobileAuthDocumentHeaders,
} from "./headers";
import { parseMobileReturnRoute } from "./return-routes";
import { isMobileAuthProviderError } from "../../shared/mobile-auth-provider-errors";

const MOBILE_AUTH_CONFIG_ELEMENT_ID = "overdrafter-mobile-auth-config";
const MOBILE_AUTH_BOOTSTRAP_CONFIG_ELEMENT_ID =
  "overdrafter-mobile-auth-bootstrap-config";
const STORAGE_NAMESPACE_PATTERN = /^[A-Za-z0-9.:-]{1,160}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERROR_CODE_SET = new Set<MobileAuthErrorCode>(MOBILE_AUTH_ERROR_CODES);
const RETRY_INSTRUCTION_SET = new Set<MobileAuthRetryInstruction>(
  MOBILE_AUTH_RETRY_INSTRUCTIONS,
);

export interface MobileAuthHtmlDocument {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface MobileAuthCeremonyConfig {
  readonly storageNamespace: string;
  readonly csrf: string;
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
  readonly providerCallbackUrl: string;
  readonly completeUrl: string;
}

export type MobileAuthProviderCallbackMode =
  | {
      readonly mode: "code";
      readonly code: string;
    }
  | {
      readonly mode: "error";
      readonly error: MobileAuthProviderError;
    };

export interface MobileAuthBootstrapSuccessConfig {
  readonly state: string;
  readonly returnTo: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly supabaseUrl: string;
}

export interface MobileAuthBootstrapFailureConfig {
  readonly state: string;
  readonly code: MobileAuthErrorCode;
  readonly retry: MobileAuthRetryInstruction;
  readonly supabaseUrl: string;
}

export class MobileAuthDocumentError extends Error {
  constructor() {
    super("The mobile authentication document data is invalid.");
    this.name = "MobileAuthDocumentError";
  }
}

function assertCanonicalSecret(value: string, byteLength: number): void {
  try {
    decodeCanonicalBase64Url(value, byteLength);
  } catch {
    throw new MobileAuthDocumentError();
  }
}

function assertPrintableAscii(value: string, maximumBytes: number): void {
  if (
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    !PRINTABLE_ASCII_PATTERN.test(value)
  ) {
    throw new MobileAuthDocumentError();
  }
}

function parseExactUrl(
  value: string,
  expectedPath?: string,
  allowTransactionBinding = false,
): URL {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new MobileAuthDocumentError();
  }

  const isLoopbackHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]");

  if (
    (parsed.protocol !== "https:" && !isLoopbackHttp) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (!allowTransactionBinding && parsed.search !== "") ||
    parsed.hash !== "" ||
    (expectedPath !== undefined && parsed.pathname !== expectedPath)
  ) {
    throw new MobileAuthDocumentError();
  }

  if (allowTransactionBinding) {
    const callbackBinding = parsed.searchParams.get("cb");
    if (
      callbackBinding === null ||
      !TRANSACTION_ID_PATTERN.test(callbackBinding) ||
      parsed.search !== `?cb=${callbackBinding}`
    ) {
      throw new MobileAuthDocumentError();
    }
  }

  return parsed;
}

function validateCeremonyConfig(config: MobileAuthCeremonyConfig): void {
  if (!STORAGE_NAMESPACE_PATTERN.test(config.storageNamespace)) {
    throw new MobileAuthDocumentError();
  }

  assertCanonicalSecret(config.csrf, MOBILE_AUTH_LIMITS.csrfBytes);
  const supabaseUrl = parseExactUrl(config.supabaseUrl);
  const providerCallbackUrl = parseExactUrl(
    config.providerCallbackUrl,
    MOBILE_AUTH_PATHS.providerCallback,
    true,
  );
  const completeUrl = parseExactUrl(config.completeUrl, MOBILE_AUTH_PATHS.complete);

  if (
    supabaseUrl.pathname !== "/" ||
    providerCallbackUrl.origin !== completeUrl.origin
  ) {
    throw new MobileAuthDocumentError();
  }

  assertPrintableAscii(config.supabasePublishableKey, 8_192);
}

export function escapeMobileAuthInertJson(value: unknown): string {
  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    throw new MobileAuthDocumentError();
  }

  return serialized
    .replaceAll("&", String.raw`\u0026`)
    .replaceAll("<", String.raw`\u003c`)
    .replaceAll(">", String.raw`\u003e`)
    .replaceAll("\u2028", String.raw`\u2028`)
    .replaceAll("\u2029", String.raw`\u2029`);
}

function createScriptedDocument(
  kind: "ceremony" | "provider-callback" | "bootstrap",
  supabaseOrigin: string,
  body: (nonce: string) => string,
): MobileAuthHtmlDocument {
  const nonce = createMobileAuthCspNonce();

  return Object.freeze({
    body: body(nonce),
    headers: createMobileAuthDocumentHeaders({
      kind,
      nonce,
      supabaseOrigin,
    }),
  });
}

function createHtmlShell(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${title}</title>`,
    "</head>",
    `<body>${body}</body>`,
    "</html>",
  ].join("");
}

function mobileAuthCeremonyStyles(): string {
  return [
    ':root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif;background:#f4f6f8;color:#111827}',
    "*{box-sizing:border-box}",
    "body{margin:0;min-height:100svh;background:radial-gradient(circle at 50% -10%,#fff 0,#f4f6f8 48%,#e8edf2 100%)}",
    ".mobile-auth-shell{min-height:100svh;display:grid;place-items:center;padding:28px 20px}",
    ".mobile-auth-card{width:min(100%,430px);padding:30px;border:1px solid rgba(15,23,42,.09);border-radius:28px;background:rgba(255,255,255,.88);box-shadow:0 24px 80px rgba(15,23,42,.13);backdrop-filter:blur(18px)}",
    ".mobile-auth-brand{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:700;letter-spacing:-.01em}",
    ".mobile-auth-brand span{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:#111827;color:#fff;font-size:11px;letter-spacing:.04em}",
    ".mobile-auth-eyebrow{margin:30px 0 8px;color:#64748b;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}",
    "h1{margin:0;color:#0f172a;font-size:34px;line-height:1.08;letter-spacing:-.04em}",
    ".mobile-auth-intro{margin:12px 0 24px;color:#64748b;font-size:15px;line-height:1.55}",
    ".mobile-auth-status{min-height:20px;margin:0 0 8px;color:#b45309;font-size:13px}",
    "form{display:grid;gap:13px}",
    "label{display:grid;gap:7px;color:#334155;font-size:13px;font-weight:650}",
    "input{width:100%;height:48px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;color:#0f172a;padding:0 14px;font:inherit;font-size:16px;outline:none;transition:border-color .16s,box-shadow .16s}",
    "input:focus{border-color:#475569;box-shadow:0 0 0 4px rgba(71,85,105,.12)}",
    "button{min-height:46px;border:0;border-radius:14px;padding:0 16px;font:inherit;font-size:15px;font-weight:700;cursor:pointer;transition:transform .12s,opacity .12s,background .12s}",
    "button:active{transform:scale(.985)}",
    ".mobile-auth-primary{margin-top:5px;background:#111827;color:#fff}",
    ".mobile-auth-secondary{border:1px solid #d7dee7;background:#f8fafc;color:#334155}",
    "button:disabled,input:disabled{cursor:not-allowed;opacity:.62}",
    ".mobile-auth-recovery{margin:13px 0 0;text-align:center;font-size:13px}",
    ".mobile-auth-recovery a{color:#475569;text-underline-offset:3px}",
    ".mobile-auth-divider{display:flex;align-items:center;gap:12px;margin:22px 0;color:#94a3b8;font-size:12px}",
    '.mobile-auth-divider:before,.mobile-auth-divider:after{content:"";height:1px;flex:1;background:#e2e8f0}',
    ".mobile-auth-providers{display:grid;gap:9px}",
    ".mobile-auth-providers button{border:1px solid #d7dee7;background:#fff;color:#1e293b}",
    ".mobile-auth-providers button:hover,.mobile-auth-secondary:hover{background:#f1f5f9}",
    ".mobile-auth-footnote{margin:22px 8px 0;color:#94a3b8;font-size:11px;line-height:1.5;text-align:center}",
    "@media(prefers-color-scheme:dark){:root{background:#06080b;color:#e5e7eb}body{background:radial-gradient(circle at 50% -10%,#20252d 0,#0b0e12 48%,#050608 100%)}.mobile-auth-card{border-color:rgba(255,255,255,.09);background:rgba(14,17,22,.9);box-shadow:0 28px 90px rgba(0,0,0,.55)}.mobile-auth-brand span{background:#f8fafc;color:#0f172a}h1{color:#f8fafc}.mobile-auth-eyebrow,.mobile-auth-intro{color:#94a3b8}label{color:#cbd5e1}input{border-color:#343b46;background:#15191f;color:#f8fafc}.mobile-auth-primary{background:#f8fafc;color:#111827}.mobile-auth-secondary,.mobile-auth-providers button{border-color:#343b46;background:#171b21;color:#e5e7eb}.mobile-auth-providers button:hover,.mobile-auth-secondary:hover{background:#20252d}.mobile-auth-recovery a{color:#cbd5e1}.mobile-auth-divider:before,.mobile-auth-divider:after{background:#2b313b}}",
  ].join("");
}

function ceremonyMarkup(configJson: string, nonce: string): string {
  return [
    `<style nonce="${nonce}">${mobileAuthCeremonyStyles()}</style>`,
    '<main class="mobile-auth-shell">',
    '<section class="mobile-auth-card" aria-labelledby="mobile-auth-title">',
    '<div class="mobile-auth-brand"><span aria-hidden="true">OD</span>OverDrafter</div>',
    '<p class="mobile-auth-eyebrow">Secure mobile sign in</p>',
    '<h1 id="mobile-auth-title">Welcome back</h1>',
    '<p class="mobile-auth-intro">Sign in here, then continue automatically in the OverDrafter app.</p>',
    '<p class="mobile-auth-status" data-mobile-auth-status aria-live="polite"></p>',
    `<form method="post" action="${MOBILE_AUTH_PATHS.complete}" data-mobile-auth-password-form data-mobile-auth-action="sign-in">`,
    '<label><span>Email</span><input name="email" type="email" autocomplete="email" inputmode="email" data-mobile-auth-interactive required disabled></label>',
    '<label><span>Password</span><input name="password" type="password" autocomplete="current-password" data-mobile-auth-interactive required disabled></label>',
    '<button class="mobile-auth-primary" type="submit" data-mobile-auth-action="sign-in" data-mobile-auth-interactive disabled>Sign in</button>',
    '<button class="mobile-auth-secondary" type="submit" data-mobile-auth-action="sign-up" data-mobile-auth-interactive disabled>Create account</button>',
    "</form>",
    '<p class="mobile-auth-recovery"><a href="/?auth=forgot-password">Forgot password?</a></p>',
    '<div class="mobile-auth-divider"><span>or continue with</span></div>',
    '<div class="mobile-auth-providers" aria-label="Continue with a provider">',
    '<button type="button" data-mobile-auth-provider="google" data-mobile-auth-interactive disabled>Continue with Google</button>',
    '<button type="button" data-mobile-auth-provider="azure" data-mobile-auth-interactive disabled>Continue with Microsoft</button>',
    '<button type="button" data-mobile-auth-provider="apple" data-mobile-auth-interactive disabled>Continue with Apple</button>',
    "</div>",
    "<noscript><p class=\"mobile-auth-status\">Secure sign in could not start. Return to the app and try again.</p></noscript>",
    '<p class="mobile-auth-footnote">Your credentials stay with OverDrafter and the selected identity provider.</p>',
    "</section>",
    "</main>",
    `<script id="${MOBILE_AUTH_CONFIG_ELEMENT_ID}" type="application/json" nonce="${nonce}">${configJson}</script>`,
    `<script type="module" nonce="${nonce}" src="${MOBILE_AUTH_ASSET_PATHS.ceremony}"></script>`,
  ].join("");
}

export function renderMobileAuthCeremonyDocument(
  config: MobileAuthCeremonyConfig,
): MobileAuthHtmlDocument {
  validateCeremonyConfig(config);
  const publicConfig = {
    version: MOBILE_AUTH_MESSAGE_VERSION,
    storageNamespace: config.storageNamespace,
    csrf: config.csrf,
    supabaseUrl: config.supabaseUrl,
    supabasePublishableKey: config.supabasePublishableKey,
    providerCallbackUrl: config.providerCallbackUrl,
    completeUrl: config.completeUrl,
  };
  const configJson = escapeMobileAuthInertJson(publicConfig);
  const supabaseOrigin = new URL(config.supabaseUrl).origin;

  return createScriptedDocument("ceremony", supabaseOrigin, (nonce) =>
    createHtmlShell("Sign in to OverDrafter", ceremonyMarkup(configJson, nonce)),
  );
}

export function renderMobileAuthProviderCallbackDocument(
  config: MobileAuthCeremonyConfig,
  callback: MobileAuthProviderCallbackMode,
): MobileAuthHtmlDocument {
  validateCeremonyConfig(config);

  if (callback.mode === "code") {
    assertPrintableAscii(
      callback.code,
      MOBILE_AUTH_LIMITS.providerAuthorizationCodeBytes,
    );
  } else if (!isMobileAuthProviderError(callback.error)) {
    throw new MobileAuthDocumentError();
  }

  const publicConfig = {
    version: MOBILE_AUTH_MESSAGE_VERSION,
    storageNamespace: config.storageNamespace,
    csrf: config.csrf,
    supabaseUrl: config.supabaseUrl,
    supabasePublishableKey: config.supabasePublishableKey,
    providerCallbackUrl: config.providerCallbackUrl,
    completeUrl: config.completeUrl,
    ...callback,
  };
  const configJson = escapeMobileAuthInertJson(publicConfig);
  const supabaseOrigin = new URL(config.supabaseUrl).origin;

  return createScriptedDocument("provider-callback", supabaseOrigin, (nonce) =>
    createHtmlShell(
      "Completing sign in",
      [
        `<style nonce="${nonce}">${mobileAuthCeremonyStyles()}</style>`,
        '<main class="mobile-auth-shell"><section class="mobile-auth-card">',
        '<div class="mobile-auth-brand"><span aria-hidden="true">OD</span>OverDrafter</div>',
        '<p class="mobile-auth-eyebrow">Secure mobile sign in</p>',
        "<h1>Completing sign in</h1>",
        '<p class="mobile-auth-intro" data-mobile-auth-status aria-live="polite">Please wait while OverDrafter returns you to the app.</p>',
        "</section></main>",
        `<script id="${MOBILE_AUTH_CONFIG_ELEMENT_ID}" type="application/json" nonce="${nonce}">${configJson}</script>`,
        `<script nonce="${nonce}">history.replaceState(null,"","${MOBILE_AUTH_PATHS.providerCallback}");</script>`,
        `<script type="module" nonce="${nonce}" src="${MOBILE_AUTH_ASSET_PATHS.providerCallback}"></script>`,
      ].join(""),
    ),
  );
}

export function renderMobileAuthBootstrapSuccessDocument(
  config: MobileAuthBootstrapSuccessConfig,
): MobileAuthHtmlDocument {
  assertCanonicalSecret(config.state, MOBILE_AUTH_LIMITS.stateBytes);
  const returnTo = parseMobileReturnRoute(config.returnTo);
  assertPrintableAscii(config.accessToken, MOBILE_AUTH_LIMITS.accessTokenBytes);
  assertPrintableAscii(config.refreshToken, MOBILE_AUTH_LIMITS.refreshTokenBytes);
  const supabaseUrl = parseExactUrl(config.supabaseUrl);

  if (supabaseUrl.pathname !== "/") {
    throw new MobileAuthDocumentError();
  }

  const supabaseOrigin = supabaseUrl.origin;
  const publicConfig = {
    version: MOBILE_AUTH_MESSAGE_VERSION,
    state: config.state,
    returnTo,
    session: {
      accessToken: config.accessToken,
      refreshToken: config.refreshToken,
    },
  };
  const configJson = escapeMobileAuthInertJson(publicConfig);

  return createScriptedDocument("bootstrap", supabaseOrigin, (nonce) =>
    createHtmlShell(
      "Finishing sign in",
      [
        "<main><h1>Finishing sign in</h1>",
        '<p data-mobile-auth-status aria-live="polite">Please wait…</p></main>',
        `<script id="${MOBILE_AUTH_BOOTSTRAP_CONFIG_ELEMENT_ID}" type="application/json" nonce="${nonce}">${configJson}</script>`,
        `<script type="module" nonce="${nonce}" src="${MOBILE_AUTH_ASSET_PATHS.bootstrap}"></script>`,
      ].join(""),
    ),
  );
}

export function renderMobileAuthBootstrapFailureDocument(
  config: MobileAuthBootstrapFailureConfig,
): MobileAuthHtmlDocument {
  assertCanonicalSecret(config.state, MOBILE_AUTH_LIMITS.stateBytes);

  if (!ERROR_CODE_SET.has(config.code) || !RETRY_INSTRUCTION_SET.has(config.retry)) {
    throw new MobileAuthDocumentError();
  }

  const supabaseUrl = parseExactUrl(config.supabaseUrl);

  if (supabaseUrl.pathname !== "/") {
    throw new MobileAuthDocumentError();
  }

  const supabaseOrigin = supabaseUrl.origin;
  const message: MobileAuthFailureMessage = {
    version: MOBILE_AUTH_MESSAGE_VERSION,
    status: "error",
    state: config.state,
    code: config.code,
    retry: config.retry,
  };
  const publicConfig = {
    version: message.version,
    state: message.state,
    error: {
      code: message.code,
      retry: message.retry,
    },
  };
  const configJson = escapeMobileAuthInertJson(publicConfig);

  return createScriptedDocument("bootstrap", supabaseOrigin, (nonce) =>
    createHtmlShell(
      "Sign in could not be completed",
      [
        "<main><h1>Sign in could not be completed</h1>",
        '<p data-mobile-auth-status aria-live="polite">Return to the app and try again.</p></main>',
        `<script id="${MOBILE_AUTH_BOOTSTRAP_CONFIG_ELEMENT_ID}" type="application/json" nonce="${nonce}">${configJson}</script>`,
        `<script type="module" nonce="${nonce}" src="${MOBILE_AUTH_ASSET_PATHS.bootstrap}"></script>`,
      ].join(""),
    ),
  );
}

export function renderMobileAuthRecoveryDocument(): MobileAuthHtmlDocument {
  return Object.freeze({
    body: createHtmlShell(
      "Return to OverDrafter",
      "<main><h1>Return to OverDrafter</h1><p>Open the OverDrafter app and start sign in again.</p></main>",
    ),
    headers: createMobileAuthDocumentHeaders({ kind: "recovery" }),
  });
}

export function createMobileAuthStorageNamespace(transactionId: string): string {
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new MobileAuthDocumentError();
  }

  return `overdrafter.mobile-auth.v${MOBILE_AUTH_CONTRACT_VERSION}.${transactionId}`;
}
