import { UNANCHORED_PRICE_NOTE } from "../extractedValue.js";
import { getAuthorizedLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import {
  VendorAutomationError,
  type LiveAutomationVendorName,
  type LiveEvaluationUploadFile,
  type StagedFile,
  type VendorName,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOutput,
  type WorkerConfig,
} from "../types.js";
import { VendorAdapter } from "./base.js";
import {
  classifyProviderPortalSnapshot,
  PROVIDER_PORTAL_KERNEL_REVISION,
  runProviderPortalKernel,
  type ProviderPortalDefinition,
  type ProviderPortalKernelResult,
  type ProviderPortalTerminalState,
} from "./providerPortalKernel.js";

export type PortalQuoteWorkflow = {
  vendor: LiveAutomationVendorName;
  displayName: string;
  source: string;
  publicUrl: string;
  loginUrl: string;
  uploadUrl: string;
  processFamily: "sheet_metal" | "multi_process";
  supportedFileExtensions: string[];
  officialNotes: string[];
};

type ExtractedQuoteSignal = {
  totalPriceUsd: number | null;
  leadTimeBusinessDays: number | null;
};

const LEAD_TIME_PATTERN = /(\d{1,3})\s*(?:business\s*)?(?:day|days)\b/i;
const MANUAL_REVIEW_PATTERN = /\b(manual review|engineering review|reviewing|requires review|quote request received)\b/i;
const CONFIGURATION_REQUIRED_PATTERN =
  /\b(set (?:size and )?material|enter your zip code|specify your parts configuration|select a technology|select material|select thickness|configure (?:your )?part|checkout)\b/i;
const LOGIN_ROUTE_PATTERN = /\b(login|signin|sign-in|registration|register)\b/i;
const CAPTCHA_PATTERN = /\b(captcha|verify you are human|cloudflare challenge|security check)\b/i;
const UNAVAILABLE_PATTERN = /\b(service unavailable|temporarily unavailable|maintenance)\b/i;
const QUANTITY_SELECTOR =
  "input[name*='quantity' i], input[aria-label*='quantity' i], input[placeholder*='quantity' i], input[name='qty' i]";

/** Selects captured CAD bytes and rejects unverified generic drawing upload. */
export function resolvePortalCadUploadFile(
  input: VendorQuoteAdapterInput & { stagedCadFile: StagedFile },
  vendor: LiveAutomationVendorName,
): string | LiveEvaluationUploadFile {
  const authorizedFiles = getAuthorizedLiveEvaluationFiles(input);
  if (authorizedFiles?.drawing) {
    throw new VendorAutomationError(
      "Generic portal live evaluation does not support drawing upload.",
      "upload_failure",
      {
        vendor,
        reason: "evaluation_drawing_not_supported",
        terminalState: "unsupported",
        providerInteractionAttempted: false,
      },
    );
  }

  return authorizedFiles?.cad ?? input.stagedCadFile.localPath;
}

function workflowHosts(workflow: PortalQuoteWorkflow): string[] {
  return [...new Set([
    new URL(workflow.publicUrl).hostname.toLowerCase(),
    new URL(workflow.loginUrl).hostname.toLowerCase(),
    new URL(workflow.uploadUrl).hostname.toLowerCase(),
  ])];
}

/** Builds the provider-neutral definition used by generic reconnaissance. */
export function buildPortalWorkflowDefinition(
  workflow: PortalQuoteWorkflow,
): ProviderPortalDefinition {
  const terminalSignals = {
    login: [LOGIN_ROUTE_PATTERN],
    captcha: [CAPTCHA_PATTERN],
    manualReview: [MANUAL_REVIEW_PATTERN],
    configurationRequired: [CONFIGURATION_REQUIRED_PATTERN],
    unavailable: [UNAVAILABLE_PATTERN],
  };
  return {
    provider: workflow.vendor,
    displayName: workflow.displayName,
    manifestRevision: "provider-manifest.v1",
    envelopeRevision: `${workflow.vendor}-declarative-envelope.v1`,
    adapterRevision: "generic-portal-reconnaissance.v2",
    accountMode: "isolated_authenticated_session",
    routes: {
      publicUrl: workflow.publicUrl,
      loginUrl: workflow.loginUrl,
      uploadUrl: workflow.uploadUrl,
    },
    allowedHosts: workflowHosts(workflow),
    selectors: {
      cadUpload: "input[type='file']",
      quantity: QUANTITY_SELECTOR,
    },
    supportedFileExtensions: workflow.supportedFileExtensions,
    terminalSignals,
    requirements: {
      quoteOnly: true,
      orderProhibited: true,
      isolatedSession: true,
    },
    hooks: {
      assessEligibility: (input) => {
        if (!Number.isSafeInteger(input.requestedQuantity) || input.requestedQuantity < 1) {
          return { state: "unsupported", reason: "quantity_outside_envelope" };
        }
        return { state: "eligible", reason: "conservative_file_and_quantity_fit" };
      },
      configure: () => undefined,
      classifyPortalState: (snapshot) => classifyProviderPortalSnapshot(snapshot, terminalSignals),
      // Generic reconnaissance has no reviewed vendor-specific offer anchors.
      // Whole-page currency text is evidence only and can never become an offer.
      extractOffers: () => [],
    },
  };
}

function terminalErrorCode(state: ProviderPortalTerminalState) {
  if (state === "login_required" || state === "missing_session") {
    return "login_required" as const;
  }
  if (state === "captcha") {
    return "captcha" as const;
  }
  if (state === "selector_drift") {
    return "selector_failure" as const;
  }
  return "unexpected_ui_state" as const;
}

export class PortalQuoteWorkflowAdapter extends VendorAdapter {
  constructor(
    vendor: VendorName,
    config: WorkerConfig,
    private readonly workflow: PortalQuoteWorkflow,
  ) {
    super(vendor, config);
  }

  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    if (this.config.workerMode !== "live") {
      return this.manualFollowUpOutput(input, "simulate_hidden_vendor", "unavailable");
    }
    if (!input.stagedCadFile) {
      throw new VendorAutomationError(
        `${this.workflow.displayName} live automation requires a staged CAD file.`,
        "upload_failure",
        this.payload(input, "missing_staged_cad_file", "unsupported", false),
      );
    }
    if (
      input.executionContext !== "live_evaluation"
      || !getAuthorizedLiveEvaluationFiles(input)
    ) {
      throw new VendorAutomationError(
        `${this.workflow.displayName} requires exact live-evaluation file authorization.`,
        "login_required",
        this.payload(input, "exact_file_authorization_missing", "unsupported", false, {
          providerInteractionAttempted: false,
        }),
      );
    }

    // Retains the existing generic drawing refusal while the kernel enforces
    // the same decision before browser launch.
    resolvePortalCadUploadFile(
      input as VendorQuoteAdapterInput & { stagedCadFile: StagedFile },
      this.workflow.vendor,
    );

    const result = await runProviderPortalKernel(
      buildPortalWorkflowDefinition(this.workflow),
      this.config,
      input,
    );
    return this.outputForKernelResult(input, result);
  }

  private outputForKernelResult(
    input: VendorQuoteAdapterInput,
    result: ProviderPortalKernelResult,
  ): VendorQuoteAdapterOutput {
    if (result.state === "offers_extracted") {
      const first = result.offers[0];
      if (!first) {
        throw new VendorAutomationError(
          `${this.workflow.displayName} returned no normalized provider offer.`,
          "selector_failure",
          this.payload(input, "anchored_offer_not_found", "selector_drift", result.providerMutationPossible),
          result.artifacts,
        );
      }
      return {
        vendor: this.vendor,
        status: "instant_quote_received",
        unitPriceUsd: first.unitPriceUsd,
        totalPriceUsd: first.totalPriceUsd,
        leadTimeBusinessDays: first.leadTimeBusinessDays,
        quoteUrl: first.quoteUrl ?? result.url,
        validUntil: first.validUntil,
        validityDurationDays: first.validityDurationDays,
        validitySource: first.validitySource,
        validityTerms: first.validityTerms,
        offers: result.offers,
        dfmIssues: [],
        notes: [`${this.workflow.displayName} returned selector-anchored quote options.`],
        artifacts: result.artifacts,
        rawPayload: this.payload(
          input,
          result.reason,
          "offers_extracted",
          result.providerMutationPossible,
          { offers: result.offers },
        ),
      };
    }

    if (result.state === "manual_review") {
      return {
        vendor: this.vendor,
        status: "manual_review_pending",
        unitPriceUsd: null,
        totalPriceUsd: null,
        leadTimeBusinessDays: null,
        quoteUrl: result.url,
        offers: [],
        dfmIssues: [],
        notes: [`${this.workflow.displayName} accepted the upload but routed the quote to review.`],
        artifacts: result.artifacts,
        rawPayload: this.payload(input, result.reason, result.state, result.providerMutationPossible),
      };
    }

    if (result.state === "configuration_required" || result.state === "unsupported") {
      return this.manualFollowUpOutput(input, result.reason, result.state, result);
    }

    const note = result.state === "selector_drift"
      ? UNANCHORED_PRICE_NOTE
      : `${this.workflow.displayName} evaluation stopped in ${result.state}.`;
    throw new VendorAutomationError(
      note,
      terminalErrorCode(result.state),
      this.payload(input, result.reason, result.state, result.providerMutationPossible, {
        url: result.url,
      }),
      result.artifacts,
    );
  }

  private manualFollowUpOutput(
    input: VendorQuoteAdapterInput,
    reason: string,
    terminalState: ProviderPortalTerminalState,
    result?: ProviderPortalKernelResult,
  ): VendorQuoteAdapterOutput {
    return {
      vendor: this.vendor,
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: result?.url ?? null,
      offers: [],
      dfmIssues: [],
      notes: [
        `${this.workflow.displayName} is not eligible to publish automated quote data from the generic portal workflow.`,
      ],
      artifacts: result?.artifacts ?? [],
      rawPayload: this.payload(
        input,
        reason,
        terminalState,
        result?.providerMutationPossible ?? false,
      ),
    };
  }

  private payload(
    input: VendorQuoteAdapterInput,
    reason: string,
    terminalState: ProviderPortalTerminalState | "offers_extracted",
    providerMutationPossible: boolean,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const definition = buildPortalWorkflowDefinition(this.workflow);
    return {
      vendor: this.workflow.vendor,
      source: this.workflow.source,
      publicUrl: this.workflow.publicUrl,
      uploadUrl: this.workflow.uploadUrl,
      processFamily: this.workflow.processFamily,
      supportedFileExtensions: this.workflow.supportedFileExtensions,
      requestedQuantity: input.requestedQuantity,
      mode: this.config.workerMode,
      executionContext: input.executionContext ?? "production_dispatch",
      kernelRevision: PROVIDER_PORTAL_KERNEL_REVISION,
      manifestRevision: definition.manifestRevision,
      envelopeRevision: definition.envelopeRevision,
      adapterRevision: definition.adapterRevision,
      terminalState,
      reason,
      providerMutationPossible,
      quoteOnly: true,
      orderProhibited: true,
      ...extra,
    };
  }
}

