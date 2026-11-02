import { refuseOshcutPortalAutomation } from "./oshcutPortalDisabled.js";
import { constants } from "node:fs";
import { CleanupRowsUnproven, UploadedPortalRows } from "./providerPortalCleanupRows.js";
import { CleanupConfirmationUnproven, CleanupRowConfirmation, trackCleanupShadowRoots, verifyCleanupShadowVisibility } from "./providerPortalCleanupConfirmation.js";
import { triageUnstructuredFailure, type FailureTriageOptions } from "../recovery/failureTriage.js";
import { captureFreshOperationalRecovery, observeBoundOperationalFailure, type OperationalJevBinding } from "../jev/operationalSession.js";
import { createBrowserRecovery, type BrowserRecoveryOptions } from "../recovery/browserRecovery.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
  type Request,
} from "playwright";
import {
  gateLeadTime,
  gateVendorPrice,
  type ExtractedValue,
} from "../extractedValue.js";
import { getAuthorizedLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import { markProviderMutationStarted } from "../providerMutationPhase.js";
import { ProviderAbortedError } from "../providerAbort.js";
import { ProviderKillSwitchError } from "../providerKillSwitch.js";
import { chromiumSandboxLaunchOptions } from "../chromiumLaunchOptions.js";
import { PROVIDER_REGISTRY, type ProviderRegistryEntry } from "../generated/providerRegistry.js";
import { providerDispatchAuthorizationDenial } from "./providerDispatchAuthorization.js";
import { isDispatchDecisionError } from "../dispatchDecisionError.js";
import {
  VendorAutomationError,
  LIVE_AUTOMATION_VENDORS,
  type GeographicOrigin,
  type LiveAutomationVendorName,
  type LiveEvaluationUploadFiles,
  type ProviderPortalApprovalDescriptor,
  type VendorArtifact,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOffer,
  type WorkerConfig,
} from "../types.js";

import {
  isSelectorAnchored,
  isSupportedLocalCurrency,
  parseLocalNativeCurrencyOffer,
  type LocalNativeCurrencyOffer,
} from "./localEvaluationResult.js";

export const PROVIDER_PORTAL_KERNEL_REVISION = "provider-portal-kernel.v1" as const;

export type ProviderPortalTerminalState =
  | "login_required"
  | "captcha"
  | "missing_session"
  | "unexpected_origin"
  | "selector_drift"
  | "configuration_required"
  | "manual_review"
  | "unsupported"
  | "unavailable";

export type ProviderPortalState = ProviderPortalTerminalState | "ready";

export type ProviderPortalEligibility = {
  state: "eligible" | "unsupported" | "unavailable";
  reason: string;
};

export type ProviderPortalSnapshot = {
  url: string;
  bodyText: string;
  passwordInputCount: number;
};

export type ProviderPortalOfferCandidate = {
  providerOptionId: string | null;
  providerLabel: string | null;
  quoteRef: string | null;
  quoteUrl: string | null;
  quantity: number;
  unitPriceUsd: ExtractedValue<number>;
  totalPriceUsd: ExtractedValue<number>;
  leadTimeBusinessDays: ExtractedValue<number>;
  shipReceiveBy: string | null;
  tier: string | null;
  sourcing: string | null;
  geographicOrigin: GeographicOrigin | null;
  geographicOriginSource: "provider_text" | "none";
  containerSelector: string | null;
  providerOptionIdSource: "attribute" | "provider_label" | null;
  validUntil: string | null;
  validityDurationDays: number | null;
  validitySource: "vendor_date" | "vendor_duration" | null;
  validityTerms: string | null;
  rawPayload: Record<string, unknown>;
};

/** Native money is available only through the dedicated local-evidence result. */
export type ProviderPortalNativeOfferCandidate = Omit<ProviderPortalOfferCandidate, "unitPriceUsd" | "totalPriceUsd"> & {
  money: {
    unitAmount: ExtractedValue<number>;
    totalAmount: ExtractedValue<number>;
    unitCurrency: ExtractedValue<string>;
    totalCurrency: ExtractedValue<string>;
  };
};

export type ProviderPortalNormalizedOffer = VendorQuoteAdapterOffer & {
  quantity: number;
  validUntil: string | null;
  validityDurationDays: number | null;
  validitySource: "vendor_date" | "vendor_duration" | null;
  validityTerms: string | null;
  artifactRefs: string[];
};

export type ProviderPortalReadCapability = {
  count: (selector: string) => Promise<number>;
  readText: (selector: string) => Promise<string | null>;
  readTexts: (selector: string) => Promise<string[]>;
  readAttribute: (selector: string, attribute: string) => Promise<string | null>;
};

export type ProviderPortalConfigurationCapability = {
  fill: (field: string, value: string) => Promise<boolean>;
  select: (field: string, value: string) => Promise<boolean>;
  /**
   * Clicks the first element of a declared `click` rule whose trimmed text is
   * exactly `text` (or the first element when `text` is omitted). Returns
   * false, without recovery, when no such element exists.
   */
  click: (field: string, text?: string) => Promise<boolean>;
};

/**
 * Post-capture removal of the uploaded test part (Blaine's standing rule,
 * 2026-10-15). Only declared cleanup rules are reachable. A rule with a
 * `scope` resolves inside a unique row containing `scopeText`. Clicks without
 * a row binding, or with ambiguous targets, require manual cleanup.
 */
export type ProviderPortalCleanupCapability = {
  count: (field: string, scopeText?: string) => Promise<number>;
  click: (field: string, scopeText?: string) => Promise<boolean>;
};

export type ProviderPortalCleanupOutcome = { removed: number; remaining: number };

export type ProviderPortalCleanupReport = {
  status: "removed" | "not_found" | "incomplete" | "failed" | "skipped_kill_switch";
  removed: number;
  remaining: number | null;
  reason: string | null;
  manualCleanupRows?: Array<{ fileName: string | null }>;
  lostPreUploadRows?: Array<{ fileName: string | null }>;
};

/** Upper bound for one cleanup pass; it never delays the result longer. */
export const PROVIDER_PORTAL_CLEANUP_TIMEOUT_MS = 30_000;

export type ProviderPortalDefinition = {
  provider: LiveAutomationVendorName;
  displayName: string;
  manifestRevision: string;
  envelopeRevision: string;
  adapterRevision: string;
  accountMode: string;
  routes: {
    publicUrl: string;
    loginUrl: string;
    uploadUrl: string;
  };
  allowedHosts: readonly string[];
  /**
   * OVD-773: exact off-host hostnames the portal genuinely needs (for example
   * a JS CDN). Subresource requests to them are continued instead of quietly
   * blocked; navigation and payload-bearing requests to them stay violations.
   * Absent, the provider registry's `offHostAllowlist` applies (empty by default).
   */
  offHostAllowlist?: readonly string[];
  selectors: {
    cadUpload: string;
    drawingUpload?: string;
    quantity?: string;
    /**
     * Optional bound (ms) to wait for the quantity control to attach after
     * upload, for portals that render the part row asynchronously. Absent, the
     * kernel looks for it once, immediately.
     */
    quantityAwaitMs?: number;
    configuration?: Readonly<Record<string, {
      selector: string;
      operation: "fill" | "select" | "click";
    }>>;
    /** Snapshot before upload; new DOM identities are candidates, not ownership proof. */
    cleanupRow?: string;
    /** Field whose entire unnormalized text is the full filename. */
    cleanupRowFileName?: string;
    /** Cleanup rules; reportOnly forbids clicks and reports new uploadedRows candidates. */
    cleanup?: Readonly<Record<string, { selector: string; scope?: string; uploadedRows?: boolean; reportOnly?: boolean }>>;
  };
  supportedFileExtensions: readonly string[];
  terminalSignals: {
    login: readonly RegExp[];
    captcha: readonly RegExp[];
    manualReview: readonly RegExp[];
    configurationRequired: readonly RegExp[];
    unavailable: readonly RegExp[];
  };
  requirements: {
    quoteOnly: true;
    orderProhibited: true;
    isolatedSession: true;
  };
  /**
   * Opt-in production dispatch (OVD-674). Absent, the kernel serves only
   * operator-approved live evaluation. Present, a non-evaluation input
   * launches only with a current generic provider-dispatch authorization for
   * exactly this provider and reviewed envelope, bound to the staged bytes.
   */
  productionDispatch?: {
    envelope: { id: string; version: number };
  };
  hooks: {
    /** Read-only guard at initial classification and again immediately before upload. */
    beforeUpload?: (reader: ProviderPortalReadCapability) => void | Promise<void>;
    assessEligibility: (
      input: VendorQuoteAdapterInput,
    ) => ProviderPortalEligibility | Promise<ProviderPortalEligibility>;
    /** `reader` lets a definition verify the page it is about to mutate between configuration steps. */
    configure: (
      configuration: ProviderPortalConfigurationCapability,
      input: VendorQuoteAdapterInput,
      reader: ProviderPortalReadCapability,
    ) => void | Promise<void>;
    classifyPortalState: (
      snapshot: ProviderPortalSnapshot,
    ) => ProviderPortalState | Promise<ProviderPortalState>;
    extractOffers: (
      reader: ProviderPortalReadCapability,
      input: VendorQuoteAdapterInput,
    ) => Array<ProviderPortalOfferCandidate | ProviderPortalNativeOfferCandidate>
      | Promise<Array<ProviderPortalOfferCandidate | ProviderPortalNativeOfferCandidate>>;
    /**
     * Removes the uploaded part once everything is captured. The kernel runs
     * it after the result or failure of any attempt that reached upload, in
     * the same page, bounded by PROVIDER_PORTAL_CLEANUP_TIMEOUT_MS. It is
     * best-effort: its failure is logged and reported, never thrown, and
     * never changes the attempt's result or error.
     */
    cleanup?: (
      cleanup: ProviderPortalCleanupCapability,
      input: VendorQuoteAdapterInput,
    ) => Promise<ProviderPortalCleanupOutcome>;
  };
};

type ProviderPortalKernelResultBase = {
  reason: string;
  url: string | null;
  artifacts: VendorArtifact[];
  providerMutationPossible: boolean;
  /** OVD-773: off-host requests the boundary quietly blocked; set once a browser session ran. */
  portalBoundary?: PortalBoundaryTelemetry;
  /** Set when the definition declares cleanup and the attempt reached upload. */
  cartCleanup?: ProviderPortalCleanupReport;
};

export type ProviderPortalKernelResult = ProviderPortalKernelResultBase & (
  | { state: ProviderPortalTerminalState | "offers_extracted"; offers: ProviderPortalNormalizedOffer[] }
  | { state: "native_offers_extracted"; offers: []; nativeOffers: LocalNativeCurrencyOffer[] }
);

type BrowserLauncher = (
  options: Parameters<typeof chromium.launch>[0],
) => Promise<Browser>;

export type RunProviderPortalKernelDependencies = {
  /** Separate audit-only consumer, observing the original error before translation. */
  operationalJev?: OperationalJevBinding;
  /** Explicit per-run opt-in; does not authorize file disclosure or production use. */
  recovery?: BrowserRecoveryOptions;
  /** Optional advisory exception categorization; never affects terminal state/retries. */
  failureTriage?: FailureTriageOptions;
  launchBrowser?: BrowserLauncher;
  /** Test seam for the cleanup bound; defaults to PROVIDER_PORTAL_CLEANUP_TIMEOUT_MS. */
  cleanupTimeoutMs?: number;
  captureEvidence?: (
    definition: ProviderPortalDefinition,
    config: WorkerConfig,
    state: ProviderPortalTerminalState | "offers_extracted",
    snapshot: ProviderPortalSnapshot,
    portalBoundary?: PortalBoundaryTelemetry,
  ) => Promise<VendorArtifact[]>;
};

const DEFAULT_TERMINAL_SIGNALS: ProviderPortalDefinition["terminalSignals"] = {
  login: [/\b(?:login|sign[ -]?in|registration|register)\b/i],
  captcha: [/\b(?:captcha|verify you are human|cloudflare challenge|security check)\b/i],
  manualReview: [/\b(?:manual review|engineering review|requires review|quote request received)\b/i],
  configurationRequired: [/\b(?:select material|select thickness|configure (?:your )?part|enter your zip code)\b/i],
  unavailable: [/\b(?:service unavailable|temporarily unavailable|maintenance)\b/i],
};

const APPROVAL_KEYS = [
  "accountMode",
  "allowedOrigins",
  "artifactScope",
  "cadPath",
  "cadFileSha256",
  "drawingPath",
  "drawingFileSha256",
  "intendedAction",
  "providerKey",
  "requestedQuantities",
  "schemaVersion",
] as const;

const alphabeticalCompare = (left: string, right: string): number => left.localeCompare(right);

/** Returns true only for an exact HTTPS host declared by the provider definition. */
export function isAllowedProviderUrl(
  rawUrl: string,
  allowedHosts: readonly string[],
): boolean {
  try {
    const url = new URL(rawUrl);
    const allowed = new Set(allowedHosts.map((host) => host.trim().toLowerCase()));
    return url.protocol === "https:"
      && (url.port === "" || url.port === "443")
      && !url.username
      && !url.password
      && allowed.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Returns true only for an exact secure WebSocket host declared by the provider definition. */
export function isAllowedProviderWebSocketUrl(
  rawUrl: string,
  allowedHosts: readonly string[],
): boolean {
  try {
    const url = new URL(rawUrl);
    const allowed = new Set(allowedHosts.map((host) => host.trim().toLowerCase()));
    return url.protocol === "wss:"
      && (url.port === "" || url.port === "443")
      && !url.username
      && !url.password
      && allowed.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function assertProviderDefinition(definition: ProviderPortalDefinition): void {
  if (
    definition.requirements.quoteOnly !== true
    || definition.requirements.orderProhibited !== true
    || definition.requirements.isolatedSession !== true
  ) {
    throw new Error(`${definition.provider} portal definition weakens mandatory safety requirements.`);
  }
  if (definition.allowedHosts.length === 0) {
    throw new Error(`${definition.provider} portal definition has no allowed hosts.`);
  }
  for (const route of Object.values(definition.routes)) {
    if (!isAllowedProviderUrl(route, definition.allowedHosts)) {
      throw new Error(`${definition.provider} portal definition contains an unapproved route.`);
    }
  }
  if (!effectiveOffHostAllowlist(definition).every((host) => EXACT_HOSTNAME.test(host))) {
    throw new Error(`${definition.provider} portal definition contains an inexact off-host allowlist entry.`);
  }
  for (const rule of Object.values(definition.selectors.configuration ?? {})) {
    if (PROHIBITED_CONFIGURATION_SELECTOR.test(rule.selector)) {
      throw new Error(`${definition.provider} portal definition contains a prohibited configuration selector.`);
    }
  }
  if ([definition.selectors.cleanupRow, definition.selectors.cleanupRowFileName]
    .some((selector) => PROHIBITED_CLEANUP_SELECTOR.test(selector ?? ""))) {
    throw new Error(`${definition.provider} portal definition contains a prohibited cleanup selector.`);
  }
  for (const rule of Object.values(definition.selectors.cleanup ?? {})) {
    if (PROHIBITED_CLEANUP_SELECTOR.test(rule.selector) || PROHIBITED_CLEANUP_SELECTOR.test(rule.scope ?? "")) {
      throw new Error(`${definition.provider} portal definition contains a prohibited cleanup selector.`);
    }
  }
}

/** Cleanup works inside the cart by design, but never near checkout or payment. */
const PROHIBITED_CLEANUP_SELECTOR = /checkout|purchase|payment|place.?order|submit/i;

const PROHIBITED_CONFIGURATION_SELECTOR = /checkout|order|purchase|payment|cart/i;

/** Lowercase DNS hostname with at least one dot; no wildcard, port, or path. */
const EXACT_HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The definition's off-host allowlist, else the provider registry's (OVD-773). */
export function effectiveOffHostAllowlist(definition: ProviderPortalDefinition): readonly string[] {
  const registry = PROVIDER_REGISTRY as Readonly<Record<string, ProviderRegistryEntry | undefined>>;
  return definition.offHostAllowlist ?? registry[definition.provider]?.offHostAllowlist ?? [];
}

function terminalError(
  definition: ProviderPortalDefinition,
  state: ProviderPortalTerminalState,
  reason: string,
  extra: Record<string, unknown> = {},
): VendorAutomationError {
  let code: ConstructorParameters<typeof VendorAutomationError>[1] = "unexpected_ui_state";
  if (state === "login_required" || state === "missing_session") {
    code = "login_required";
  } else if (state === "captcha") {
    code = "captcha";
  } else if (state === "selector_drift") {
    code = "selector_failure";
  }

  return new VendorAutomationError(
    `${definition.displayName} evaluation stopped: ${reason}.`,
    code,
    {
      vendor: definition.provider,
      terminalState: state,
      reason,
      kernelRevision: PROVIDER_PORTAL_KERNEL_REVISION,
      ...extra,
    },
  );
}

function normalizedCookieDomain(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const lower = value.trim().toLowerCase();
  const normalized = lower.startsWith(".") ? lower.slice(1) : lower;
  if (!normalized || normalized.startsWith(".") || normalized.includes("/")) {
    return null;
  }
  return normalized;
}

function isAllowedCookie(cookie: unknown, allowed: ReadonlySet<string>): boolean {
  if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) {
    return false;
  }
  const domain = normalizedCookieDomain((cookie as Record<string, unknown>).domain);
  return domain !== null && allowed.has(domain);
}

function isAllowedExactOriginEntry(originEntry: unknown, allowedHosts: readonly string[]): boolean {
  if (!originEntry || typeof originEntry !== "object" || Array.isArray(originEntry)) {
    return false;
  }
  const origin = (originEntry as Record<string, unknown>).origin;
  if (typeof origin !== "string" || !isAllowedProviderUrl(origin, allowedHosts)) {
    return false;
  }
  const parsedOrigin = new URL(origin);
  return parsedOrigin.pathname === "/"
    && !parsedOrigin.search
    && !parsedOrigin.hash
    && !parsedOrigin.username
    && !parsedOrigin.password;
}

function parseStorageState(
  value: unknown,
  allowedHosts: readonly string[],
): Exclude<BrowserContextOptions["storageState"], string | undefined> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.cookies) || !Array.isArray(record.origins)) {
    return null;
  }
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  if (!record.cookies.every((cookie) => isAllowedCookie(cookie, allowed))) {
    return null;
  }
  if (!record.origins.every((originEntry) => isAllowedExactOriginEntry(originEntry, allowedHosts))) {
    return null;
  }
  if (record.sessionStorage !== undefined && !isValidSessionStorageCapture(record.sessionStorage, allowedHosts)) {
    return null;
  }
  return value as Exclude<BrowserContextOptions["storageState"], string | undefined>;
}

/** Per-origin sessionStorage captured beside Playwright's storage state (OVD-1059); Playwright itself never saves it. */
export type CapturedSessionStorageOrigin = {
  origin: string;
  sessionStorage: { name: string; value: string }[];
};

function isValidSessionStorageCapture(value: unknown, allowedHosts: readonly string[]): value is CapturedSessionStorageOrigin[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const { origin, sessionStorage } = entry as Record<string, unknown>;
    if (typeof origin !== "string" || !isAllowedProviderUrl(origin, allowedHosts)) return false;
    if (new URL(origin).origin !== origin) return false;
    return Array.isArray(sessionStorage) && sessionStorage.every((item) => item && typeof item === "object"
      && typeof (item as Record<string, unknown>).name === "string"
      && typeof (item as Record<string, unknown>).value === "string");
  });
}

