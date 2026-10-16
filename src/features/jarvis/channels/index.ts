import { createChannelRegistry, type ChannelRegistry } from "../core/registry";
import type { ChannelAdapter } from "../core/types";
import { createTestAdapter } from "./test-adapter";

// Add a channel = one adapter module in this folder + one line here
// (docs/jarvis-channels.md). The core never names a channel other than web.
export const channelAdapterFactories: readonly (() => ChannelAdapter)[] = [
  () => createTestAdapter(), // test-only: never routes outside the test environment
];

export function createDefaultChannelRegistry(): ChannelRegistry {
  return createChannelRegistry(channelAdapterFactories.map((create) => create()));
}
