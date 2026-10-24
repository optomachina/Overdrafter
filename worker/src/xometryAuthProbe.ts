import { XometryProfileSnapshotError, type XometrySnapshotRestorePhase } from "./xometryProfileSnapshot.js";
import { VendorAutomationError } from "./types.js";
import {
  XOMETRY_LOCATORS,
  XOMETRY_URLS,
} from "./adapters/xometryConstraints.js";
import {
  runFailClosedBrowserCleanup,
  type FailClosedBrowserCleanupOptions,
} from "./browserCleanup.js";
import type { WorkerConfig } from "./types.js";
import {
  coerceDomStructure,
  defineFingerprintVocabulary,
  fingerprint,
  normalizeLabel,
  UI_LABEL_PHRASES,
  type FingerprintRouteClass,
  type FingerprintVocabulary,
  type PageFingerprint,
  type SelectorMeasure,
} from "./fixtureHeal/fingerprint.js";
import type { DriftReference } from "./fixtureHeal/driftResult.js";
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

export const XOMETRY_AUTH_PROBE_PRE_NETWORK_GUARD = Symbol.for(
  "overdrafter.xometryAuthProbe.preNetworkGuard",
);

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
  screenshotCaptured: false;
  /**
   * No raw DOM, HTML or page text is captured or emitted. The not-confirmed
   * drift fingerprint (reviewed labels, test IDs and counts only) is written
   * separately to stderr and is not part of this evidence.
   */
  domCaptured: false;
  traceCaptured: false;
  providerMutationObserved: false;
  dashboardInteraction: "read_only_authentication";
};

export type XometryAuthProbeFailureStage =
  | "configuration"
  | "snapshot_restore"
  | "browser_launch"
  | "bounded_probe"
  | "guard_setup"
  | "guard_verification"
  | "live_precondition"
  | "network_activation"
  | "navigation_or_inspection"
  | "operation_timeout"
  | "network_reisolation"
  | "context_cleanup"
  | "unknown";

/**
 * Where a `navigation_or_inspection` failure happened: `goto` is the quote-home
 * navigation and its load wait, `inspection` the classification loop, and
 * `fingerprint` the tail after classification. Drift capture is fail-soft, so
 * `fingerprint` only catches a defect in that tail.
 */
const NAVIGATION_SUB_STAGES = ["goto", "inspection", "fingerprint"] as const;
export type XometryAuthProbeNavigationSubStage = (typeof NAVIGATION_SUB_STAGES)[number];

const NAVIGATION_CAUSES = ["timeout", "navigation_aborted", "context_destroyed", "net_error", "other"] as const;
export type XometryAuthProbeNavigationCause = (typeof NAVIGATION_CAUSES)[number];

export type XometryAuthProbeFailureEvidence = {
  authenticated: false;
  reason: "probe_failed";
  failureStage: XometryAuthProbeFailureStage;
  snapshotRestore?: { phase: XometrySnapshotRestorePhase | "profile_lock" | "postcondition"; reason: string };
  navigationOrInspection?: {
    subStage: XometryAuthProbeNavigationSubStage;
    cause: XometryAuthProbeNavigationCause;
  };
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

const SANITIZED_FAILURE_STAGE_PATTERNS: ReadonlyArray<
  readonly [string, XometryAuthProbeFailureStage]
> = [
  ["Xometry authentication probe guard setup failed.", "guard_setup"],
  [
    "Xometry authentication probe guard verification failed.",
    "guard_verification",
  ],
  [
    "Xometry authentication probe live precondition failed.",
    "live_precondition",
  ],
  [
    "Xometry authentication probe network activation failed.",
    "network_activation",
  ],
  [
    "Xometry authentication probe navigation or inspection failed.",
    "navigation_or_inspection",
  ],
  ["Xometry authentication probe operation timed out", "operation_timeout"],
  ["Xometry authentication probe network re-isolation", "network_reisolation"],
  ["Xometry authentication probe context cleanup", "context_cleanup"],
];

function sanitizedErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const visited = new Set<unknown>();

  const visit = (value: unknown) => {
    if (visited.has(value)) return;
    visited.add(value);

    if (value instanceof AggregateError) {
      try {
        for (const nestedError of value.errors) visit(nestedError);
      } catch {
        // A malformed errors accessor or iterator is untrusted diagnostics.
      }
    }
    if (!(value instanceof Error)) return;
    try {
      if (typeof value.message === "string") messages.push(value.message);
    } catch {
      // Malformed errors must not escape the fixed failure evidence contract.
    }
  };

  visit(error);
  return messages;
}