/** Splits the sessionStorage capture off, since Playwright's storageState option does not accept it. */
export function splitSessionStorage(
  storageState: Exclude<BrowserContextOptions["storageState"], string | undefined>,
): {
  playwrightState: Exclude<BrowserContextOptions["storageState"], string | undefined>;
  sessionStorage: CapturedSessionStorageOrigin[];
} {
  const { sessionStorage, ...playwrightState } = storageState as typeof storageState & {
    sessionStorage?: CapturedSessionStorageOrigin[];
  };
  return { playwrightState, sessionStorage: sessionStorage ?? [] };
}

/** Restores captured sessionStorage on its exact origin before any portal script runs. */
export async function seedSessionStorage(
  context: Pick<BrowserContext, "addInitScript">,
  captured: CapturedSessionStorageOrigin[],
): Promise<void> {
  if (captured.length === 0) return;
  await context.addInitScript((origins: CapturedSessionStorageOrigin[]) => {
    const match = origins.find((entry) => entry.origin === globalThis.location.origin);
    if (!match) return;
    try {
      for (const { name, value } of match.sessionStorage) {
        if (globalThis.sessionStorage.getItem(name) === null) globalThis.sessionStorage.setItem(name, value);
      }
    } catch {
      // A sandboxed frame without storage simply stays logged out.
    }
  }, captured);
}

