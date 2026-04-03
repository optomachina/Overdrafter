import type { VendorName, WorkerConfig } from "../types.js";
import { FictivAdapter } from "./fictiv.js";
import { ProtolabsAdapter } from "./protolabs.js";
import { SendCutSendAdapter } from "./sendcutsend.js";
import { XometryAdapter } from "./xometry.js";
import type { VendorAdapter } from "./base.js";

export function buildAdapterRegistry(config: WorkerConfig): Partial<Record<VendorName, VendorAdapter>> {
  const registry: Partial<Record<VendorName, VendorAdapter>> = {
    xometry: new XometryAdapter("xometry", config),
    fictiv: new FictivAdapter("fictiv", config),
    protolabs: new ProtolabsAdapter("protolabs", config),
    sendcutsend: new SendCutSendAdapter("sendcutsend", config),
  };

  if (config.workerMode !== "live") {
    return registry;
  }

  const enabledLiveAdapters = new Set<string>(config.workerLiveAdapters);

  return Object.fromEntries(
    Object.entries(registry).filter(([vendor]) => enabledLiveAdapters.has(vendor as VendorName)),
  );
}