/** Classify only fixed internal error messages; never serialize the error itself. */
export function classifyXometryAuthProbeFailureStage(
  error: unknown,
  fallback: XometryAuthProbeFailureStage = "unknown",
): XometryAuthProbeFailureStage {
  for (const message of sanitizedErrorMessages(error)) {
    const match = SANITIZED_FAILURE_STAGE_PATTERNS.find(([pattern]) =>
      message.startsWith(pattern),
    );
    if (match) return match[1];
  }
  return fallback;
}

// Ordered: net::ERR_ABORTED also matches the generic net:: shape below.
const NAVIGATION_CAUSE_PATTERNS: ReadonlyArray<
  readonly [RegExp, XometryAuthProbeNavigationCause]
> = [
  [/\bTimeout \d+ms exceeded\b/, "timeout"],
  [/\bnet::ERR_ABORTED\b|\bNS_BINDING_ABORTED\b|\binterrupted by another navigation\b/, "navigation_aborted"],
  [
    /\bExecution context was destroyed\b|\bTarget page, context or browser has been closed\b|\bTarget (?:closed|crashed)\b|\bframe was detached\b/,
    "context_destroyed",
  ],
  [/\bnet::ERR_[A-Z_]+|\bNS_ERROR_[A-Z_]+|\bSSL_ERROR_[A-Z_]+/, "net_error"],
];

/**
 * Reduce a browser error to the closed cause vocabulary. Reads only the name
 * and the first message line (Playwright appends a call log), and returns
 * neither.
 */
function classifyNavigationCause(error: unknown): XometryAuthProbeNavigationCause {
  try {
    if (!(error instanceof Error)) return "other";
    if (error.name === "TimeoutError") return "timeout";
    const message = error.message;
    if (typeof message !== "string") return "other";
    const firstLine = message.split("\n", 1)[0];
    return NAVIGATION_CAUSE_PATTERNS.find(([pattern]) => pattern.test(firstLine))?.[1] ?? "other";
  } catch {
    return "other";
  }
}

/** Keeps the original fixed prefix so existing stage matching still applies. */
function navigationFailureMessage(
  subStage: XometryAuthProbeNavigationSubStage,
  cause: XometryAuthProbeNavigationCause,
) {
  return `Xometry authentication probe navigation or inspection failed. subStage=${subStage} cause=${cause}.`;
}

const NAVIGATION_FAILURE_DETAILS = NAVIGATION_SUB_STAGES.flatMap((subStage) =>
  NAVIGATION_CAUSES.map((cause) => ({
    subStage,
    cause,
    message: navigationFailureMessage(subStage, cause),
  })),
);

/** Recover the sub-stage and cause only from the probe's own fixed message. */
function navigationFailureDetail(error: unknown) {
  for (const message of sanitizedErrorMessages(error)) {
    const detail = NAVIGATION_FAILURE_DETAILS.find((candidate) => message.startsWith(candidate.message));
    if (detail) return { subStage: detail.subStage, cause: detail.cause };
  }
  return undefined;
}

