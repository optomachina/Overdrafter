import { constants } from "node:fs";
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
} from "playwright";
import {
  gateLeadTime,
  gateVendorPrice,
  type ExtractedValue,
} from "../extractedValue.js";
import { getAuthorizedLiveEvaluationFiles } from "../liveEvaluationFiles.js";
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
};

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
  selectors: {
    cadUpload: string;
    drawingUpload?: string;
    quantity?: string;
    configuration?: Readonly<Record<string, {
      selector: string;
      operation: "fill" | "select";
    }>>;
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
  hooks: {
    assessEligibility: (
      input: VendorQuoteAdapterInput,
    ) => ProviderPortalEligibility | Promise<ProviderPortalEligibility>;
    configure: (
      configuration: ProviderPortalConfigurationCapability,
      input: VendorQuoteAdapterInput,
    ) => void | Promise<void>;
    classifyPortalState: (
      snapshot: ProviderPortalSnapshot,
    ) => ProviderPortalState | Promise<ProviderPortalState>;
    extractOffers: (
      reader: ProviderPortalReadCapability,
      input: VendorQuoteAdapterInput,
    ) => ProviderPortalOfferCandidate[] | Promise<ProviderPortalOfferCandidate[]>;
  };
};

export type ProviderPortalKernelResult = {
  state: ProviderPortalTerminalState | "offers_extracted";
  reason: string;
  url: string | null;
  offers: ProviderPortalNormalizedOffer[];
  artifacts: VendorArtifact[];
  providerMutationPossible: boolean;
};

type BrowserLauncher = (
  options: Parameters<typeof chromium.launch>[0],
) => Promise<Browser>;

type RunProviderPortalKernelDependencies = {
  launchBrowser?: BrowserLauncher;
  captureEvidence?: (
    definition: ProviderPortalDefinition,
    config: WorkerConfig,
    state: ProviderPortalTerminalState | "offers_extracted",
    snapshot: ProviderPortalSnapshot,
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
  for (const rule of Object.values(definition.selectors.configuration ?? {})) {
    if (PROHIBITED_CONFIGURATION_SELECTOR.test(rule.selector)) {
      throw new Error(`${definition.provider} portal definition contains a prohibited configuration selector.`);
    }
  }
}

const PROHIBITED_CONFIGURATION_SELECTOR = /checkout|order|purchase|payment|cart/i;

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
  for (const cookie of record.cookies) {
    if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) {
      return null;
    }
    const domain = normalizedCookieDomain((cookie as Record<string, unknown>).domain);
    if (!domain || !allowed.has(domain)) {
      return null;
    }
  }
  for (const originEntry of record.origins) {
    if (!originEntry || typeof originEntry !== "object" || Array.isArray(originEntry)) {
      return null;
    }
    const origin = (originEntry as Record<string, unknown>).origin;
    if (typeof origin !== "string" || !isAllowedProviderUrl(origin, allowedHosts)) {
      return null;
    }
    const parsedOrigin = new URL(origin);
    if (
      parsedOrigin.pathname !== "/"
      || parsedOrigin.search
      || parsedOrigin.hash
      || parsedOrigin.username
      || parsedOrigin.password
    ) {
      return null;
    }
  }
  return value as Exclude<BrowserContextOptions["storageState"], string | undefined>;
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
  config: WorkerConfig,
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

