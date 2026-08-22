import {
  XOMETRY_LOCATORS,
  XOMETRY_URLS,
} from "./adapters/xometryConstraints.js";
import {
  runFailClosedBrowserCleanup,
  type FailClosedBrowserCleanupOptions,
} from "./browserCleanup.js";
import type { WorkerConfig } from "./types.js";
import type { BrowserContext, Page } from "playwright";

export const XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS = {
  offline: true,
  serviceWorkers: "block" as const,
  firefox_user_prefs: {
    "dom.serviceWorkers.enabled": false,
    "media.peerconnection.enabled": false,
    "network.webtransport.enabled": false,
  },
};

export const XOMETRY_AUTH_PROBE_PLAYWRIGHT_CONTEXT_GUARDS = {
  offline: true,
  serviceWorkers: "block" as const,
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

export type XometryAuthProbeBaseEvidence = XometryAuthProbeResult & {
  url: string;
  blockedNonReadMethods: string[];
  dashboardUploadButtonVisible: boolean;
  fileSelectionPerformed: false;
  userInputInteractionPerformed: false;
};

export type XometryAuthProbeEvidence = XometryAuthProbeBaseEvidence & {
  snapshotGeneration: string;
  browserEngine: "playwright" | "camoufox";
  snapshotPersisted: false;
};

export type XometryAuthProbeFailureEvidence = {
  authenticated: false;
  reason: "probe_failed";
  fileSelectionPerformed: false;
  userInputInteractionPerformed: false;
  snapshotPersisted: false;
};

function signalPresent(text: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function sanitizedUrl(value: string) {
  if (
    ["invalid_url", "external_redirect", "xometry_redirect"].includes(value)
  ) {
    return value;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "invalid_url";
  }

  const knownLocations = [XOMETRY_URLS.quoteHome, XOMETRY_URLS.login].map(
    (location) => {
      const known = new URL(location);
      return `${known.origin}${known.pathname}`;
    },
  );
  const location = `${parsed.origin}${parsed.pathname}`;
  if (knownLocations.includes(location)) return location;

  const xometryOwnedOrigin =
    parsed.protocol === "https:" &&
    (parsed.hostname === "xometry.com" ||
      parsed.hostname.endsWith(".xometry.com"));
  return xometryOwnedOrigin ? "xometry_redirect" : "external_redirect";
}

function sanitizedBlockedMethod(method: string) {
  const normalized = method.toUpperCase();
  return ["POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE"].includes(
    normalized,
  )
    ? normalized
    : "OTHER";
}

/** Return one stable failure shape without serializing low-level paths or diagnostics. */
export function buildXometryAuthProbeFailureEvidence(): XometryAuthProbeFailureEvidence {
  return {
    authenticated: false,
    reason: "probe_failed",
    fileSelectionPerformed: false,
    userInputInteractionPerformed: false,
    snapshotPersisted: false,
  };
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
  const accountQuoteListVisible =
    XOMETRY_LOCATORS.accountQuoteListSignals.every((pattern) =>
      pattern.test(input.bodyText),
    );
  if (quoteHome && (dashboardTextVisible || accountQuoteListVisible)) {
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
    throw new Error(
      `Xometry authentication was not confirmed: ${result.reason}.`,
    );
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
    blockedNonReadMethods: [
      ...new Set([...input.blockedNonReadMethods].map(sanitizedBlockedMethod)),
    ].sort((left, right) => left.localeCompare(right)),
    dashboardUploadButtonVisible: input.dashboardUploadButtonVisible,
    fileSelectionPerformed: false,
    userInputInteractionPerformed: false,
    snapshotPersisted: false,
  };
}

/**
 * Navigate and classify a restored profile with the production probe's
 * read-only request and WebSocket guards. Page text is discarded after
 * classification and is never included in the returned evidence. The probe
 * polls at most 20 times at 500 ms intervals, stopping early for authenticated,
 * CAPTCHA, provider-error, or login terminal states.
 */
export async function runBoundedXometryAuthProbe(
  context: BrowserContext,
): Promise<XometryAuthProbeBaseEvidence> {
  const blockedMethods = new Set<string>();
  try {
    await Promise.all(context.pages().map((page) => page.close()));
    await context.addInitScript(`
      const DisabledProbeNetworkConstructor = class DisabledProbeNetworkConstructor {
        constructor() {
          throw new Error("Disabled during bounded authentication probe.");
        }
      };
      Object.defineProperty(
        DisabledProbeNetworkConstructor,
        "__overdrafterProbeDisabled",
        { configurable: false, value: true },
      );
      for (const constructorName of [
        "Worker",
        "SharedWorker",
        "WebSocket",
        "RTCPeerConnection",
        "webkitRTCPeerConnection",
        "WebTransport",
      ]) {
        Object.defineProperty(globalThis, constructorName, {
          configurable: false,
          writable: false,
          value: DisabledProbeNetworkConstructor,
        });
      }
    `);
    await context.route("**/*", async (route) => {
      const method = route.request().method().toUpperCase();
      if (
        isReadOnlyProbeRequest({
          method,
          url: route.request().url(),
          postData: route.request().postData(),
        })
      ) {
        await route.continue();
        return;
      }
      blockedMethods.add(sanitizedBlockedMethod(method));
      await route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (webSocketRoute) => {
      webSocketRoute.close();
    });
  } catch {
    throw new Error("Xometry authentication probe guard setup failed.");
  }

  let page: Page;
  try {
    page = await context.newPage();
    const guardsInstalled = await page.evaluate(() => {
      const guardedGlobal = globalThis as typeof globalThis &
        Record<string, unknown>;
      return [
        "Worker",
        "SharedWorker",
        "WebSocket",
        "RTCPeerConnection",
        "webkitRTCPeerConnection",
        "WebTransport",
      ].every((constructorName) => {
        const value = guardedGlobal[constructorName];
        return (
          typeof value === "function" &&
          (
            value as unknown as {
              __overdrafterProbeDisabled?: boolean;
            }
          ).__overdrafterProbeDisabled === true
        );
      });
    });
    if (!guardsInstalled) {
      throw new Error("page transport guard verification failed");
    }
  } catch {
    throw new Error("Xometry authentication probe guard verification failed.");
  }

  try {
    await context.setOffline(false);
  } catch {
    throw new Error("Xometry authentication probe network activation failed.");
  }

  try {
    await page.goto(XOMETRY_URLS.quoteHome, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    let lastResult: XometryAuthProbeResult = {
      authenticated: false,
      reason: "authenticated_dashboard_not_confirmed",
    };
    let dashboardUploadButtonVisible = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const bodyText = await page.locator("body").innerText();
      dashboardUploadButtonVisible = await Promise.any(
        XOMETRY_LOCATORS.dashboardUploadButtons.map(async (selector) => {
          if (await page.locator(selector).first().isVisible()) return true;
          throw new Error("not visible");
        }),
      ).catch(() => false);
      lastResult = classifyXometryAuthProbe({
        url: page.url(),
        bodyText,
        dashboardUploadButtonVisible,
      });
      if (
        lastResult.authenticated ||
        lastResult.reason === "captcha" ||
        lastResult.reason === "provider_error" ||
        page.url().includes("/login")
      ) {
        break;
      }
      if (attempt < 19) {
        await page.waitForTimeout(500);
      }
    }

    return {
      ...lastResult,
      url: sanitizedUrl(page.url()),
      blockedNonReadMethods: [...blockedMethods].sort((left, right) =>
        left.localeCompare(right),
      ),
      dashboardUploadButtonVisible,
      fileSelectionPerformed: false,
      userInputInteractionPerformed: false,
    };
  } catch {
    throw new Error(
      "Xometry authentication probe navigation or inspection failed.",
    );
  }
}

/**
 * Re-isolate and close a probe context without allowing cleanup failures to
 * erase the primary authentication or navigation failure.
 */
export async function withClosingXometryAuthProbeContext<T>(
  context: BrowserContext,
  operation: () => Promise<T>,
  cleanupOptions: FailClosedBrowserCleanupOptions & {
    operationTimeoutMs?: number;
  } = {},
): Promise<T> {
  let primaryError: unknown;
  let result: T | undefined;
  try {
    result = await runFailClosedBrowserCleanup(
      operation,
      "Xometry authentication probe operation timed out; terminating task.",
      {
        cleanupTimeoutMs: cleanupOptions.operationTimeoutMs ?? 120_000,
        terminateProcess: cleanupOptions.terminateProcess,
      },
    );
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: Error[] = [];
  try {
    await runFailClosedBrowserCleanup(
      () => context.setOffline(true),
      "Xometry authentication probe network re-isolation timed out; terminating task.",
      cleanupOptions,
    );
  } catch {
    cleanupErrors.push(
      new Error("Xometry authentication probe network re-isolation failed."),
    );
  }
  try {
    await runFailClosedBrowserCleanup(
      () => context.close(),
      "Xometry authentication probe context cleanup timed out; terminating task.",
      cleanupOptions,
    );
  } catch {
    cleanupErrors.push(
      new Error("Xometry authentication probe context cleanup failed."),
    );
  }

  if (cleanupErrors.length > 0) {
    if (primaryError !== undefined) {
      const message =
        primaryError instanceof Error
          ? primaryError.message
          : "Xometry authentication probe failed.";
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        `${message} Probe cleanup also failed closed.`,
        { cause: primaryError },
      );
    }

    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    throw new AggregateError(
      cleanupErrors,
      "Xometry authentication probe context cleanup failed.",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  return result as T;
}

/** Add snapshot ownership metadata to already-sanitized bounded probe evidence. */
export function buildXometryAuthProbeEvidenceFromBounded(input: {
  evidence: XometryAuthProbeBaseEvidence;
  snapshotGeneration: string;
  browserEngine: "playwright" | "camoufox";
}): XometryAuthProbeEvidence {
  return {
    ...input.evidence,
    url: sanitizedUrl(input.evidence.url),
    blockedNonReadMethods: [
      ...new Set(
        input.evidence.blockedNonReadMethods.map(sanitizedBlockedMethod),
      ),
    ].sort((left, right) => left.localeCompare(right)),
    snapshotGeneration: input.snapshotGeneration,
    browserEngine: input.browserEngine,
    snapshotPersisted: false,
  };
}

/** Fail closed unless a newly launched, read-only context confirms the dashboard. */
export async function requireAuthenticatedXometryColdRelaunch(input: {
  launchContext: () => Promise<BrowserContext>;
  operationTimeoutMs?: number;
}): Promise<XometryAuthProbeBaseEvidence & { authenticated: true }> {
  const context = await input.launchContext();
  return withClosingXometryAuthProbeContext(
    context,
    async () => {
      const evidence = await runBoundedXometryAuthProbe(context);
      if (!evidence.authenticated) {
        throw new Error(
          `Xometry cold-relaunch authentication was not confirmed: ${evidence.reason}.`,
        );
      }
      return evidence;
    },
    { operationTimeoutMs: input.operationTimeoutMs },
  );
}

/**
 * Permit only the bounded request shapes needed to render the dashboard.
 *
 * This is a client-side transport policy. It does not claim that arbitrary
 * provider implementations of an allowed GET or GraphQL query are internally
 * side-effect free.
 */
export function isReadOnlyProbeRequest(input: {
  method: string;
  url: string;
  postData: string | null;
}) {
  const method = input.method.toUpperCase();
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return false;
  }
  const xometryOwnedOrigin =
    url.protocol === "https:" &&
    (url.hostname === "xometry.com" || url.hostname.endsWith(".xometry.com"));
  if (!xometryOwnedOrigin) return false;
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  if (method !== "POST") return false;

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
