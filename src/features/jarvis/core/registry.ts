import type { ChannelAdapter, ChannelId } from "./types";

export type ChannelRegistry = {
  get(id: ChannelId): ChannelAdapter | undefined;
  ids(): ChannelId[];
};

export function createChannelRegistry(adapters: readonly ChannelAdapter[]): ChannelRegistry {
  const byId = new Map<ChannelId, ChannelAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) throw new Error(`duplicate channel adapter: ${adapter.id}`);
    byId.set(adapter.id, adapter);
  }
  return { get: (id) => byId.get(id), ids: () => [...byId.keys()] };
}
