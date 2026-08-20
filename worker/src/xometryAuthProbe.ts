import { XOMETRY_LOCATORS, XOMETRY_URLS } from "./adapters/xometryConstraints.js";

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

function signalPresent(text: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
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
  if (quoteHome && (dashboardTextVisible || input.dashboardUploadButtonVisible)) {
    return { authenticated: true, reason: "authenticated_dashboard" };
  }

  return {
    authenticated: false,
    reason: "authenticated_dashboard_not_confirmed",
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
        return /^(?:query\b|\{)/i.test(query.trim());
      })
    );
  } catch {
    return false;
  }
}