const RESTORE_PHASES = new Set([
  "profile_lock", "postcondition", "credential", "metadata", "download",
  "archive_validation", "local_filesystem", "archive_extract", "manifest_validation", "cleanup",
]);
const SNAPSHOT_FAILURE_REASONS = new Set([
  "snapshot_missing", "snapshot_read_failed", "snapshot_generation_missing",
  "snapshot_too_large", "snapshot_missing_body", "snapshot_corrupt",
  "snapshot_unsafe_path", "snapshot_unsafe_entry", "snapshot_manifest_missing",
  "snapshot_manifest_invalid", "snapshot_incompatible", "snapshot_profile_uninitialized",
  "profile_directory_missing", "credential_unavailable",
]);
const FILESYSTEM_FAILURE_REASONS: Readonly<Record<string, string>> = {
  EACCES: "filesystem_eacces", EPERM: "filesystem_eperm", EROFS: "filesystem_erofs",
  ENOENT: "filesystem_enoent", ENOSPC: "filesystem_enospc", ENOTDIR: "filesystem_enotdir",
  ELOOP: "filesystem_eloop",
};

function safeSnapshotRestoreReason(error: unknown): string {
  try {
    if (error instanceof XometryProfileSnapshotError) {
      const reason = error.reason;
      if (SNAPSHOT_FAILURE_REASONS.has(reason)) return reason;
    }
    if (error instanceof VendorAutomationError && error.code === "profile_in_use") return "profile_in_use";
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === "string" && Object.hasOwn(FILESYSTEM_FAILURE_REASONS, code)) {
        return FILESYSTEM_FAILURE_REASONS[code];
      }
    }
  } catch {
    // Accessors and malformed thrown values cannot escape the fixed evidence shape.
  }
  return "unknown";
}

/** Return one stable failure shape without serializing low-level diagnostics. */
export function buildXometryAuthProbeFailureEvidence(
  failureStage: XometryAuthProbeFailureStage = "unknown",
  error?: unknown,
  restorePhase?: XometrySnapshotRestorePhase | "profile_lock" | "postcondition",
): XometryAuthProbeFailureEvidence {
  const navigationOrInspection =
    failureStage === "navigation_or_inspection" ? navigationFailureDetail(error) : undefined;
  return {
    authenticated: false,
    reason: "probe_failed",
    failureStage,
    ...(failureStage === "snapshot_restore" && restorePhase && RESTORE_PHASES.has(restorePhase)
      ? { snapshotRestore: { phase: restorePhase, reason: safeSnapshotRestoreReason(error) } }
      : {}),
    ...(navigationOrInspection ? { navigationOrInspection } : {}),
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

  const dashboardTextVisible = signalPresent(
    input.bodyText,
    XOMETRY_LOCATORS.dashboardSignals,
  );
  const accountQuoteListVisible =
    XOMETRY_LOCATORS.accountQuoteListSignals.every((pattern) =>
      pattern.test(input.bodyText),
    );
  const dashboardConfirmed = quoteHome && (dashboardTextVisible || accountQuoteListVisible);
  // The anonymous prompt can coexist with an error banner or a real dashboard.
  // Only absent dashboard evidence makes session recovery the actionable cause.
  if (
    quoteHome && !dashboardConfirmed &&
    signalPresent(input.bodyText, XOMETRY_LOCATORS.anonymousUploadPromptSignals)
  ) {
    return { authenticated: false, reason: "anonymous_quote_home" };
  }

  if (signalPresent(input.bodyText, XOMETRY_LOCATORS.genericErrorSignals)) {
    return { authenticated: false, reason: "provider_error" };
  }

  if (dashboardConfirmed) {
    return { authenticated: true, reason: "authenticated_dashboard" };
  }

  return {
    authenticated: false,
    reason: "authenticated_dashboard_not_confirmed",
  };
}

/** The final URL as a path class for the drift fingerprint; mirrors the classifier's URL checks. */
export function xometryRouteClass(value: string): FingerprintRouteClass {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "invalid";
  }
  const xometryOwnedOrigin =
    parsed.protocol === "https:" &&
    (parsed.hostname === "xometry.com" || parsed.hostname.endsWith(".xometry.com"));
  if (!xometryOwnedOrigin) return "external";
  if (parsed.pathname.includes("/login")) return "login";
  if (value.startsWith(XOMETRY_URLS.quoteHome)) return "quote_home";
  if (XOMETRY_URLS.quotePathPattern.test(parsed.pathname)) return "quote_page";
  if (parsed.pathname.startsWith(new URL(XOMETRY_URLS.quoteCreation).pathname)) return "quote_new";
  return "provider_other";
}