async function hasSymlinkedPathComponent(filePath: string): Promise<boolean> {
  const absolutePath = path.resolve(filePath);
  const parsed = path.parse(absolutePath);
  const relativeParts = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of relativeParts.slice(0, -1)) {
    current = path.join(current, part);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

async function readOpenedRegularFile(filePath: string): Promise<Buffer | null> {
  const absolutePath = path.resolve(filePath);
  if (await hasSymlinkedPathComponent(absolutePath)) {
    return null;
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(absolutePath, constants.O_RDONLY | noFollow);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return null;
    }
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Parses the exact closed operator-approval descriptor. */
export function parseProviderPortalApprovalDescriptor(
  value: unknown,
): ProviderPortalApprovalDescriptor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort(alphabeticalCompare))
    !== JSON.stringify([...APPROVAL_KEYS].sort(alphabeticalCompare))
  ) {
    return null;
  }
  if (
    record.schemaVersion !== "provider-portal-approval.v1"
    || typeof record.providerKey !== "string"
    || !LIVE_AUTOMATION_VENDORS.includes(record.providerKey as LiveAutomationVendorName)
    || typeof record.accountMode !== "string"
    || !record.accountMode.trim()
    || record.accountMode.length > 120
    || record.intendedAction !== "quote_only"
    || !Array.isArray(record.allowedOrigins)
    || record.allowedOrigins.length === 0
    || !Array.isArray(record.artifactScope)
    || typeof record.cadPath !== "string"
    || !path.isAbsolute(record.cadPath)
    || path.resolve(record.cadPath) !== record.cadPath
    || !(record.drawingPath === null
      || typeof record.drawingPath === "string"
        && path.isAbsolute(record.drawingPath)
        && path.resolve(record.drawingPath) === record.drawingPath)
    || !Array.isArray(record.requestedQuantities)
    || record.requestedQuantities.length === 0
    || record.requestedQuantities.some((quantity) =>
      !Number.isSafeInteger(quantity) || Number(quantity) < 1)
    || typeof record.cadFileSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.cadFileSha256)
    || !(record.drawingFileSha256 === null
      || typeof record.drawingFileSha256 === "string"
        && /^[a-f0-9]{64}$/.test(record.drawingFileSha256))
  ) {
    return null;
  }
  const allowedOrigins = record.allowedOrigins;
  if (allowedOrigins.some((origin) => {
    if (typeof origin !== "string") {
      return true;
    }
    try {
      const parsed = new URL(origin);
      return parsed.protocol !== "https:"
        || (parsed.port !== "" && parsed.port !== "443")
        || parsed.pathname !== "/"
        || Boolean(parsed.search || parsed.hash || parsed.username || parsed.password);
    } catch {
      return true;
    }
  })) {
    return null;
  }
  const artifactScope = record.artifactScope;
  const allowedArtifacts = new Set(["cad_upload", "drawing_upload", "scrubbed_local_evidence"]);
  if (
    artifactScope.some((entry) => typeof entry !== "string" || !allowedArtifacts.has(entry))
    || new Set(artifactScope).size !== artifactScope.length
  ) {
    return null;
  }
  return {
    schemaVersion: "provider-portal-approval.v1",
    providerKey: record.providerKey as ProviderPortalApprovalDescriptor["providerKey"],
    accountMode: record.accountMode,
    allowedOrigins: [...allowedOrigins] as string[],
    intendedAction: "quote_only",
    artifactScope: [...artifactScope] as ProviderPortalApprovalDescriptor["artifactScope"],
    cadPath: record.cadPath,
    drawingPath: record.drawingPath as string | null,
    requestedQuantities: [...record.requestedQuantities] as number[],
    cadFileSha256: record.cadFileSha256,
    drawingFileSha256: record.drawingFileSha256,
  };
}

/** Reads one non-symlink approval file and verifies its exact bytes before parsing. */
export async function readProviderPortalApprovalFile(
  filePath: string,
  expectedSha256: string,
): Promise<ProviderPortalApprovalDescriptor | null> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    return null;
  }
  const bytes = await readOpenedRegularFile(filePath);
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    return null;
  }
  try {
    return parseProviderPortalApprovalDescriptor(JSON.parse(bytes.toString("utf8")));
  } catch {
    return null;
  }
}

/** Resolves session bytes into a per-attempt object; paths are never handed to the browser. */
export async function resolveIsolatedProviderStorageState(
  definition: ProviderPortalDefinition,
  config: Pick<WorkerConfig, "vendorStorageStateJson" | "vendorStorageStatePaths" | "vendorStorageStateDir">,
): Promise<Exclude<BrowserContextOptions["storageState"], string | undefined> | null> {
  const jsonState = config.vendorStorageStateJson?.[definition.provider];
  if (jsonState) {
    try {
      return parseStorageState(JSON.parse(jsonState), definition.allowedHosts);
    } catch {
      return null;
    }
  }

  const explicitPath = config.vendorStorageStatePaths?.[definition.provider];
  const defaultPath = config.vendorStorageStateDir
    ? path.join(config.vendorStorageStateDir, `${definition.provider}-storage-state.json`)
    : null;
  const storagePath = explicitPath ?? defaultPath;
  if (!storagePath) {
    return null;
  }

  try {
    const serialized = await readOpenedRegularFile(storagePath);
    if (!serialized) {
      return null;
    }
    return parseStorageState(JSON.parse(serialized.toString("utf8")), definition.allowedHosts);
  } catch {
    return null;
  }
}

function extensionOf(fileName: string): string {
  return path.extname(fileName).slice(1).toLowerCase();
}

function exactAuthorizedFiles(
  definition: ProviderPortalDefinition,
  input: VendorQuoteAdapterInput,
): LiveEvaluationUploadFiles {
  const files = getAuthorizedLiveEvaluationFiles(input);
  if (input.executionContext !== "live_evaluation" || !files) {
    throw terminalError(
      definition,
      "unsupported",
      "exact_file_authorization_missing",
      { providerInteractionAttempted: false },
    );
  }
  return files;
}

/**
 * Production counterpart of `exactAuthorizedFiles`: re-checks the handed-over
 * generic dispatch authorization, then captures the staged CAD bytes into
 * memory and requires them to hash to the authorized disclosure, so later
 * browser waits cannot swap the uploaded file.
 */
async function productionDispatchFiles(
  definition: ProviderPortalDefinition,
  input: VendorQuoteAdapterInput,
): Promise<LiveEvaluationUploadFiles> {
  const reviewed = definition.productionDispatch;
  if (!reviewed) {
    throw terminalError(
      definition,
      "unsupported",
      "exact_file_authorization_missing",
      { providerInteractionAttempted: false },
    );
  }
  const denial = providerDispatchAuthorizationDenial(input, {
    provider: definition.provider,
    id: reviewed.envelope.id,
    version: reviewed.envelope.version,
  });
  if (denial) {
    throw terminalError(definition, "unsupported", denial, { providerInteractionAttempted: false });
  }
  const staged = input.stagedCadFile;
  const bytes = staged ? await readOpenedRegularFile(staged.localPath) : null;
  if (
    !staged
    || !bytes
    || createHash("sha256").update(bytes).digest("hex") !== staged.trustedContentSha256
  ) {
    throw terminalError(
      definition,
      "unsupported",
      "dispatch_authorization_file_mismatch",
      { providerInteractionAttempted: false },
    );
  }
  return {
    cad: { name: staged.originalName, mimeType: "application/octet-stream", buffer: bytes },
    drawing: null,
  };
}

/** Derives the complete action tuple that an operator must approve verbatim. */
export function buildExpectedProviderPortalApproval(
  definition: ProviderPortalDefinition,
  input: VendorQuoteAdapterInput,
): ProviderPortalApprovalDescriptor | null {
  const authorization = input.liveEvaluationAuthorization;
  const executionScope = input.providerPortalExecutionScope;
  if (
    !authorization
    || !executionScope
    || !path.isAbsolute(executionScope.cadPath)
    || path.resolve(executionScope.cadPath) !== executionScope.cadPath
    || !(executionScope.drawingPath === null
      || path.isAbsolute(executionScope.drawingPath)
        && path.resolve(executionScope.drawingPath) === executionScope.drawingPath)
    || executionScope.requestedQuantities.length === 0
    || executionScope.requestedQuantities.some((quantity) =>
      !Number.isSafeInteger(quantity) || quantity < 1)
    || !executionScope.requestedQuantities.includes(input.requestedQuantity)
  ) {
    return null;
  }
  const artifactScope: ProviderPortalApprovalDescriptor["artifactScope"] = ["cad_upload"];
  if (authorization.drawingFileSha256 !== null) {
    artifactScope.push("drawing_upload");
  }
  artifactScope.push("scrubbed_local_evidence");
  return {
    schemaVersion: "provider-portal-approval.v1",
    providerKey: definition.provider,
    accountMode: definition.accountMode,
    allowedOrigins: definition.allowedHosts
      .map((host) => `https://${host.toLowerCase()}`)
      .sort(alphabeticalCompare),
    intendedAction: "quote_only",
    artifactScope,
    cadPath: executionScope.cadPath,
    drawingPath: executionScope.drawingPath,
    requestedQuantities: [...executionScope.requestedQuantities],
    cadFileSha256: authorization.cadFileSha256,
    drawingFileSha256: authorization.drawingFileSha256,
  };
}

function assertExactProviderPortalApproval(
  definition: ProviderPortalDefinition,
  input: VendorQuoteAdapterInput,
): void {
  const expected = buildExpectedProviderPortalApproval(definition, input);
  const approved = input.providerPortalApproval;
  const approvedKeys = approved && typeof approved === "object"
    ? Object.keys(approved).sort(alphabeticalCompare)
    : [];
  if (
    !expected
    || !approved
    || !Array.isArray(approved.allowedOrigins)
    || !Array.isArray(approved.artifactScope)
    || !Array.isArray(approved.requestedQuantities)
    || JSON.stringify(approvedKeys) !== JSON.stringify([...APPROVAL_KEYS].sort(alphabeticalCompare))
    || approved.schemaVersion !== expected.schemaVersion
    || approved.providerKey !== expected.providerKey
    || approved.accountMode !== expected.accountMode
    || approved.intendedAction !== expected.intendedAction
    || approved.cadPath !== expected.cadPath
    || approved.drawingPath !== expected.drawingPath
    || JSON.stringify(approved.requestedQuantities) !== JSON.stringify(expected.requestedQuantities)
    || approved.cadFileSha256 !== expected.cadFileSha256
    || approved.drawingFileSha256 !== expected.drawingFileSha256
    || JSON.stringify([...approved.allowedOrigins].sort(alphabeticalCompare))
      !== JSON.stringify(expected.allowedOrigins)
    || JSON.stringify(approved.artifactScope) !== JSON.stringify(expected.artifactScope)
  ) {
    throw terminalError(
      definition,
      "unsupported",
      "exact_provider_approval_mismatch",
      { providerInteractionAttempted: false },
    );
  }
}

