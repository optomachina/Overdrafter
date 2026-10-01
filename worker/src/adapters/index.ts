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
import { buildQuickpartsOfflinePortalDefinition } from "./quickpartsPortal.js";
import { buildGeomiqPortalDefinition } from "./geomiqPortal.js";
import { createWeergPortalDefinition } from "./weergPortal.js";
import { PortalQuoteWorkflowAdapter } from "./portalWorkflow.js";
import type { ProviderPortalDefinition } from "./providerPortalKernel.js";
import { getExtendedVendorWorkflow, buildExtendedVendorAdapters } from "./extendedVendorWorkflows.js";
import { VendorAdapter } from "./base.js";
import type { LocalEvaluationAdapter, LocalEvaluationResult } from "./localEvaluationResult.js";
import {
  CANDIDATE_EVALUATION_PREFLIGHT_REVISION,
  evaluateCandidateEvaluationPreflight,
} from "./candidateEvaluationPreflight.js";

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
    return this.delegate.quote(await this.authorize(input));
  }

  /** Explicit standalone operation; it does not widen the production quote() return contract. */
  async evaluateLocally(input: VendorQuoteAdapterInput): Promise<LocalEvaluationResult> {
    if (input.executionContext !== "live_evaluation") {
      throw new VendorAutomationError("Local evaluation context required.", "unexpected_ui_state", {
        reason: "local_evaluation_context_required", terminalState: "unsupported", providerInteractionAttempted: false,
      });
    }
    const authorizedInput = await this.authorize(input);
    return this.delegate instanceof PortalQuoteWorkflowAdapter
      ? this.delegate.evaluateLocally(authorizedInput)
      : this.delegate.quote(authorizedInput);
  }

  /** Capture exact approved bytes and apply candidate preflight before invoking a delegate. */
  private async authorize(input: VendorQuoteAdapterInput) {
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

    const candidate = evaluateCandidateEvaluationPreflight(this.vendor, authorizedInput);
    if (candidate) {
      // These candidates have no reviewed live package/session binding yet.
      // Preserve the existing envelope's evidence without granting interaction
      // authority, even if a future evaluator reports an eligible envelope.
      const terminalState = candidate.state === "unsupported" || candidate.state === "manual_review"
        ? candidate.state : "unavailable";
      throw new VendorAutomationError(
        `Live ${this.vendor} evaluation requires a reviewed evidence-backed package and provider binding.`,
        "unexpected_ui_state",
        {
          vendor: this.vendor,
          reason: `candidate_envelope_${candidate.state}`,
          eligibilityReason: candidate.reasonCodes.join(","),
          terminalState,
          manifestRevision: `${this.vendor}-manifest.v1`,
          envelopeRevision: candidate.envelopeRevision,
          adapterRevision: CANDIDATE_EVALUATION_PREFLIGHT_REVISION,
          executionContext: "live_evaluation",
          providerInteractionAttempted: false,
          providerMutationPossible: false,
          customerLiveOfferEligible: false,
          quoteOnly: true,
          orderProhibited: true,
        },
      );
    }

    return authorizedInput;
  }
}

function buildRegistry(
  config: WorkerConfig,
  xometryAdapter: VendorAdapter,
  liveEvaluation: boolean,
): Partial<Record<VendorName, VendorAdapter>> {
  const evaluationAdapter = (adapter: VendorAdapter) =>
    liveEvaluation ? new LiveEvaluationAdapter(adapter, config) : adapter;
  const localDefinitions: Partial<Record<VendorName, ProviderPortalDefinition>> = liveEvaluation
    ? {
      quickparts: buildQuickpartsOfflinePortalDefinition(),
      weerg: createWeergPortalDefinition(),
      geomiq: buildGeomiqPortalDefinition(),
    }
    : {};
  const registry: Partial<Record<VendorName, VendorAdapter>> = {
    xometry: xometryAdapter,
    fictiv: evaluationAdapter(new FictivAdapter("fictiv", config)),
    protolabs: evaluationAdapter(new ProtolabsAdapter("protolabs", config)),
    sendcutsend: evaluationAdapter(new SendCutSendAdapter("sendcutsend", config)),
    ...Object.fromEntries(
      Object.entries(buildExtendedVendorAdapters(config)).map(([vendor, adapter]) => {
        const definition = localDefinitions[vendor as VendorName];
        if (!definition) {
          return [vendor, evaluationAdapter(adapter)];
        }
        const workflow = getExtendedVendorWorkflow(vendor);
        if (!workflow) {
          throw new Error(`Missing local evaluation workflow for ${vendor}.`);
        }
        return [vendor, evaluationAdapter(
          new PortalQuoteWorkflowAdapter(workflow.vendor, config, workflow, definition),
        )];
      }),
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
): Partial<Record<VendorName, LocalEvaluationAdapter>> {
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
export { runRmfgQuoteOnly, RMFG_QUOTE_TRANSPORT_REVISION } from "./rmfgQuoteTransport.js";
export type {
  RmfgQuoteInput,
  RmfgQuoteOffer,
  RmfgQuoteRequest,
  RmfgQuoteResult,
  RmfgQuoteTransport,
} from "./rmfgQuoteTransport.js";
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
export type { WeergEnvelopeDecision, WeergEnvelopeInput } from "./weergEnvelope.js";
export {
  evaluateGeomiqEnvelope,
  GEOMIQ_ENVELOPE_REVISION,
} from "./geomiqEnvelope.js";
export type { GeomiqEnvelopeInput } from "./geomiqEnvelope.js";
export {
  evaluateRapidDirectEnvelope,
  RAPIDDIRECT_ENVELOPE_REVISION,
} from "./rapiddirectEnvelope.js";
export type {
  RapidDirectEnvelopeDecision,
  RapidDirectEnvelopeInput,
} from "./rapiddirectEnvelope.js";
export {
  evaluateProtolabsNetworkEnvelope,
  PROTOLABS_NETWORK_ENVELOPE_REVISION,
} from "./protolabsNetworkEnvelope.js";
export type {
  ProtolabsNetworkEnvelopeInput,
} from "./protolabsNetworkEnvelope.js";
export {
  evaluatePonokoEnvelope,
  PONOKO_ENVELOPE_REVISION,
  PONOKO_OFFLINE_AUTHORIZATION_BOUNDARY,
} from "./ponokoEnvelope.js";
export type {
  PonokoEnvelopeDecision,
  PonokoEnvelopeInput,
} from "./ponokoEnvelope.js";
export {
  evaluateProtolabsEnvelope,
  PROTOLABS_ENVELOPE_REVISION,
  PROTOLABS_OFFLINE_AUTHORIZATION_BOUNDARY,
} from "./protolabsEnvelope.js";
export type {
  ProtolabsEnvelopeDecision,
  ProtolabsEnvelopeInput,
} from "./protolabsEnvelope.js";
export {
  EMACHINESHOP_ENVELOPE_REVISION,
  evaluateEMachineShopEnvelope,
} from "./emachineShopEnvelope.js";
export type {
  EMachineShopEnvelopeInput,
} from "./emachineShopEnvelope.js";