const DRIFT_SIGNAL_GROUPS = [
  "dashboardSignals",
  "accountQuoteListSignals",
  "loginSignals",
  "anonymousQuoteHomeSignals",
  "anonymousEmailGateSignals",
  "captchaSignals",
  "genericErrorSignals",
  "itarPopupSignals",
  "renamePartsPopupSignals",
] as const satisfies ReadonlyArray<keyof typeof XOMETRY_LOCATORS>;

const DRIFT_ENTRY_SELECTOR_GROUPS = [
  "dashboardUploadButtons",
  "dashboardUploadPanels",
  "accountQuoteListStartButtons",
  "startNewQuoteButtons",
] as const satisfies ReadonlyArray<keyof typeof XOMETRY_LOCATORS>;

const DRIFT_SELECTOR_GROUPS = [
  ...DRIFT_ENTRY_SELECTOR_GROUPS,
  "uploadInputs",
  "standaloneUploadInputs",
  "uploadTriggers",
] as const satisfies ReadonlyArray<keyof typeof XOMETRY_LOCATORS>;

const pickLocatorGroups = <K extends keyof typeof XOMETRY_LOCATORS>(groups: readonly K[]) =>
  Object.fromEntries(groups.map((group) => [group, XOMETRY_LOCATORS[group]])) as Record<K, (typeof XOMETRY_LOCATORS)[K]>;

const locatorEntries = () =>
  Object.values(XOMETRY_LOCATORS).flatMap((value): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [value]));

/** Literal text in the adapter's own selectors and plain signal phrases: Xometry labels a fingerprint may name. */
function xometryLocatorLabels() {
  const labels: string[] = [XOMETRY_LOCATORS.accountQuoteListStartButtonText];
  for (const entry of locatorEntries()) {
    if (typeof entry === "string") {
      for (const match of entry.matchAll(/(?:has-text|text-is)\("([^"]+)"\)|^text=\/\^(.+)\$\/i$/g)) {
        labels.push(match[1] ?? match[2]);
      }
    } else if (entry instanceof RegExp) {
      const phrase = entry.source.replace(/\\b/g, "");
      if (/^[a-z0-9 ]+$/i.test(phrase)) labels.push(phrase);
    }
  }
  return labels.map(normalizeLabel).filter(Boolean);
}

