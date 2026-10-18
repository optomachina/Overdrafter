import { afterEach, expect, it, vi } from 'vitest';
import type { GraphEvent } from '../core/types';
import { createPreview } from './preview-source';
afterEach(() => vi.useRealTimers());
it('replays the synthetic plate through skip to all three artifacts and result', async () => {
  vi.useFakeTimers(); const preview = createPreview(), events: GraphEvent[] = [];
  const stop = preview.source.listen(batch => events.push(...batch), vi.fn());
  await vi.advanceTimersByTimeAsync(800);
  expect(events.map(e => e.type)).toEqual(['status', 'decision_requested']);
  await preview.client.resolve('plate-preview', 'thickness', { resolution: 'skipped_best_guess', idempotencyKey: 'key' });
  await vi.advanceTimersByTimeAsync(800);
  expect(events.filter(e => e.type === 'artifact').map(e => e.kind)).toEqual(['png', 'png', 'step']);
  expect(events.at(-1)?.type).toBe('result'); stop();
});
it.each(['pause', 'cancel'] as const)('replays %s requested and applied at a checkpoint', async kind => {
  vi.useFakeTimers(); const preview = createPreview(), events: GraphEvent[] = [];
  const stop = preview.source.listen(batch => events.push(...batch), vi.fn());
  await preview.client.control('plate-preview', { kind, idempotencyKey: 'key' });
  expect(events.at(-1)?.type).toBe('control_requested');
  await vi.advanceTimersByTimeAsync(800); expect(events.at(-1)).toMatchObject({ type: 'control_applied', kind }); stop();
});
it.each(['pause', 'cancel'] as const)('delivers no result when a decision is answered after %s', async kind => {
  vi.useFakeTimers(); const preview = createPreview(), events: GraphEvent[] = [];
  const stop = preview.source.listen(batch => events.push(...batch), vi.fn());
  await vi.advanceTimersByTimeAsync(800);
  await preview.client.control('plate-preview', { kind, idempotencyKey: 'key' });
  await vi.advanceTimersByTimeAsync(800);
  const before = events.length;
  const response = await preview.client.resolve('plate-preview', 'thickness', { resolution: 'chosen', choice: '0.250 in', idempotencyKey: 'k2' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(events).toHaveLength(before);
  expect(events.some(e => e.type === 'result' || e.type === 'decision_resolved')).toBe(false); stop();
});
it('does not deliver a result for a decision answered just before a pause', async () => {
  vi.useFakeTimers(); const preview = createPreview(), events: GraphEvent[] = [];
  const stop = preview.source.listen(batch => events.push(...batch), vi.fn());
  await vi.advanceTimersByTimeAsync(800);
  await preview.client.resolve('plate-preview', 'thickness', { resolution: 'skipped_best_guess', idempotencyKey: 'k' });
  await preview.client.control('plate-preview', { kind: 'pause', idempotencyKey: 'p' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(events.some(e => e.type === 'result')).toBe(false); stop();
});