function assertEnvelopeFileShape(
  definition: ProviderPortalDefinition,
  input: VendorQuoteAdapterInput,
): void {
  const cadName = input.stagedCadFile?.originalName ?? input.cadFile?.original_name ?? "";
  if (!definition.supportedFileExtensions.includes(extensionOf(cadName))) {
    throw terminalError(
      definition,
      "unsupported",
      "cad_file_type_outside_envelope",
      { providerInteractionAttempted: false },
    );
  }
  if ((input.stagedDrawingFile || input.drawingFile) && !definition.selectors.drawingUpload) {
    throw terminalError(
      definition,
      "unsupported",
      "drawing_upload_outside_adapter_contract",
      { providerInteractionAttempted: false },
    );
  }
}

/** Conservative terminal-state classifier used by declarative portal definitions. */
export function classifyProviderPortalSnapshot(
  snapshot: ProviderPortalSnapshot,
  signals: ProviderPortalDefinition["terminalSignals"] = DEFAULT_TERMINAL_SIGNALS,
): ProviderPortalState {
  const combined = `${snapshot.url}\n${snapshot.bodyText}`;
  if (signals.captcha.some((pattern) => pattern.test(combined))) {
    return "captcha";
  }
  if (
    signals.login.some((pattern) => pattern.test(snapshot.url))
    || (snapshot.passwordInputCount > 0 && signals.login.some((pattern) => pattern.test(combined)))
  ) {
    return "login_required";
  }
  if (signals.unavailable.some((pattern) => pattern.test(combined))) {
    return "unavailable";
  }
  if (signals.manualReview.some((pattern) => pattern.test(snapshot.bodyText))) {
    return "manual_review";
  }
  if (signals.configurationRequired.some((pattern) => pattern.test(snapshot.bodyText))) {
    return "configuration_required";
  }
  return "ready";
}

function sanitizeArtifactRefs(artifacts: readonly VendorArtifact[]): string[] {
  return artifacts.map((artifact) => path.basename(artifact.localPath));
}

/** Accepts only selector-anchored, complete, unique provider options. */
export function normalizeAnchoredProviderOffers(
  candidates: readonly ProviderPortalOfferCandidate[],
  options: {
    expectedQuantity: number;
    allowedHosts: readonly string[];
    artifacts?: readonly VendorArtifact[];
  },
): ProviderPortalNormalizedOffer[] {
  const normalized: ProviderPortalNormalizedOffer[] = [];
  const providerIds = new Set<string>();
  const artifactRefs = sanitizeArtifactRefs(options.artifacts ?? []);

  for (const candidate of candidates) {
    if ("money" in candidate) {
      continue;
    }
    const id = candidate.providerOptionId?.trim() ?? "";
    const label = candidate.providerLabel?.trim() ?? "";
    const containerSelector = candidate.containerSelector?.trim() ?? "";
    const priceGate = gateVendorPrice(candidate.totalPriceUsd);
    const unitPriceGate = gateVendorPrice(candidate.unitPriceUsd);
    if (
      !id
      || !label
      || !containerSelector
      || !candidate.providerOptionIdSource
      || providerIds.has(id)
      || !Number.isSafeInteger(candidate.quantity)
      || candidate.quantity !== options.expectedQuantity
      || (candidate.quoteUrl !== null
        && !isAllowedProviderUrl(candidate.quoteUrl, options.allowedHosts))
      || !priceGate.trusted
      || !unitPriceGate.trusted
      || candidate.totalPriceUsd.value === null
      || candidate.unitPriceUsd.value === null
      || candidate.totalPriceUsd.value <= 0
      || candidate.unitPriceUsd.value <= 0
    ) {
      continue;
    }

    providerIds.add(id);
    normalized.push({
      providerOptionId: id,
      providerLabel: label,
      quoteRef: candidate.quoteRef,
      quoteUrl: candidate.quoteUrl,
      quantity: candidate.quantity,
      unitPriceUsd: candidate.unitPriceUsd.value,
      totalPriceUsd: candidate.totalPriceUsd.value,
      leadTimeBusinessDays: gateLeadTime(candidate.leadTimeBusinessDays, priceGate),
      shipReceiveBy: candidate.shipReceiveBy,
      tier: candidate.tier,
      sourcing: candidate.sourcing,
      geographicOrigin: candidate.geographicOrigin ?? "unknown",
      sortRank: normalized.length,
      provenance: {
        containerSelector,
        providerOptionIdSource: candidate.providerOptionIdSource,
        priceSource: "selector",
        leadTimeSource: candidate.leadTimeBusinessDays.source,
        geographicOriginSource: candidate.geographicOriginSource,
      },
      validUntil: candidate.validUntil,
      validityDurationDays: candidate.validityDurationDays,
      validitySource: candidate.validitySource,
      validityTerms: candidate.validityTerms,
      artifactRefs: [...artifactRefs],
      rawPayload: {
        normalizationRevision: "provider-offer-evidence.v1",
        anchoredFields: ["provider_option_id", "unit_price", "total_price"],
        leadTimeAnchored: candidate.leadTimeBusinessDays.source === "selector",
        geographicOriginKnown: candidate.geographicOrigin !== null,
        validityKnown: candidate.validitySource !== null,
      },
    });
  }

  return normalized;
}

/** All-or-nothing native batch: never infer currency, convert money or mix lanes. */
export function normalizeAnchoredNativeOffers(
  candidates: readonly (ProviderPortalNativeOfferCandidate | ProviderPortalOfferCandidate)[],
  options: { expectedQuantity: number; allowedHosts: readonly string[]; artifacts?: readonly VendorArtifact[] },
): LocalNativeCurrencyOffer[] {
  const offers: LocalNativeCurrencyOffer[] = [];
  const ids = new Set<string>();
  const currencies = new Set<string>();
  for (const candidate of candidates) {
    if (!("money" in candidate) || "unitPriceUsd" in candidate || "totalPriceUsd" in candidate) {
      return [];
    }
    const { money } = candidate;
    if (!money || !isSelectorAnchored(money.unitCurrency) || !isSelectorAnchored(money.totalCurrency)
      || !isSupportedLocalCurrency(money.unitCurrency.value) || money.unitCurrency.value !== money.totalCurrency.value
      || !isSelectorAnchored(money.unitAmount) || !isSelectorAnchored(money.totalAmount)
      || !Number.isFinite(money.unitAmount.value) || money.unitAmount.value <= 0
      || !Number.isFinite(money.totalAmount.value) || money.totalAmount.value <= 0
      || !candidate.providerOptionId?.trim() || ids.has(candidate.providerOptionId.trim())
      || !candidate.providerLabel?.trim() || !candidate.containerSelector?.trim()
      || !["attribute", "provider_label"].includes(candidate.providerOptionIdSource ?? "")
      || !Number.isSafeInteger(candidate.quantity) || candidate.quantity < 1 || candidate.quantity !== options.expectedQuantity
      || (candidate.quoteUrl !== null && !isAllowedProviderUrl(candidate.quoteUrl, options.allowedHosts))) {
      return [];
    }
    ids.add(candidate.providerOptionId.trim());
    currencies.add(money.unitCurrency.value);
    if (currencies.size > 1) {
      return [];
    }
    const anchor = (value: { source: "selector"; selector: string }) => ({ source: value.source, selector: value.selector });
    const lead = candidate.leadTimeBusinessDays;
    const offer = parseLocalNativeCurrencyOffer({
      providerOptionId: candidate.providerOptionId.trim(),
      providerLabel: candidate.providerLabel.trim(),
      quantity: candidate.quantity,
      money: {
        currency: money.unitCurrency.value, unitAmount: money.unitAmount.value, totalAmount: money.totalAmount.value,
        provenance: {
          unitAmount: anchor(money.unitAmount), totalAmount: anchor(money.totalAmount),
          unitCurrency: anchor(money.unitCurrency), totalCurrency: anchor(money.totalCurrency),
        },
      },
      leadTimeBusinessDays: isSelectorAnchored(lead) ? lead.value : null,
      shipReceiveBy: candidate.shipReceiveBy,
      tier: candidate.tier,
      sourcing: candidate.sourcing,
      geographicOrigin: candidate.geographicOrigin ?? "unknown",
      provenance: {
        containerSelector: candidate.containerSelector.trim(),
        providerOptionIdSource: candidate.providerOptionIdSource as "attribute" | "provider_label",
        leadTimeSource: lead.source,
        geographicOriginSource: candidate.geographicOriginSource,
      },
      validUntil: candidate.validUntil,
      validityDurationDays: candidate.validityDurationDays,
      validitySource: candidate.validitySource,
      validityTerms: candidate.validityTerms,
      artifactRefs: sanitizeArtifactRefs(options.artifacts ?? []),
    });
    if (!offer) {
      return [];
    }
    offers.push(offer);
  }
  return offers;
}

export { scrubProviderEvidenceText } from "./providerEvidenceRedaction.js";

function safeEvidenceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}/`;
  } catch {
    return "invalid-url";
  }
}

/** Stores only bounded metadata. Image capture remains disabled until deterministic masking exists. */
export async function captureScrubbedProviderEvidence(
  definition: ProviderPortalDefinition,
  config: WorkerConfig,
  state: ProviderPortalTerminalState | "offers_extracted",
  snapshot: ProviderPortalSnapshot,
  portalBoundary?: PortalBoundaryTelemetry,
): Promise<VendorArtifact[]> {
  const baseDir = path.join(config.workerTempDir, "provider-portal-evidence", definition.provider);
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
  const evidenceDir = await fs.mkdtemp(path.join(baseDir, `${state}-`));
  await fs.chmod(evidenceDir, 0o700);
  const jsonPath = path.join(evidenceDir, "portal-state.json");
  await fs.writeFile(jsonPath, JSON.stringify({
    schemaVersion: "provider-portal-evidence.v1",
    provider: definition.provider,
    kernelRevision: PROVIDER_PORTAL_KERNEL_REVISION,
    adapterRevision: definition.adapterRevision,
    terminalState: state,
    capturedAt: new Date().toISOString(),
    url: safeEvidenceUrl(snapshot.url),
    textSummary: {
      present: snapshot.bodyText.length > 0,
      length: snapshot.bodyText.length,
    },
    ...(portalBoundary ? {
      portalBoundary: {
        blockedOffhostCount: portalBoundary.blockedOffhostCount,
        blockedOffhostByHost: portalBoundary.blockedOffhostByHost,
      },
    } : {}),
  }, null, 2), { encoding: "utf8", mode: 0o600 });

  return [{
    kind: "json",
    label: `${definition.displayName} scrubbed portal state`,
    localPath: jsonPath,
    contentType: "application/json",
  }];
}

async function snapshotPortal(page: Page): Promise<ProviderPortalSnapshot> {
  return {
    url: page.url(),
    bodyText: await page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""),
    passwordInputCount: await page.locator("input[type='password']").count().catch(() => 0),
  };
}

function assertCurrentOrigin(
  definition: ProviderPortalDefinition,
  page: Page,
  providerMutationPossible: boolean,
): void {
  if (!isAllowedProviderUrl(page.url(), definition.allowedHosts)) {
    throw terminalError(
      definition,
      "unexpected_origin",
      "unexpected_origin",
      {
        providerMutationPossible,
        observedHost: (() => {
          try {
            return new URL(page.url()).hostname;
          } catch {
            return "invalid_url";
          }
        })(),
      },
    );
  }
}

/**
 * OVD-773: what the boundary quietly blocked. Host and resource type only,
 * never a full URL or query string, so the evidence cannot carry page data.
 */
export type PortalBoundaryTelemetry = {
  blockedOffhostCount: number;
  blockedOffhostByHost: Record<string, number>;
  blockedOffhostEvents: Array<{ event: "boundary.blocked_offhost"; host: string; resourceType: string }>;
};

const MAX_BLOCKED_OFFHOST_EVENTS = 50;

type PortalBoundaryState = {
  providerMutationPossible: boolean;
  violation: string | null;
  telemetry?: PortalBoundaryTelemetry;
  recover?: ReturnType<typeof createBrowserRecovery>;
  observeRecovery?: ReturnType<typeof captureFreshOperationalRecovery>;
};

function emptyBoundaryTelemetry(): PortalBoundaryTelemetry {
  return { blockedOffhostCount: 0, blockedOffhostByHost: {}, blockedOffhostEvents: [] };
}

/** Detached copy for results and error payloads; later route callbacks cannot change it. */
function snapshotBoundaryTelemetry(telemetry: PortalBoundaryTelemetry | undefined): PortalBoundaryTelemetry {
  const source = telemetry ?? emptyBoundaryTelemetry();
  return {
    blockedOffhostCount: source.blockedOffhostCount,
    blockedOffhostByHost: { ...source.blockedOffhostByHost },
    blockedOffhostEvents: source.blockedOffhostEvents.map((event) => ({ ...event })),
  };
}

function recordBlockedOffhost(boundary: PortalBoundaryState, host: string, resourceType: string): void {
  const telemetry = boundary.telemetry ??= emptyBoundaryTelemetry();
  telemetry.blockedOffhostCount += 1;
  telemetry.blockedOffhostByHost[host] = (telemetry.blockedOffhostByHost[host] ?? 0) + 1;
  if (telemetry.blockedOffhostEvents.length < MAX_BLOCKED_OFFHOST_EVENTS) {
    telemetry.blockedOffhostEvents.push({ event: "boundary.blocked_offhost", host, resourceType });
  }
}

/** Marks both the portal boundary and the task-wide retry phase before a provider mutation. */
function enterProviderMutation(boundary: PortalBoundaryState): void {
  boundary.providerMutationPossible = true;
  markProviderMutationStarted();
}

/**
 * OVD-826: the first boundary violation is the one that explains the stop. A
 * blocked off-host navigation commits Chromium's error page next, and that
 * later `chrome-error://` navigation must not overwrite the real host.
 */
function recordBoundaryViolation(boundary: PortalBoundaryState, violation: string): void {
  boundary.violation ??= violation;
}

function safeObservedHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "invalid_url";
  }
}

function assertPortalBoundary(
  definition: ProviderPortalDefinition,
  page: Page,
  boundary: PortalBoundaryState,
): void {
  if (boundary.violation) {
    throw terminalError(
      definition,
      "unexpected_origin",
      boundary.violation,
      { providerMutationPossible: boundary.providerMutationPossible },
    );
  }
  assertCurrentOrigin(definition, page, boundary.providerMutationPossible);
}

/**
 * Report bodies the browser itself generates (CSP `report-uri` and the
 * Reporting API). Only these may carry a body to a quietly blocked host; the
 * size cap keeps a file from hiding behind the content type.
 */
const PAGE_BEACON_CONTENT_TYPES = new Set(["application/csp-report", "application/reports+json"]);
const MAX_PAGE_BEACON_BYTES = 64 * 1024;
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie"] as const;

type OffHostDisposition = "unexpected_navigation" | "unexpected_request" | "subresource";

function isPageBeacon(contentType: string | undefined, bodyBytes: number): boolean {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return PAGE_BEACON_CONTENT_TYPES.has(mediaType) && bodyBytes <= MAX_PAGE_BEACON_BYTES;
}

/**
 * OVD-773: an off-host request is a boundary violation when it could carry
 * something of ours: a top-level navigation away from the provider, a
 * credential header, or any request body that is not a browser-generated
 * report. Every other off-host request (fonts, CDN scripts, images, analytics
 * GETs, CSP reports) is a page subresource and is blocked without failing the
 * run. Anything that cannot be classified fails closed as a violation.
 */
async function classifyOffHostRequest(request: Request): Promise<OffHostDisposition> {
  try {
    if (request.isNavigationRequest() && request.frame().parentFrame() === null) {
      return "unexpected_navigation";
    }
    const headers = await request.allHeaders();
    if (CREDENTIAL_HEADERS.some((name) => Object.hasOwn(headers, name))) {
      return "unexpected_request";
    }
    const body = request.postDataBuffer();
    if (body && body.length > 0 && !isPageBeacon(headers["content-type"], body.length)) {
      return "unexpected_request";
    }
    return "subresource";
  } catch {
    return "unexpected_request";
  }
}

/** Fails closed: a request whose body cannot be read is treated as carrying one. */
function carriesRequestBody(request: Request): boolean {
  try {
    const body = request.postDataBuffer();
    return Boolean(body && body.length > 0);
  } catch {
    return true;
  }
}

function safeResourceType(request: Request): string {
  try {
    return request.resourceType();
  } catch {
    return "unknown";
  }
}

async function installPortalBoundaryGuards(
  definition: ProviderPortalDefinition,
  context: BrowserContext,
  page: Page,
  boundary: PortalBoundaryState,
): Promise<void> {
  const offHostAllowlist = effectiveOffHostAllowlist(definition);
  await context.route("**/*", async (route) => {
    const request = route.request();
    const requestUrl = request.url();
    if (isAllowedProviderUrl(requestUrl, definition.allowedHosts)) {
      await route.continue();
      return;
    }
    const host = safeObservedHost(requestUrl);
    const disposition = await classifyOffHostRequest(request);
    if (disposition !== "subresource") {
      recordBoundaryViolation(boundary, `${disposition}:${host}`);
      await route.abort("blockedbyclient");
      return;
    }
    // The allowlist only admits body-less subresources; a report beacon to an
    // allowlisted host is still blocked so no body ever leaves the provider.
    if (isAllowedProviderUrl(requestUrl, offHostAllowlist) && !carriesRequestBody(request)) {
      await route.continue();
      return;
    }
    recordBlockedOffhost(boundary, host, safeResourceType(request));
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", async (webSocketRoute) => {
    const socketUrl = webSocketRoute.url();
    if (!isAllowedProviderWebSocketUrl(socketUrl, definition.allowedHosts)) {
      recordBoundaryViolation(boundary, `unexpected_websocket:${safeObservedHost(socketUrl)}`);
      await webSocketRoute.close({ code: 1008, reason: "unexpected_origin" });
      return;
    }
    webSocketRoute.connectToServer();
  });
  const unexpectedPages = new WeakSet<Page>();
  const rejectUnexpectedPage = (unexpectedPage: Page) => {
    if (unexpectedPage === page || unexpectedPages.has(unexpectedPage)) {
      return;
    }
    unexpectedPages.add(unexpectedPage);
    recordBoundaryViolation(boundary, `unexpected_page:${safeObservedHost(unexpectedPage.url())}`);
    void unexpectedPage.close().catch(() => undefined);
  };
  context.on("page", rejectUnexpectedPage);
  page.on("popup", rejectUnexpectedPage);
  page.on("framenavigated", (frame) => {
    if (
      frame === page.mainFrame()
      && frame.url() !== "about:blank"
      && !isAllowedProviderUrl(frame.url(), definition.allowedHosts)
    ) {
      recordBoundaryViolation(boundary, `unexpected_navigation:${safeObservedHost(frame.url())}`);
    }
  });
}

function guardedLocator(
  definition: ProviderPortalDefinition,
  page: Page,
  boundary: PortalBoundaryState,
  selector: string,
): Locator {
  assertPortalBoundary(definition, page, boundary);
  return page.locator(selector);
}

function buildReadCapability(
  definition: ProviderPortalDefinition,
  page: Page,
  boundary: PortalBoundaryState,
): ProviderPortalReadCapability {
  const afterRead = <T>(value: T): T => {
    assertPortalBoundary(definition, page, boundary);
    return value;
  };
  return Object.freeze({
    count: async (selector: string) => afterRead(
      await guardedLocator(definition, page, boundary, selector).count(),
    ),
    readText: async (selector: string) => afterRead(
      await guardedLocator(definition, page, boundary, selector)
        .first()
        .innerText({ timeout: 5_000 })
        .catch(() => null),
    ),
    readTexts: async (selector: string) => afterRead(
      await guardedLocator(definition, page, boundary, selector)
        .allInnerTexts()
        .catch(() => []),
    ),
    readAttribute: async (selector: string, attribute: string) => {
      if (!/^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(attribute)) {
        throw terminalError(definition, "selector_drift", "invalid_read_attribute", {
          providerMutationPossible: boundary.providerMutationPossible,
        });
      }
      return afterRead(await guardedLocator(definition, page, boundary, selector)
        .first()
        .getAttribute(attribute)
        .catch(() => null));
    },
  });
}