/** Exact `[data-testid="..."]` values the adapter's selectors rely on. */
function xometryLocatorTestIds() {
  return locatorEntries().flatMap((entry) =>
    typeof entry === "string" ? [...entry.matchAll(/\[data-testid="([^"]+)"\]/g)].map((match) => match[1]) : []);
}

/** Every string the drift fingerprint may carry, all taken from reviewed code constants. */
export const XOMETRY_AUTH_PROBE_FINGERPRINT_VOCABULARY: FingerprintVocabulary = defineFingerprintVocabulary({
  signalGroups: pickLocatorGroups(DRIFT_SIGNAL_GROUPS),
  selectorGroups: pickLocatorGroups(DRIFT_SELECTOR_GROUPS),
  labels: new Set([...UI_LABEL_PHRASES, ...xometryLocatorLabels()]),
  testIds: new Set(xometryLocatorTestIds()),
});

/** What `classifyXometryAuthProbe` needs to see on the quote home page. Keep in step with it. */
export const XOMETRY_AUTH_PROBE_DRIFT_REFERENCE: DriftReference = {
  provider: "xometry",
  page: "upload",
  routeClass: "quote_home",
  confirming: [
    { group: "dashboardSignals", need: "any" },
    { group: "accountQuoteListSignals", need: "all" },
  ],
  terminal: [
    { group: "captchaSignals", need: "any" },
    { group: "loginSignals", need: "any" },
    { group: "anonymousQuoteHomeSignals", need: "all" },
    { group: "anonymousEmailGateSignals", need: "all" },
    { group: "genericErrorSignals", need: "any" },
  ],
  entrySelectors: DRIFT_ENTRY_SELECTOR_GROUPS,
  locatorSource: "worker/src/adapters/xometryConstraints.ts XOMETRY_LOCATORS",
  vocabulary: XOMETRY_AUTH_PROBE_FINGERPRINT_VOCABULARY,
};

const DRIFT_FINGERPRINT_TIMEOUT_MS = 3_000;

// Read-only structure walk. Runs in the page as a string so the worker build
// needs no DOM types. Input values and attributes other than aria-label and
// data-testid are never read. Labels stay in this process: the Node side keeps
// only reviewed phrases and counts the rest.
const COLLECT_PAGE_STRUCTURE = `(() => {
  const label = (el) => (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 400);
  const all = (selector) => Array.from(document.querySelectorAll(selector)).slice(0, 300);
  const roles = {
    banner: 'header,[role="banner"]', navigation: 'nav,[role="navigation"]', main: 'main,[role="main"]',
    contentinfo: 'footer,[role="contentinfo"]', complementary: 'aside,[role="complementary"]',
    search: 'search,[role="search"]', form: 'form,[role="form"]', region: '[role="region"]',
    dialog: 'dialog[open],[role="dialog"],[role="alertdialog"]', alert: '[role="alert"]',
  };
  return {
    landmarks: Object.fromEntries(Object.entries(roles).map(([role, selector]) => [role, document.querySelectorAll(selector).length])),
    headings: all('h1,h2,h3,h4,h5,h6,[role="heading"]').map(label),
    buttons: all('button,[role="button"]').map(label),
    links: all('a[href],[role="link"]').map(label),
    testIds: all("[data-testid]").map((el) => (el.getAttribute("data-testid") || "").slice(0, 400)),
  };
})()`;

/** The route class and body text come from the classified read, so a late redirect cannot skew them. */
async function collectDriftFingerprint(
  page: Page,
  classified: { bodyText: string; routeClass: FingerprintRouteClass },
): Promise<PageFingerprint | null> {
  const structure = coerceDomStructure(await page.evaluate(COLLECT_PAGE_STRUCTURE));
  if (!structure) return null;
  const selectorGroups: Record<string, SelectorMeasure[]> = {};
  for (const group of DRIFT_SELECTOR_GROUPS) {
    const measures: SelectorMeasure[] = [];
    for (const selector of XOMETRY_LOCATORS[group] as readonly string[]) {
      const locator = page.locator(selector);
      const count = await locator.count();
      measures.push({ count, visible: count > 0 && (await locator.first().isVisible()) });
    }
    selectorGroups[group] = measures;
  }
  return fingerprint(
    { provider: "xometry", page: "upload", source: "session_probe", ...classified, ...structure, selectorGroups },
    XOMETRY_AUTH_PROBE_FINGERPRINT_VOCABULARY,
  );
}

/** Bounded and fail-soft: a capture failure or timeout yields null and never changes the probe result. */
async function captureDriftFingerprint(
  page: Page,
  classified: { bodyText: string; routeClass: FingerprintRouteClass },
): Promise<PageFingerprint | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DRIFT_FINGERPRINT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([collectDriftFingerprint(page, classified).catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
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
    screenshotCaptured: false,
    domCaptured: false,
    traceCaptured: false,
    providerMutationObserved: false,
    dashboardInteraction: "read_only_authentication",
  };
}

/**
 * Navigate and classify a restored profile with the production probe's
 * read-only request and WebSocket guards. Page text is discarded after
 * classification and is never included in the returned evidence. The probe
 * polls at most 20 times at 500 ms intervals, stopping early for authenticated,
 * CAPTCHA, provider-error, or login terminal states.
 *
 * Safety ordering is strict: the context starts offline; the probe installs
 * guards, creates a replacement guarded page, and verifies those guards;
 * restored pages close only after that replacement exists; network access is
 * enabled last.
 *
 * When the result is `authenticated_dashboard_not_confirmed` and
 * `onDashboardNotConfirmed` is set, the probe also takes a scrubbed structural
 * fingerprint of the same page (OVD-796 slice 5) and hands it, or null when
 * capture failed, to the callback. The returned evidence never includes it.
 *
 * @param context - Newly launched persistent browser context to probe.
 * @returns Sanitized authentication evidence from the bounded read-only probe.
 * @throws An error with a fixed stage message when setup, activation, navigation,
 * or inspection fails. A navigation or inspection failure also names its
 * sub-stage and closed-vocabulary cause, never the underlying error text.
 */
export async function runBoundedXometryAuthProbe(
  context: BrowserContext,
  options: {
    beforeNetworkActivation?: () => Promise<void>;
    onDashboardNotConfirmed?: (fingerprint: PageFingerprint | null) => void;
  } = {},
): Promise<XometryAuthProbeBaseEvidence> {
  const blockedMethods = new Set<string>();
  let restoredPages: Page[] = [];
  try {
    restoredPages = context.pages();
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
    await Promise.all(
      restoredPages.map((restoredPage) => restoredPage.close()),
    );
  } catch {
    throw new Error("Xometry authentication probe guard verification failed.");
  }

  try {
    await options.beforeNetworkActivation?.();
  } catch {
    throw new Error("Xometry authentication probe live precondition failed.");
  }

  try {
    await context.setOffline(false);
  } catch {
    throw new Error("Xometry authentication probe network activation failed.");
  }

  let subStage: XometryAuthProbeNavigationSubStage = "goto";
  try {
    await page.goto(XOMETRY_URLS.quoteHome, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    subStage = "inspection";
    let lastResult: XometryAuthProbeResult = {
      authenticated: false,
      reason: "authenticated_dashboard_not_confirmed",
    };
    let dashboardUploadButtonVisible = false;
    let bodyText = "";
    let classifiedUrl = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      bodyText = await page.locator("body").innerText();
      dashboardUploadButtonVisible = await Promise.any(
        XOMETRY_LOCATORS.dashboardUploadButtons.map(async (selector) => {
          if (await page.locator(selector).first().isVisible()) return true;
          throw new Error("not visible");
        }),
      ).catch(() => false);
      classifiedUrl = page.url();
      lastResult = classifyXometryAuthProbe({
        url: classifiedUrl,
        bodyText,
        dashboardUploadButtonVisible,
      });
      if (
        lastResult.authenticated ||
        lastResult.reason === "captcha" ||
        lastResult.reason === "provider_error" ||
        classifiedUrl.includes("/login")
      ) {
        break;
      }
      if (attempt < 19) {
        await page.waitForTimeout(500);
      }
    }

    subStage = "fingerprint";
    if (
      !lastResult.authenticated &&
      lastResult.reason === "authenticated_dashboard_not_confirmed" &&
      options.onDashboardNotConfirmed
    ) {
      const driftFingerprint = await captureDriftFingerprint(page, {
        bodyText,
        routeClass: xometryRouteClass(classifiedUrl),
      });
      try {
        options.onDashboardNotConfirmed(driftFingerprint);
      } catch {
        // Drift reporting must never change the probe's classification.
      }
    }

    // The URL that was classified, never one read after the capture's awaits.
    return {
      ...lastResult,
      url: sanitizedUrl(classifiedUrl),
      blockedNonReadMethods: [...blockedMethods].sort((left, right) =>
        left.localeCompare(right),
      ),
      dashboardUploadButtonVisible,
      fileSelectionPerformed: false,
      userInputInteractionPerformed: false,
    };
  } catch (error) {
    throw new Error(navigationFailureMessage(subStage, classifyNavigationCause(error)));
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
    screenshotCaptured: false,
    domCaptured: false,
    traceCaptured: false,
    providerMutationObserved: false,
    dashboardInteraction: "read_only_authentication",
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
