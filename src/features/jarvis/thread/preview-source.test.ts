import { afterEach, expect, it, vi } from 'vitest';
import type { GraphEvent } from '../core/types';
import { createPreview } from './preview-source';
afterEach(() => vi.useRealTimers());
it('replays the synthetic plate through skip to all four artifacts and result', async () => {
  vi.useFakeTimers(); const preview = createPreview(), events: GraphEvent[] = [];
  const stop = preview.source.listen(batch => events.push(...batch), vi.fn());
  await vi.advanceTimersByTimeAsync(800);
  expect(events.map(e => e.type)).toEqual(['status', 'decision_requested']);
  await preview.client.resolve('plate-preview', 'thickness', { resolution: 'skipped_best_guess', idempotencyKey: 'key' });
  await vi.advanceTimersByTimeAsync(800);
  expect(events.filter(e => e.type === 'artifact').map(e => e.kind)).toEqual(['png', 'png', 'glb', 'step']);
  expect(events.at(-1)?.type).toBe('result'); stop();
});
it.each(['pause', 'cancel'] as const)('replays %s requested and applied at a checkpoint', async kind => {
  vi.useFakeTimers(); const preview = createPreview(), events: GraphEvent[] = [];
  const stop = preview.source.listen(batch => events.push(...batch), vi.fn());
  await preview.client.control('plate-preview', { kind, idempotencyKey: 'key' });
  expect(events.at(-1)?.type).toBe('control_requested');
  await vi.advanceTimersByTimeAsync(800); expect(events.at(-1)).toMatchObject({ type: 'control_applied', kind }); stop();
});
