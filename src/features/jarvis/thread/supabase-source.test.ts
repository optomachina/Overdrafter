import { expect, it, vi } from 'vitest';
import { createSupabaseEventSource } from './supabase-source';
it('subscribes only to the supplied private conversation and removes it on disposal', () => {
  const channel = { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() };
  const client = { channel: vi.fn(() => channel), removeChannel: vi.fn() };
  const stop = createSupabaseEventSource(client, 'own', async () => []).listen(vi.fn(), vi.fn());
  expect(client.channel).toHaveBeenCalledWith('jarvis:conversation:own', { config: { private: true } });
  expect(channel.on).toHaveBeenCalledWith('broadcast', { event: 'graph_event' }, expect.any(Function));
  stop(); expect(client.removeChannel).toHaveBeenCalledWith(channel);
});
