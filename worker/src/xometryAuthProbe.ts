import { XOMETRY_LOCATORS, XOMETRY_URLS } from "./adapters/xometryConstraints.js";
import type { WorkerConfig } from "./types.js";

export const XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS = {
  serviceWorkers: "block" as const,
  firefox_user_prefs: {
    "dom.serviceWorkers.enabled": false,
  },
};

/** Only engines with an implemented persistent-context probe may run. */
export function isSupportedXometryAuthProbeEngine(
  engine: WorkerConfig["xometryBrowserEngine"],
): engine is "playwright" | "camoufox" {
  return engine === "playwright" || engine === "camoufox";
}

export type XometryAuthProbeResult =
  | { authenticated: true; reason: "authenticated_dashboard" }
  | {
      authenticated: false;
      reason:
        | "captcha"
        | "login_required"
        | "anonymous_quote_home"
        | "provider_error"
        | "authenticated_dashboard_not_confirmed";
    };

export type XometryAuthProbeEvidence = XometryAuthProbeResult & {
  url: string;
  snapshotGeneration: string;
  browserEngine: "playwright" | "camoufox";
  blockedNonReadMethods: string[];
  dashboardUploadButtonVisible: boolean;
  fileSelectionPerformed: false;
  interactionPerformed: false;
  snapshotPersisted: false;
};

function signalPresent(text: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function sanitizedUrl(value: string) {
  const parsed = new URL(value);
  return `${parsed.origin}${parsed.pathname}`;
}

/** Classify sanitized, read-only dashboard evidence without returning page text. */
export function classifyXometryAuthProbe(input: {
  url: string;
  bodyText: string;
  dashboardUploadButtonVisible: boolean;
}): XometryAuthProbeResult {
  if (signalPresent(input.bodyText, XOMETRY_LOCATORS.captchaSignals)) {
    return { authenticated: false, reason: "captcha" };
  }

  if (
    input.url.includes("/login") ||
    signalPresent(input.bodyText, XOMETRY_LOCATORS.loginSignals)
  ) {
    return { authenticated: false, reason: "login_required" };
  }

  const quoteHome = input.url.startsWith(XOMETRY_URLS.quoteHome);
  if (
    quoteHome &&
    (XOMETRY_LOCATORS.anonymousQuoteHomeSignals.every((pattern) =>
      pattern.test(input.bodyText),
    ) ||
      XOMETRY_LOCATORS.anonymousEmailGateSignals.every((pattern) =>
        pattern.test(input.bodyText),
      ))
  ) {
    return { authenticated: false, reason: "anonymous_quote_home" };
  }

  if (signalPresent(input.bodyText, XOMETRY_LOCATORS.genericErrorSignals)) {
    return { authenticated: false, reason: "provider_error" };
  }

  const dashboardTextVisible = signalPresent(
    input.bodyText,
    XOMETRY_LOCATORS.dashboardSignals,
  );
  const accountQuoteListVisible = XOMETRY_LOCATORS.accountQuoteListSignals.every(
    (pattern) => pattern.test(input.bodyText),
  );
  if (
    quoteHome &&
    (dashboardTextVisible || accountQuoteListVisible || input.dashboardUploadButtonVisible)
  ) {
    return { authenticated: true, reason: "authenticated_dashboard" };
  }

  return {
    authenticated: false,
    reason: "authenticated_dashboard_not_confirmed",
  };
}

/** Refuse profile bootstrap unless the same read-only probe signals prove authentication. */
export function requireAuthenticatedXometryDashboard(input: {
  url: string;
  bodyText: string;
  dashboardUploadButtonVisible: boolean;
}) {
  const result = classifyXometryAuthProbe(input);
  if (!result.authenticated) {
    throw new Error(`Xometry authentication was not confirmed: ${result.reason}.`);
  }
  return result;
}

/** Build bounded probe evidence without retaining page text, query data, or identifiers. */
export function buildXometryAuthProbeEvidence(input: {
  url: string;
  bodyText: string;
  dashboardUploadButtonVisible: boolean;
  snapshotGeneration: string;
  browserEngine: "playwright" | "camoufox";
  blockedNonReadMethods: Iterable<string>;
}): XometryAuthProbeEvidence {
  return {
    ...classifyXometryAuthProbe(input),
    url: sanitizedUrl(input.url),
    snapshotGeneration: input.snapshotGeneration,
    browserEngine: input.browserEngine,
    blockedNonReadMethods: [...new Set(input.blockedNonReadMethods)].sort((left, right) =>
      left.localeCompare(right),
    ),
    dashboardUploadButtonVisible: input.dashboardUploadButtonVisible,
    fileSelectionPerformed: false,
    interactionPerformed: false,
    snapshotPersisted: false,
  };
}

/** Only idempotent navigation/resource requests are permitted during the probe. */
export function isReadOnlyProbeRequest(input: {
  method: string;
  url: string;
  postData: string | null;
}) {
  const method = input.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  if (method !== "POST") return false;

  const url = new URL(input.url);
  const isXometryQueryEndpoint =
    url.origin === "https://www.xometry.com" &&
    ["/graphql/federation/buyer", "/api/graphql/"].includes(url.pathname);
  if (!isXometryQueryEndpoint || !input.postData) return false;

  try {
    const payload: unknown = JSON.parse(input.postData);
    const operations = Array.isArray(payload) ? payload : [payload];
    return (
      operations.length > 0 &&
      operations.every((operation) => {
        if (!operation || typeof operation !== "object") return false;
        const query = Reflect.get(operation, "query");
        if (typeof query !== "string") return false;
        return containsOnlyQueryOperations(query);
      })
    );
  } catch {
    return false;
  }
}

function containsOnlyQueryOperations(document: string) {
  const withoutLiterals = document
    .replace(/"""[\s\S]*?"""/g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, "")
    .replace(/#[^\r\n]*/g, "");
  const operationTypes = [
    ...withoutLiterals.matchAll(/\b(query|mutation|subscription)\b/gi),
  ].map((match) => match[1]?.toLowerCase());

  if (operationTypes.length > 0) {
    return operationTypes.every((operationType) => operationType === "query");
  }
  return withoutLiterals.trimStart().startsWith("{");
}
