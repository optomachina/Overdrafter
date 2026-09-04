import { authorizeLiveEvaluationInput } from "../liveEvaluationFiles.js";
import {
  VendorAutomationError,
  type VendorName,
  type VendorQuoteAdapterInput,
  type WorkerConfig,
} from "../types.js";
import { FictivAdapter } from "./fictiv.js";
import { FabworksAdapter } from "./fabworks.js";
import { ProtolabsAdapter } from "./protolabs.js";
import { SendCutSendAdapter } from "./sendcutsend.js";
import { XometryAdapter } from "./xometry.js";
import { buildExtendedVendorAdapters } from "./extendedVendorWorkflows.js";
import { VendorAdapter } from "./base.js";

class XometryLiveEvaluationAdapter extends XometryAdapter {
  override quote(input: Parameters<XometryAdapter["quote"]>[0]) {
    return this.quoteForLiveEvaluation(input);
  }
}

class LiveEvaluationAdapter extends VendorAdapter {
  constructor(
    private readonly delegate: VendorAdapter,
    config: WorkerConfig,
  ) {
    super(delegate.vendor, config);
  }

  override async quote(input: VendorQuoteAdapterInput) {
    const authorizedInput = await authorizeLiveEvaluationInput(input);
    if (!authorizedInput) {
      throw new VendorAutomationError(
        `Live ${this.vendor} evaluation requires a non-export-controlled confirmation bound to the selected files.`,
        "unexpected_ui_state",
        {
          vendor: this.vendor,
          reason: "evaluation_export_control_authorization_missing",
        },
      );
    }

    return this.delegate.quote(authorizedInput);
  }
}

function buildRegistry(
  config: WorkerConfig,
  xometryAdapter: VendorAdapter,
  liveEvaluation: boolean,
): Partial<Record<VendorName, VendorAdapter>> {
  const evaluationAdapter = (adapter: VendorAdapter) =>
    liveEvaluation ? new LiveEvaluationAdapter(adapter, config) : adapter;
  const registry: Partial<Record<VendorName, VendorAdapter>> = {
    xometry: xometryAdapter,
    fictiv: evaluationAdapter(new FictivAdapter("fictiv", config)),
    protolabs: evaluationAdapter(new ProtolabsAdapter("protolabs", config)),
    sendcutsend: evaluationAdapter(new SendCutSendAdapter("sendcutsend", config)),
    ...Object.fromEntries(
      Object.entries(buildExtendedVendorAdapters(config)).map(([vendor, adapter]) => [
        vendor,
        evaluationAdapter(adapter),
      ]),
    ),
    fabworks: evaluationAdapter(new FabworksAdapter(config)),
  };

  if (config.workerMode !== "live") {
    return registry;
  }

  const enabledLiveAdapters = new Set<string>(config.workerLiveAdapters);

  return Object.fromEntries(
    Object.entries(registry).filter(([vendor]) => enabledLiveAdapters.has(vendor as VendorName)),
  );
}

export function buildAdapterRegistry(config: WorkerConfig): Partial<Record<VendorName, VendorAdapter>> {
  return buildRegistry(config, new XometryAdapter("xometry", config), false);
}

/** Builds adapters for the standalone OVD-407 local-evidence evaluation harness. */
export function buildLiveEvaluationAdapterRegistry(
  config: WorkerConfig,
): Partial<Record<VendorName, VendorAdapter>> {
  return buildRegistry(
    config,
    new XometryLiveEvaluationAdapter("xometry", config),
    true,
  );
}

export {
  assertProviderAdapterContract,
  evaluateProviderAdapterFailureContract,
  evaluateProviderAdapterContract,
  PROVIDER_ADAPTER_CONTRACT_REVISION,
} from "./providerAdapterContract.js";
export type { ProviderAdapterContractDefinition } from "./providerAdapterContract.js";
export {
  captureScrubbedProviderEvidence,
  buildExpectedProviderPortalApproval,
  classifyProviderPortalSnapshot,
  isAllowedProviderUrl,
  normalizeAnchoredProviderOffers,
  parseProviderPortalApprovalDescriptor,
  PROVIDER_PORTAL_KERNEL_REVISION,
  runIntentionalPortalRetry,
  runProviderPortalKernel,
  readProviderPortalApprovalFile,
} from "./providerPortalKernel.js";
export type {
  ProviderPortalDefinition,
  ProviderPortalConfigurationCapability,
  ProviderPortalKernelResult,
  ProviderPortalNormalizedOffer,
  ProviderPortalReadCapability,
  ProviderPortalTerminalState,
} from "./providerPortalKernel.js";
export {
  evaluateQuickpartsEnvelope,
  QUICKPARTS_ENVELOPE_REVISION,
  QUICKPARTS_OFFLINE_AUTHORIZATION_BOUNDARY,
} from "./quickpartsEnvelope.js";
export type {
  QuickpartsEnvelopeDecision,
  QuickpartsEnvelopeInput,
  QuickpartsEnvelopeReason,
  QuickpartsEnvelopeState,
} from "./quickpartsEnvelope.js";
export {
  createEvidenceBackedEnvelopeEvaluator,
  OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
} from "./evidenceBackedEnvelope.js";
export type {
  EvidenceBackedEnvelopeDecision,
  EvidenceBackedEnvelopeInput,
  EvidenceBackedEnvelopePolicy,
  EvidenceBackedEnvelopeReason,
  EvidenceBackedEnvelopeState,
} from "./evidenceBackedEnvelope.js";
export {
  evaluateWeergEnvelope,
  WEERG_ENVELOPE_REVISION,
} from "./weergEnvelope.js";
export type { WeergEnvelopeInput } from "./weergEnvelope.js";
export {
  evaluateGeomiqEnvelope,
  GEOMIQ_ENVELOPE_REVISION,
} from "./geomiqEnvelope.js";
export type { GeomiqEnvelopeInput } from "./geomiqEnvelope.js";