export function extractQuoteSignal(text: string): ExtractedQuoteSignal {
  const leadTimeMatch = LEAD_TIME_PATTERN.exec(text);
  const parsedTotalPriceUsd = extractCurrencySignal(text);
  const leadTimeBusinessDays = leadTimeMatch?.[1]
    ? Number.parseInt(leadTimeMatch[1], 10)
    : null;

  return {
    totalPriceUsd:
      parsedTotalPriceUsd !== null && Number.isFinite(parsedTotalPriceUsd) && parsedTotalPriceUsd > 0
        ? parsedTotalPriceUsd
        : null,
    leadTimeBusinessDays: Number.isFinite(leadTimeBusinessDays)
      ? leadTimeBusinessDays
      : null,
  };
}

function extractCurrencySignal(text: string): number | null {
  const normalizedText = text.toLowerCase();
  const markers = ["$", "usd"];
  for (const marker of markers) {
    let searchFrom = 0;
    while (searchFrom < normalizedText.length) {
      const markerIndex = normalizedText.indexOf(marker, searchFrom);
      if (markerIndex < 0) {
        break;
      }
      const parsedValue = parseCurrencyPrefix(
        text.slice(markerIndex + marker.length, markerIndex + marker.length + 24),
      );
      if (parsedValue !== null) {
        return parsedValue;
      }
      searchFrom = markerIndex + marker.length;
    }
  }
  return null;
}

function parseCurrencyPrefix(value: string): number | null {
  let cursor = 0;
  while (cursor < value.length && value[cursor]?.trim() === "") {
    cursor += 1;
  }
  let token = "";
  while (cursor < value.length) {
    const character = value[cursor];
    if (!character || (!isDigit(character) && character !== "," && character !== ".")) {
      break;
    }
    token += character;
    cursor += 1;
  }
  if (!token || ![...token].some(isDigit)) {
    return null;
  }
  const parsedValue = Number.parseFloat(token.replaceAll(",", ""));
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function isDigit(value: string) {
  return value >= "0" && value <= "9";
}

export function isLoginRequiredPageSignal(input: {
  url: string;
  bodyText: string;
  passwordInputCount: number;
}) {
  if (LOGIN_ROUTE_PATTERN.test(input.url.toLowerCase())) {
    return true;
  }
  if (input.passwordInputCount < 1) {
    return false;
  }
  return /\b(log in|login|sign in|signin|create account|password)\b/i.test(input.bodyText);
}

export function isConfigurationRequiredPageSignal(text: string) {
  return CONFIGURATION_REQUIRED_PATTERN.test(text);
}

export function excerptText(text: string, maxLength = 2000) {
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