function buildConfigurationCapability(
  definition: ProviderPortalDefinition,
  page: Page,
  boundary: PortalBoundaryState,
  killSwitchCheckpoint?: VendorQuoteAdapterInput["providerKillSwitchCheckpoint"],
): ProviderPortalConfigurationCapability {
  const perform = async (
    operation: "fill" | "select",
    field: string,
    value: string,
  ): Promise<boolean> => {
    const rule = definition.selectors.configuration?.[field];
    if (rule?.operation !== operation) {
      throw terminalError(definition, "configuration_required", "undeclared_configuration_operation", {
        providerMutationPossible: boundary.providerMutationPossible,
      });
    }
    const locator = guardedLocator(definition, page, boundary, rule.selector).first();
    if (await locator.count() < 1) {
      if (!boundary.recover) {
        await observeMissingConfiguration(definition, page, boundary, field, operation, value);
        return false;
      }
      await killSwitchCheckpoint?.("before_configure");
      return recoverMissingConfiguration(definition, page, boundary, field, operation, value);
    }
    // OVD-722: fresh read immediately before each configuration mutation.
    await killSwitchCheckpoint?.("before_configure");
    enterProviderMutation(boundary);
    if (operation === "fill") {
      await locator.fill(value);
    } else {
      await locator.selectOption(value);
    }
    assertPortalBoundary(definition, page, boundary);
    return true;
  };
  const click = async (field: string, text?: string): Promise<boolean> => {
    const rule = definition.selectors.configuration?.[field];
    if (rule?.operation !== "click" || (text !== undefined && PROHIBITED_CONFIGURATION_SELECTOR.test(text))) {
      throw terminalError(definition, "configuration_required", "undeclared_configuration_operation", {
        providerMutationPossible: boundary.providerMutationPossible,
      });
    }
    const matches = guardedLocator(definition, page, boundary, rule.selector);
    const locator = (text === undefined ? matches : matches.filter({ hasText: exactTextPattern(text) })).first();
    if (await locator.count() < 1) {
      assertPortalBoundary(definition, page, boundary);
      return false;
    }
    // OVD-722: fresh read immediately before each configuration mutation.
    await killSwitchCheckpoint?.("before_configure");
    enterProviderMutation(boundary);
    await locator.click();
    assertPortalBoundary(definition, page, boundary);
    return true;
  };
  return Object.freeze({
    fill: (field: string, value: string) => perform("fill", field, value),
    select: (field: string, value: string) => perform("select", field, value),
    click,
  });
}

function exactTextPattern(text: string): RegExp {
  const escaped = text.trim().replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(String.raw`^\s*${escaped}\s*$`);
}

async function observeMissingConfiguration(
  definition: ProviderPortalDefinition, page: Page, boundary: PortalBoundaryState,
  field: string, operation: "fill" | "select", value: string,
): Promise<void> {
  await boundary.observeRecovery?.({ page, field, operation, value,
    assertBoundary: () => assertPortalBoundary(definition, page, boundary),
    assertReady: async () => {
      const state = await definition.hooks.classifyPortalState(await snapshotPortal(page));
      if (state !== "ready") throw terminalError(definition, state, "recovery_portal_not_ready");
    },
    beforeMutation: () => { throw new Error("shadow_mutation_prohibited"); },
  });
}

async function recoverMissingConfiguration(
  definition: ProviderPortalDefinition, page: Page, boundary: PortalBoundaryState,
  field: string, operation: "fill" | "select", value: string,
): Promise<boolean> {
  const recovered = await boundary.recover?.({
    page, field, operation, value,
    assertBoundary: () => assertPortalBoundary(definition, page, boundary),
    assertReady: async () => {
      const state = await definition.hooks.classifyPortalState(await snapshotPortal(page));
      if (state !== "ready") throw terminalError(definition, state, "recovery_portal_not_ready");
    },
    beforeMutation: () => { enterProviderMutation(boundary); },
  });
  assertPortalBoundary(definition, page, boundary);
  if (!recovered) throw terminalError(definition, "selector_drift", "bounded_recovery_stopped", {
    providerMutationPossible: boundary.providerMutationPossible,
  });
  return true;
}

function buildCleanupCapability(
  definition: ProviderPortalDefinition,
  page: Page,
  boundary: PortalBoundaryState,
  beforeMutation: () => Promise<void>,
  confirmation: CleanupRowConfirmation,
  uploadedRows?: UploadedPortalRows,
): ProviderPortalCleanupCapability {
  const locate = async (field: string, scopeText?: string) => {
    const rule = definition.selectors.cleanup?.[field];
    if (!rule || (scopeText !== undefined && PROHIBITED_CLEANUP_SELECTOR.test(scopeText))) {
      throw terminalError(definition, "configuration_required", "undeclared_cleanup_operation", {
        providerMutationPossible: boundary.providerMutationPossible,
      });
    }
    if (rule.uploadedRows) {
      if (!uploadedRows) throw new Error("CleanupRowSnapshotMissing");
      assertPortalBoundary(definition, page, boundary);
      return uploadedRows.targets(rule.scope ? rule.selector : undefined, rule.reportOnly);
    }
    if (!rule.scope) {
      const locator = guardedLocator(definition, page, boundary, rule.selector);
      return scopeText === undefined ? locator : locator.filter({ hasText: scopeText });
    }
    const scopes = guardedLocator(definition, page, boundary, rule.scope);
    const scoped = scopeText === undefined ? scopes : scopes.filter({ hasText: scopeText });
    return scoped.locator(rule.selector);
  };
  return Object.freeze({
    count: async (field: string, scopeText?: string) => {
      const targets = await locate(field, scopeText);
      const count = Array.isArray(targets) ? targets.length : await targets.count();
      assertPortalBoundary(definition, page, boundary);
      return count;
    },
    click: async (field: string, scopeText?: string) => {
      if (definition.selectors.cleanup?.[field]?.reportOnly) throw new Error("CleanupReportOnly");
      // Validate the declared operation even when it has no row binding.
      await locate(field, scopeText);
      await beforeMutation();
      const rule = definition.selectors.cleanup![field];
      if (!rule.uploadedRows && !rule.scope) throw new CleanupConfirmationUnproven();
      const scopes = rule.scope ? guardedLocator(definition, page, boundary, rule.scope) : undefined;
      const rows = rule.uploadedRows
        ? await uploadedRows!.targets()
        : await (scopeText === undefined ? scopes! : scopes!.filter({ hasText: scopeText })).elementHandles();
      if (rows.length === 0) return false;
      if (rows.length !== 1) throw new CleanupConfirmationUnproven();
      const row = rows[0];
      // Scope text locates a row; only the pre-upload snapshot proves ownership.
      if (!uploadedRows) throw new CleanupConfirmationUnproven();
      const owned = await uploadedRows.targets();
      if (!await row.evaluate((element, rows) => rows.includes(element), owned)) {
        throw new CleanupConfirmationUnproven();
      }
      await confirmation.bind(row);
      const targets = rule.uploadedRows && !rule.scope ? [row] : await row.$$(rule.selector);
      if (targets.length === 0) return false;
      if (targets.length !== 1) throw new CleanupConfirmationUnproven();
      assertPortalBoundary(definition, page, boundary);
      await confirmation.click(row, targets[0]);
      assertPortalBoundary(definition, page, boundary);
      return true;
    },
  });
}

function cleanupFailureReason(error: unknown): string {
  if (error instanceof VendorAutomationError && typeof error.payload.reason === "string") return error.payload.reason;
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Runs the definition's cleanup hook after an attempt that reached upload.
 * Never throws; the structured log line is the operator's record either way.
 */
async function cleanUpProviderPortal(
  definition: ProviderPortalDefinition,
  input: VendorQuoteAdapterInput,
  session: OpenProviderPortalSession,
  timeoutMs: number = PROVIDER_PORTAL_CLEANUP_TIMEOUT_MS,
): Promise<ProviderPortalCleanupReport | undefined> {
  const hook = definition.hooks.cleanup;
  if (!hook || !session.boundary.providerMutationPossible) return undefined;
  let report: ProviderPortalCleanupReport;
  let stopped = false;
  const beforeMutation = async () => {
    if (stopped) throw new Error("CleanupStopped");
    await input.providerKillSwitchCheckpoint?.("before_configure");
    if (stopped) throw new Error("CleanupStopped");
  };
  let rejectDialog: (error: unknown) => void = () => undefined;
  const dialogFailure = new Promise<never>((_, reject) => { rejectDialog = reject; });
  let confirmation: CleanupRowConfirmation;
  // Native confirmation is a separate mutation, just like an in-page button.
  const acceptDialog = async (dialog: { type: () => string; message: () => string; accept: () => Promise<void>; dismiss: () => Promise<void> }) => {
    try {
      await beforeMutation();
      confirmation.assertNativeDialog(dialog.type(), dialog.message());
      assertPortalBoundary(definition, session.page, session.boundary);
      await dialog.accept();
    } catch (error) {
      stopped = true;
      await dialog.dismiss().catch(() => undefined);
      rejectDialog(error);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // OVD-722: an engaged kill switch stops every provider interaction, cleanup included.
    await input.providerKillSwitchCheckpoint?.("before_configure");
  } catch (error) {
    report = { status: "skipped_kill_switch", removed: 0, remaining: null, reason: cleanupFailureReason(error) };
    logProviderPortalCleanup(definition, input, report);
    return report;
  }
  try {
    confirmation = new CleanupRowConfirmation(
      definition.selectors.cleanupRowFileName,
      definition.selectors.cleanupRow,
      definition.selectors.cleanupRow
        ? guardedLocator(definition, session.page, session.boundary, definition.selectors.cleanupRow) : undefined,
      session.cleanupRows?.stagedFileName,
      () => verifyCleanupShadowVisibility(session.context, session.page),
      session.page,
      session.cleanupRows?.preUploadRows,
    );
    // A report-only hook must never accept an unrelated native confirmation.
    const cleanupRules = Object.values(definition.selectors.cleanup ?? {});
    if (cleanupRules.length === 0 || cleanupRules.some((rule) => !rule.reportOnly)) {
      session.page.on("dialog", acceptDialog);
    }
    const outcome = await Promise.race([
      (async () => {
        const outcome = await hook(buildCleanupCapability(definition, session.page, session.boundary, beforeMutation, confirmation, session.cleanupRows), input);
        const removed = await confirmation.verifiedRemoved();
        if (outcome.removed > removed) throw new CleanupConfirmationUnproven();
        return removed > 0 ? { ...outcome, removed } : outcome;
      })(),
      dialogFailure,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("CleanupTimeout")), timeoutMs);
      }),
    ]);
    const removed = Number.isSafeInteger(outcome.removed) && outcome.removed > 0 ? outcome.removed : 0;
    const remaining = Number.isSafeInteger(outcome.remaining) && outcome.remaining >= 0 ? outcome.remaining : null;
    let status: ProviderPortalCleanupReport["status"] = "incomplete";
    if (remaining === 0) status = removed > 0 ? "removed" : "not_found";
    report = { status, removed, remaining, reason: null };
  } catch (error) {
    report = error instanceof CleanupConfirmationUnproven
      ? { status: "incomplete", removed: 0, remaining: null, reason: "manual_cleanup_required",
        ...(error.lostPreUploadRows ? { lostPreUploadRows: error.lostPreUploadRows } : {}) }
      : error instanceof CleanupRowsUnproven
      ? { status: "incomplete", removed: 0, remaining: error.rows.length, reason: "manual_cleanup_required", manualCleanupRows: error.rows }
      : { status: error instanceof ProviderKillSwitchError ? "skipped_kill_switch" : "failed", removed: 0, remaining: null, reason: cleanupFailureReason(error) };
  } finally {
    stopped = true;
    clearTimeout(timer);
    session.page.off?.("dialog", acceptDialog);
  }
  logProviderPortalCleanup(definition, input, report);
  return report;
}