/** Removes common account/customer identifiers before any portal text is persisted. */
export function scrubProviderEvidenceText(value: string, maxLength = 2_000): string {
  return scrubEmailTokens(value)
    .replace(/\b(token|session|authorization|cookie)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/\b(account|customer|order|quote)[^\r\n:#=]{0,24}[:#=][^\s]+/gi, "$1=<redacted>")
    .replace(/\+?\d[\d ().-]{8,}\d/g, "<redacted-phone>")
    .replace(/\b[a-f0-9]{32,}\b/gi, "<redacted-identifier>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
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

type PortalBoundaryState = {
  providerMutationPossible: boolean;
  violation: string | null;
};

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

async function installPortalBoundaryGuards(
  definition: ProviderPortalDefinition,
  context: BrowserContext,
  page: Page,
  boundary: PortalBoundaryState,
): Promise<void> {
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (!isAllowedProviderUrl(requestUrl, definition.allowedHosts)) {
      boundary.violation = `unexpected_request:${safeObservedHost(requestUrl)}`;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.routeWebSocket("**/*", async (webSocketRoute) => {
    const socketUrl = webSocketRoute.url();
    if (!isAllowedProviderWebSocketUrl(socketUrl, definition.allowedHosts)) {
      boundary.violation = `unexpected_websocket:${safeObservedHost(socketUrl)}`;
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
    boundary.violation = `unexpected_page:${safeObservedHost(unexpectedPage.url())}`;
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
      boundary.violation = `unexpected_navigation:${safeObservedHost(frame.url())}`;
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
      return false;
    }
    boundary.providerMutationPossible = true;
    if (operation === "fill") {
      await locator.fill(value);
    } else {
      await locator.selectOption(value);
    }
    assertPortalBoundary(definition, page, boundary);
    return true;
  };
  return Object.freeze({
    fill: (field: string, value: string) => perform("fill", field, value),
    select: (field: string, value: string) => perform("select", field, value),
  });
}

function launchOptions(config: WorkerConfig): Parameters<typeof chromium.launch>[0] {
  const args: string[] = [];
  if (config.playwrightDisableSandbox) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }
  if (config.playwrightDisableDevShmUsage) {
    args.push("--disable-dev-shm-usage");
  }
  return {
    headless: config.playwrightHeadless,
    timeout: config.browserTimeoutMs,
    args,
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
    const context = await browser.newContext({ storageState, serviceWorkers: "block" });
    context.setDefaultTimeout(config.browserTimeoutMs);
    context.setDefaultNavigationTimeout(config.browserTimeoutMs);
    const page = await context.newPage();
    const boundary: PortalBoundaryState = {
      providerMutationPossible: false,
      violation: null,
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
  const artifacts = await capture(interaction.definition, interaction.config, state, snapshot);
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
  const { definition, files, session } = interaction;
  const cadInput = session.page.locator(definition.selectors.cadUpload).first();
  const cadInputCount = await cadInput.count();
  assertPortalBoundary(definition, session.page, session.boundary);
  if (cadInputCount < 1) {
    return terminalResult("selector_drift", "cad_upload_selector_missing", session.page, [], false);
  }
  session.boundary.providerMutationPossible = true;
  await cadInput.setInputFiles(files.cad);
  assertPortalBoundary(definition, session.page, session.boundary);
  return uploadAuthorizedDrawing(interaction);
}

async function uploadAuthorizedDrawing(
  interaction: ProviderPortalInteraction,
): Promise<ProviderPortalKernelResult | null> {
  const { definition, files, session } = interaction;
  if (!files.drawing || !definition.selectors.drawingUpload) {
    return null;
  }
  const drawingInput = session.page.locator(definition.selectors.drawingUpload).first();
  const drawingInputCount = await drawingInput.count();
  assertPortalBoundary(definition, session.page, session.boundary);
  if (drawingInputCount < 1) {
    return terminalResult("selector_drift", "drawing_upload_selector_missing", session.page, [], true);
  }
  await drawingInput.setInputFiles(files.drawing);
  assertPortalBoundary(definition, session.page, session.boundary);
  return null;
}

async function configureProviderPortalQuote(interaction: ProviderPortalInteraction): Promise<void> {
  const { definition, config, input, session } = interaction;
  if (definition.selectors.quantity) {
    const quantityInput = session.page.locator(definition.selectors.quantity).first();
    const quantityInputCount = await quantityInput.count();
    assertPortalBoundary(definition, session.page, session.boundary);
    if (quantityInputCount > 0) {
      session.boundary.providerMutationPossible = true;
      await quantityInput.fill(String(input.requestedQuantity));
      assertPortalBoundary(definition, session.page, session.boundary);
    }
  }
  await definition.hooks.configure(
    buildConfigurationCapability(definition, session.page, session.boundary),
    input,
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
  const offers = normalizeAnchoredProviderOffers(
    await definition.hooks.extractOffers(reader, input),
    {
      expectedQuantity: input.requestedQuantity,
      allowedHosts: definition.allowedHosts,
      artifacts: [],
    },
  );
  assertPortalBoundary(definition, session.page, session.boundary);
  const capture = dependencies.captureEvidence ?? captureScrubbedProviderEvidence;
  if (offers.length === 0) {
    const artifacts = await capture(definition, config, "selector_drift", snapshot);
    return terminalResult(
      "selector_drift",
      "anchored_offer_not_found",
      session.page,
      artifacts,
      session.boundary.providerMutationPossible,
    );
  }
  const artifacts = await capture(definition, config, "offers_extracted", snapshot);
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
  const { definition, config, session } = interaction;
  await runIntentionalPortalRetry({
    operation: () => session.page.goto(definition.routes.uploadUrl, { waitUntil: "domcontentloaded" }),
    maxAttempts: 2,
    providerMutationPossible: session.boundary.providerMutationPossible,
  });
  assertPortalBoundary(definition, session.page, session.boundary);
  let snapshot = await snapshotPortal(session.page);
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

function translatePortalKernelError(
  definition: ProviderPortalDefinition,
  boundary: PortalBoundaryState,
  error: unknown,
): VendorAutomationError {
  if (error instanceof VendorAutomationError) {
    if (boundary.providerMutationPossible && error.payload.providerMutationPossible !== true) {
      error.payload.providerMutationPossible = true;
    }
    return error;
  }
  return terminalError(
    definition,
    boundary.providerMutationPossible ? "selector_drift" : "unavailable",
    boundary.providerMutationPossible ? "ambiguous_provider_mutation" : "browser_or_navigation_unavailable",
    { providerMutationPossible: boundary.providerMutationPossible },
  );
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
  assertProviderDefinition(definition);
  assertEnvelopeFileShape(definition, input);
  const files = exactAuthorizedFiles(definition, input);
  assertExactProviderPortalApproval(definition, input);
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
  try {
    session = await openProviderPortalSession(definition, config, storageState, dependencies);
    return await runProviderPortalInteraction({ definition, config, input, files, dependencies, session });
  } catch (error) {
    const boundary = session?.boundary ?? { providerMutationPossible: false, violation: null };
    throw translatePortalKernelError(definition, boundary, error);
  } finally {
    await session?.context.close().catch(() => undefined);
    await session?.browser.close().catch(() => undefined);
  }
}
