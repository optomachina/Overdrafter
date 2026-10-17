import { afterEach, expect, it, vi } from 'vitest';
import { createEventSource } from './event-source';
import type { GraphEvent } from '../core/types';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const event: GraphEvent = { type: 'status', runId: 'r', seq: 1, at: 1, nodeId: 'intake', state: 'started', message: 'Starting' };
it('T9 socket failure polls at 5 seconds and deduplicates socket and poll events', async () => {
  vi.useFakeTimers(); let push: (e: GraphEvent) => void = () => { }; let failed: (down: boolean) => void = () => { };
  const poll = vi.fn().mockResolvedValue([]), unsubscribe = vi.fn();
  const source = createEventSource({ subscribe: vi.fn((_id, e, f) => { push = e; failed = f; return unsubscribe; }), poll }, 'own-conversation');
  const deliver = vi.fn(), connection = vi.fn(); const stop = source.listen(deliver, connection);
  await vi.advanceTimersByTimeAsync(0); failed(true); poll.mockResolvedValue([event]);
  await vi.advanceTimersByTimeAsync(5000); push(event);
  expect(deliver.mock.calls.flatMap(call => call[0])).toEqual([event]); expect(poll).toHaveBeenCalledWith('own-conversation');
  expect(connection).toHaveBeenCalledWith(true); stop(); await vi.advanceTimersByTimeAsync(60000); expect(poll).toHaveBeenCalledTimes(2); expect(unsubscribe).toHaveBeenCalledOnce();
});
it('backs off on polling errors, retries and polls while backgrounded', async () => {
  vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  const poll = vi.fn().mockRejectedValue(new Error('offline'));
  const source = createEventSource({ subscribe: () => () => { }, poll }, 'own');
  const connection = vi.fn(); const stop = source.listen(vi.fn(), connection);
  await vi.advanceTimersByTimeAsync(0); expect(connection).toHaveBeenCalledWith(true);
  await vi.advanceTimersByTimeAsync(9999); expect(poll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(poll).toHaveBeenCalledTimes(2);
  poll.mockResolvedValue([event]); source.retry(); await vi.advanceTimersByTimeAsync(0); expect(connection).toHaveBeenLastCalledWith(false);
  await vi.advanceTimersByTimeAsync(5000); expect(poll).toHaveBeenCalledTimes(4); stop();
});
it('does not deliver or reconnect after an in flight poll completes after disposal', async () => {
  vi.useFakeTimers(); let finish: (events: GraphEvent[]) => void = () => { };
  const deliver = vi.fn(); const poll = vi.fn(() => new Promise<GraphEvent[]>(resolve => { finish = resolve; }));
  const stop = createEventSource({ subscribe: () => () => { }, poll }, 'own').listen(deliver, vi.fn());
  stop(); finish([event]); await vi.advanceTimersByTimeAsync(60000);
  expect(deliver).not.toHaveBeenCalled(); expect(poll).toHaveBeenCalledTimes(1);
});
