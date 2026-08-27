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