function logProviderPortalCleanup(
  definition: ProviderPortalDefinition,
  input: VendorQuoteAdapterInput,
  report: ProviderPortalCleanupReport,
): void {
  const line = JSON.stringify({
    level: report.status === "removed" ? "info" : "warn",
    source: "providerPortalCleanup",
    provider: definition.provider,
    quoteRunId: input.quoteRunId ?? null,
    executionContext: input.executionContext ?? "production_dispatch",
    ...report,
  });
  if (report.status === "removed") console.info(line);
  else console.warn(line);
}

function launchOptions(config: WorkerConfig): Parameters<typeof chromium.launch>[0] {
  return {
    headless: config.playwrightHeadless,
    timeout: config.browserTimeoutMs,
    ...chromiumSandboxLaunchOptions(config),
  };
}

/** Retries only a declared read/navigation step and never a possible mutation. */
export async function runIntentionalPortalRetry<T>(input: {
  operation: () => Promise<T>;
  maxAttempts: number;
  providerMutationPossible: boolean;
}): Promise<T> {
  const attempts = input.providerMutationPossible
    ? 1
    : Math.max(1, Math.min(input.maxAttempts, 2));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await input.operation();
    } catch (error) {
      // OVD-722: a kill-switch refusal is final; never retry past it. OVD-748: nor an abort.
      if (error instanceof ProviderKillSwitchError || error instanceof ProviderAbortedError) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function terminalResult(
  state: ProviderPortalTerminalState,
  reason: string,
  page: Page | null,
  artifacts: VendorArtifact[],
  providerMutationPossible: boolean,
): ProviderPortalKernelResult {
  return {
    state,
    reason,
    url: page?.url() ?? null,
    offers: [],
    artifacts,
    providerMutationPossible,
  };
}

type OpenProviderPortalSession = {
  cleanupRows?: UploadedPortalRows;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  boundary: PortalBoundaryState;
};

type ProviderPortalInteraction = {
  definition: ProviderPortalDefinition;
  config: WorkerConfig;
  input: VendorQuoteAdapterInput;
  files: LiveEvaluationUploadFiles;
  dependencies: RunProviderPortalKernelDependencies;
  session: OpenProviderPortalSession;
};

async function openProviderPortalSession(
  definition: ProviderPortalDefinition,
  config: WorkerConfig,
  storageState: Exclude<BrowserContextOptions["storageState"], string | undefined>,
  dependencies: RunProviderPortalKernelDependencies,
): Promise<OpenProviderPortalSession> {
  const launch = dependencies.launchBrowser ?? ((options) => chromium.launch(options));
  const browser = await launch(launchOptions(config));
  try {
    const { playwrightState, sessionStorage } = splitSessionStorage(storageState);
    const context = await browser.newContext({ storageState: playwrightState, serviceWorkers: "block" });
    await seedSessionStorage(context, sessionStorage);
    context.setDefaultTimeout(config.browserTimeoutMs);
    context.setDefaultNavigationTimeout(config.browserTimeoutMs);
    const page = await context.newPage();
    // Only a cleanup that can click needs shadow-root evidence; report-only rules never click, so their pages stay unpatched.
    const cleanupRules = Object.values(definition.selectors.cleanup ?? {});
    if (definition.hooks.cleanup && (cleanupRules.length === 0 || cleanupRules.some((rule) => !rule.reportOnly))) {
      await trackCleanupShadowRoots(page);
    }
    const boundary: PortalBoundaryState = {
      providerMutationPossible: false,
      violation: null,
      telemetry: emptyBoundaryTelemetry(),
      recover: dependencies.recovery?.enabled === true ? createBrowserRecovery(dependencies.recovery) : undefined,
      observeRecovery: dependencies.operationalJev
        ? captureFreshOperationalRecovery(dependencies.operationalJev, dependencies.operationalJev.scope) : undefined,
    };
    await installPortalBoundaryGuards(definition, context, page, boundary);
    return { browser, context, page, boundary };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

async function captureTerminalPortalState(
  interaction: ProviderPortalInteraction,
  state: ProviderPortalState,
  snapshot: ProviderPortalSnapshot,
): Promise<ProviderPortalKernelResult | null> {
  if (state === "ready") {
    return null;
  }
  const capture = interaction.dependencies.captureEvidence ?? captureScrubbedProviderEvidence;
  const artifacts = await capture(interaction.definition, interaction.config, state, snapshot,
    snapshotBoundaryTelemetry(interaction.session.boundary.telemetry));
  return terminalResult(
    state,
    state,
    interaction.session.page,
    artifacts,
    interaction.session.boundary.providerMutationPossible,
  );
}

async function uploadAuthorizedPortalFiles(
  interaction: ProviderPortalInteraction,
): Promise<ProviderPortalKernelResult | null> {
  const { definition, files, input, session } = interaction;
  await input.providerKillSwitchCheckpoint?.("before_upload");
  const cadInput = session.page.locator(definition.selectors.cadUpload).first();
  const cadInputCount = await cadInput.count();
  assertPortalBoundary(definition, session.page, session.boundary);
  if (cadInputCount < 1) {
    return terminalResult("selector_drift", "cad_upload_selector_missing", session.page, [], false);
  }
  if (definition.selectors.cleanupRow) {
    session.cleanupRows = await UploadedPortalRows.snapshot(
      guardedLocator(definition, session.page, session.boundary, definition.selectors.cleanupRow),
      guardedLocator(definition, session.page, session.boundary, "html"),
      files.cad.name,
      definition.selectors.cleanupRowFileName,
      session.page,
      definition.selectors.cleanupRow,
    );
  }
  // OVD-722: re-read after the awaited locator lookup so a switch engaged in
  // that window still stops the upload. A request already sent cannot be recalled.
  await input.providerKillSwitchCheckpoint?.("before_upload");
  // OVD-723: the export-control gate is asked again here, after navigation
  // and classification and right before the first byte reaches the provider.
  // A denial is rethrown unchanged by runProviderPortalKernel (never
  // translated into a portal failure) and the lane is held; nothing has been
  // uploaded.
  await input.beforeProviderDisclosure?.();
  await definition.hooks.beforeUpload?.(buildReadCapability(definition, session.page, session.boundary));
  assertPortalBoundary(definition, session.page, session.boundary);
  enterProviderMutation(session.boundary);
  await cadInput.setInputFiles(files.cad);
  assertPortalBoundary(definition, session.page, session.boundary);
  return uploadAuthorizedDrawing(interaction);
}

async function uploadAuthorizedDrawing(
  interaction: ProviderPortalInteraction,
): Promise<ProviderPortalKernelResult | null> {
  const { definition, files, input, session } = interaction;
  if (!files.drawing || !definition.selectors.drawingUpload) {
    return null;
  }
  const drawingInput = session.page.locator(definition.selectors.drawingUpload).first();
  const drawingInputCount = await drawingInput.count();
  assertPortalBoundary(definition, session.page, session.boundary);
  if (drawingInputCount < 1) {
    return terminalResult("selector_drift", "drawing_upload_selector_missing", session.page, [], true);
  }
  await input.providerKillSwitchCheckpoint?.("before_upload");
  // OVD-723: the drawing is a separate disclosure, so the export-control gate
  // is asked again right before it, as in Xometry's drawing fallback.
  await input.beforeProviderDisclosure?.();
  assertPortalBoundary(definition, session.page, session.boundary);
  await drawingInput.setInputFiles(files.drawing);
  assertPortalBoundary(definition, session.page, session.boundary);
  return null;
}

async function configureProviderPortalQuote(interaction: ProviderPortalInteraction): Promise<void> {
  const { definition, config, input, session } = interaction;
  await input.providerKillSwitchCheckpoint?.("before_configure");
  if (definition.selectors.quantity) {
    const quantityInput = session.page.locator(definition.selectors.quantity).first();
    if (definition.selectors.quantityAwaitMs) {
      await quantityInput.waitFor({ state: "attached", timeout: definition.selectors.quantityAwaitMs })
        .catch(() => undefined);
    }
    const quantityInputCount = await quantityInput.count();
    assertPortalBoundary(definition, session.page, session.boundary);
    if (quantityInputCount > 0) {
      await input.providerKillSwitchCheckpoint?.("before_configure");
      enterProviderMutation(session.boundary);
      await quantityInput.fill(String(input.requestedQuantity));
      assertPortalBoundary(definition, session.page, session.boundary);
    } else if (session.boundary.recover) {
      await input.providerKillSwitchCheckpoint?.("before_configure");
      await recoverMissingConfiguration(definition, session.page, session.boundary,
        "quantity", "fill", String(input.requestedQuantity));
    } else {
      await observeMissingConfiguration(definition, session.page, session.boundary, "quantity", "fill", String(input.requestedQuantity));
    }
  }
  await definition.hooks.configure(
    buildConfigurationCapability(definition, session.page, session.boundary, input.providerKillSwitchCheckpoint),
    input,
    buildReadCapability(definition, session.page, session.boundary),
  );
  assertPortalBoundary(definition, session.page, session.boundary);
  await session.page.waitForLoadState("networkidle", { timeout: config.browserTimeoutMs }).catch(() => undefined);
  await session.page.waitForTimeout(Math.min(2_500, config.browserTimeoutMs));
  assertPortalBoundary(definition, session.page, session.boundary);
}

async function extractProviderPortalOffers(
  interaction: ProviderPortalInteraction,
  snapshot: ProviderPortalSnapshot,
): Promise<ProviderPortalKernelResult> {
  const { definition, config, input, dependencies, session } = interaction;
  const reader = buildReadCapability(definition, session.page, session.boundary);
  const candidates = await definition.hooks.extractOffers(reader, input);
  const options = { expectedQuantity: input.requestedQuantity, allowedHosts: definition.allowedHosts, artifacts: [] };
  const nativeLane = candidates.some((candidate) => "money" in candidate);
  const nativeOffers = nativeLane ? normalizeAnchoredNativeOffers(candidates, options) : [];
  const offers = nativeLane ? [] : normalizeAnchoredProviderOffers(candidates as ProviderPortalOfferCandidate[], options);
  assertPortalBoundary(definition, session.page, session.boundary);
  const capture = dependencies.captureEvidence ?? captureScrubbedProviderEvidence;
  const portalBoundary = snapshotBoundaryTelemetry(session.boundary.telemetry);
  if (offers.length === 0 && nativeOffers.length === 0) {
    const artifacts = await capture(definition, config, "selector_drift", snapshot, portalBoundary);
    return terminalResult(
      "selector_drift",
      "anchored_offer_not_found",
      session.page,
      artifacts,
      session.boundary.providerMutationPossible,
    );
  }
  const artifacts = await capture(definition, config, "offers_extracted", snapshot, portalBoundary);
  if (nativeLane) {
    return {
      state: "native_offers_extracted", reason: "anchored_native_offers_extracted", url: session.page.url(),
      offers: [], nativeOffers: nativeOffers.map((offer) => ({ ...offer, artifactRefs: sanitizeArtifactRefs(artifacts) })),
      artifacts, providerMutationPossible: session.boundary.providerMutationPossible,
    };
  }
  return {
    state: "offers_extracted",
    reason: "anchored_offers_extracted",
    url: session.page.url(),
    offers: offers.map((offer) => ({
      ...offer,
      artifactRefs: sanitizeArtifactRefs(artifacts),
    })),
    artifacts,
    providerMutationPossible: session.boundary.providerMutationPossible,
  };
}

async function runProviderPortalInteraction(
  interaction: ProviderPortalInteraction,
): Promise<ProviderPortalKernelResult> {
  const { definition, config, input, session } = interaction;
  await runIntentionalPortalRetry({
    // OVD-722: every navigation attempt, including the retry, re-reads the switch first.
    operation: async () => {
      await input.providerKillSwitchCheckpoint?.("before_navigation");
      return session.page.goto(definition.routes.uploadUrl, { waitUntil: "domcontentloaded" });
    },
    maxAttempts: 2,
    providerMutationPossible: session.boundary.providerMutationPossible,
  });
  assertPortalBoundary(definition, session.page, session.boundary);
  let snapshot = await snapshotPortal(session.page);
  await definition.hooks.beforeUpload?.(buildReadCapability(definition, session.page, session.boundary));
  assertPortalBoundary(definition, session.page, session.boundary);
  let state = await definition.hooks.classifyPortalState(snapshot);
  const initialTerminal = await captureTerminalPortalState(interaction, state, snapshot);
  if (initialTerminal) {
    return initialTerminal;
  }
  const uploadTerminal = await uploadAuthorizedPortalFiles(interaction);
  if (uploadTerminal) {
    return uploadTerminal;
  }
  await configureProviderPortalQuote(interaction);
  snapshot = await snapshotPortal(session.page);
  state = await definition.hooks.classifyPortalState(snapshot);
  const configuredTerminal = await captureTerminalPortalState(interaction, state, snapshot);
  if (configuredTerminal) {
    return configuredTerminal;
  }
  return extractProviderPortalOffers(interaction, snapshot);
}

/** Signals present when a portal step stops, in no particular arrival order. */
export type PortalBoundarySignals = {
  /** First recorded boundary violation, e.g. `unexpected_navigation:<host>`. */
  violation: string | null;
  /** Main-frame URL at the time of the stop, when a page exists. */
  currentUrl: string | null;
  allowedHosts: readonly string[];
  providerMutationPossible: boolean;
  /** Terminal classification a step already produced (e.g. selector drift), if any. */
  stepOutcome: { terminalState: ProviderPortalTerminalState; reason: string } | null;
};

export type PortalBoundaryOutcome = {
  terminalState: ProviderPortalTerminalState;
  reason: string;
};

/**
 * OVD-826: the single precedence rule for a stopped portal step:
 * unexpected_origin > ambiguous_provider_mutation > selector_drift. An origin
 * signal is terminal and drops whatever the step was classifying, regardless
 * of which signal arrived first.
 */
export function classifyPortalBoundaryOutcome(signals: PortalBoundarySignals): PortalBoundaryOutcome {
  if (signals.violation) {
    return { terminalState: "unexpected_origin", reason: signals.violation };
  }
  if (
    signals.currentUrl !== null
    && signals.currentUrl !== "about:blank"
    && !isAllowedProviderUrl(signals.currentUrl, signals.allowedHosts)
  ) {
    return { terminalState: "unexpected_origin", reason: "unexpected_origin" };
  }
  if (signals.stepOutcome) {
    return signals.stepOutcome;
  }
  return signals.providerMutationPossible
    ? { terminalState: "selector_drift", reason: "ambiguous_provider_mutation" }
    : { terminalState: "unavailable", reason: "browser_or_navigation_unavailable" };
}

function stepOutcomeOf(error: VendorAutomationError): PortalBoundaryOutcome | null {
  const { terminalState, reason } = error.payload;
  return typeof terminalState === "string" && typeof reason === "string"
    ? { terminalState: terminalState as ProviderPortalTerminalState, reason }
    : null;
}

function translatePortalKernelError(
  definition: ProviderPortalDefinition,
  boundary: PortalBoundaryState,
  currentUrl: string | null,
  error: unknown,
): VendorAutomationError | ProviderKillSwitchError {
  // Dispatch authorization and export-control decisions are rethrown
  // unchanged by the caller before translation (isDispatchDecisionError).
  // OVD-722: a kill-switch refusal is never re-labelled as a provider failure.
  if (error instanceof ProviderKillSwitchError) return error;
  const stepOutcome = error instanceof VendorAutomationError ? stepOutcomeOf(error) : null;
  const outcome = classifyPortalBoundaryOutcome({
    violation: boundary.violation,
    currentUrl,
    allowedHosts: definition.allowedHosts,
    providerMutationPossible: boundary.providerMutationPossible,
    stepOutcome,
  });
  const originOverridesStep = outcome.terminalState === "unexpected_origin"
    && (stepOutcome?.terminalState !== outcome.terminalState || stepOutcome.reason !== outcome.reason);
  if (error instanceof VendorAutomationError && !originOverridesStep) {
    if (boundary.providerMutationPossible && error.payload.providerMutationPossible !== true) {
      error.payload.providerMutationPossible = true;
    }
    return error;
  }
  return terminalError(
    definition,
    outcome.terminalState,
    outcome.reason,
    { providerMutationPossible: boundary.providerMutationPossible },
  );
}

function safePageUrl(page: Page | undefined): string | null {
  try {
    return page?.url() ?? null;
  } catch {
    return null;
  }
}

/**
 * Runs one quote-only portal attempt in an isolated browser context. Every
 * disclosure precondition is evaluated before launch, and every top-level
 * navigation is exact-host checked before further interaction.
 */
export async function runProviderPortalKernel(
  definition: ProviderPortalDefinition,
  config: WorkerConfig,
  input: VendorQuoteAdapterInput,
  dependencies: RunProviderPortalKernelDependencies = {},
): Promise<ProviderPortalKernelResult> {
  if (definition.provider === "oshcut") refuseOshcutPortalAutomation();
  assertProviderDefinition(definition);
  assertEnvelopeFileShape(definition, input);
  let files: LiveEvaluationUploadFiles;
  if (input.executionContext === "live_evaluation") {
    files = exactAuthorizedFiles(definition, input);
    assertExactProviderPortalApproval(definition, input);
  } else {
    files = await productionDispatchFiles(definition, input);
  }
  const eligibility = await definition.hooks.assessEligibility(input);
  if (eligibility.state !== "eligible") {
    return terminalResult(eligibility.state, eligibility.reason, null, [], false);
  }

  const storageState = await resolveIsolatedProviderStorageState(definition, config);
  if (!storageState) {
    throw terminalError(
      definition,
      "missing_session",
      "missing_storage_state",
      { providerInteractionAttempted: false },
    );
  }

  let session: OpenProviderPortalSession | null = null;
  let cleanupRan = false;
  try {
    session = await openProviderPortalSession(definition, config, storageState, { ...dependencies,
      operationalJev: dependencies.operationalJev ? { ...dependencies.operationalJev, scope: { ...dependencies.operationalJev.scope,
        provider: definition.provider, organizationId: input.organizationId, quoteRunId: input.quoteRunId } } : undefined });
    const result = await runProviderPortalInteraction({ definition, config, input, files, dependencies, session });
    cleanupRan = true;
    const cartCleanup = await cleanUpProviderPortal(definition, input, session, dependencies.cleanupTimeoutMs);
    return {
      ...result,
      portalBoundary: snapshotBoundaryTelemetry(session.boundary.telemetry),
      ...(cartCleanup ? { cartCleanup } : {}),
    };
  } catch (error) {
    // Cleanup also follows a failure after upload; it never replaces the error.
    const cartCleanup = session && !cleanupRan && !(error instanceof ProviderKillSwitchError)
      ? await cleanUpProviderPortal(definition, input, session, dependencies.cleanupTimeoutMs)
      : undefined;
    if (cartCleanup && error instanceof VendorAutomationError) error.payload.cartCleanup = cartCleanup;
    if (isDispatchDecisionError(error)) {
      throw error;
    }
    const boundary = session?.boundary ?? { providerMutationPossible: false, violation: null };
    const translated = translatePortalKernelError(definition, boundary, safePageUrl(session?.page), error);
    if (translated instanceof ProviderKillSwitchError) throw translated;
    if (session) translated.payload.portalBoundary = snapshotBoundaryTelemetry(session.boundary.telemetry);
    if (cartCleanup) translated.payload.cartCleanup = cartCleanup;
    if (dependencies.operationalJev) {
      const { scope } = dependencies.operationalJev;
      await observeBoundOperationalFailure(dependencies.operationalJev, { ...scope, provider: definition.provider,
        organizationId: input.organizationId, quoteRunId: input.quoteRunId }, error);
    }
    if (dependencies.failureTriage) {
      // Advisory failure must never replace or weaken the original deterministic error.
      const triage = await triageUnstructuredFailure(error, dependencies.failureTriage).catch(() => null);
      if (triage) translated.payload.failureTriage = triage;
    }
    throw translated;
  } finally {
    await session?.context.close().catch(() => undefined);
    await session?.browser.close().catch(() => undefined);
  }
}
