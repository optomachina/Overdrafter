import { afterEach, expect, it, vi } from 'vitest';
import { createEventSource, type ConversationTransport } from './event-source';
import { createSupabaseEventSource } from './supabase-source';
import type { GraphEvent } from '../core/types';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const ev = (runId: string, seq: number): GraphEvent => ({ type: 'status', runId, seq, at: seq, nodeId: 'intake', state: 'started', message: `m${seq}` });
const log = (k: string, v: unknown) => console.log(`PROBE ${k} :: ${JSON.stringify(v)}`);

function harness(pollImpl: () => Promise<GraphEvent[]>) {
  let push: (e: GraphEvent) => void = () => {}; let health: (down: boolean) => void = () => {};
  let inflight = 0, maxInflight = 0; const pollTimes: number[] = [];
  const poll = vi.fn(async (_id: string) => { inflight++; maxInflight = Math.max(maxInflight, inflight); pollTimes.push(Date.now()); try { return await pollImpl(); } finally { inflight--; } });
  const unsubscribe = vi.fn();
  const transport: ConversationTransport = { subscribe: vi.fn((_id, e, f) => { push = e; health = f; return unsubscribe; }), poll };
  const source = createEventSource(transport, 'conv-1');
  const delivered: GraphEvent[] = []; const conn: boolean[] = [];
  const stop = source.listen(es => delivered.push(...es), o => conn.push(o));
  return { source, stop, poll, unsubscribe, delivered, conn, pollTimes, push: (e: GraphEvent) => push(e), health: (d: boolean) => health(d), maxInflight: () => maxInflight, transport };
}

it('P1 dedupe key is runId:seq (same seq on another run is kept; repeats across socket/poll dropped)', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(async () => [ev('a', 1), ev('b', 1), ev('a', 1)]);
  await vi.advanceTimersByTimeAsync(0); h.health(false); await vi.advanceTimersByTimeAsync(0);
  h.push(ev('a', 1)); h.push(ev('b', 1)); h.push(ev('a', 2)); h.push(ev('a', 2));
  log('P1 delivered', h.delivered.map(e => `${e.runId}:${e.seq}`));
  expect(h.delivered.map(e => `${e.runId}:${e.seq}`)).toEqual(['a:1', 'b:1', 'a:2']); h.stop();
});

it('P2 poll errors back off 5s->10->20->40->60 cap; success resets to 5s', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let fail = true; const h = harness(async () => { if (fail) throw new Error('offline'); return []; });
  await vi.advanceTimersByTimeAsync(0); h.health(true); // realtime down too
  await vi.advanceTimersByTimeAsync(400_000);
  const gaps = h.pollTimes.slice(1).map((t, i) => t - h.pollTimes[i]);
  log('P2 gaps while failing', gaps.slice(0, 9));
  expect(Math.max(...gaps)).toBeLessThanOrEqual(60_000);
  expect(gaps.slice(-3)).toEqual([60_000, 60_000, 60_000]);
  fail = false; const n = h.pollTimes.length; await vi.advanceTimersByTimeAsync(60_000 + 5_000 * 3 + 1);
  const g2 = h.pollTimes.slice(n).map((t, i, a) => i ? t - a[i - 1] : null).slice(1);
  log('P2 gaps after recovery (realtime still down)', g2);
  expect(g2.every(g => g === 5_000)).toBe(true);
  expect(h.conn.at(-1)).toBe(false); expect(h.maxInflight()).toBe(1); h.stop();
});

it('P3 realtime healthy + visible + poll ok => polling stops (no idle polling)', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(async () => []);
  h.health(false); await vi.advanceTimersByTimeAsync(300_000);
  log('P3 polls over 5 min healthy', h.poll.mock.calls.length);
  expect(h.poll.mock.calls.length).toBeLessThanOrEqual(2); h.stop();
});

it('P4 realtime down polls every 5s; back up => one catch-up poll then stop; gap events delivered once', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let server: GraphEvent[] = [];
  const h = harness(async () => server);
  h.health(false); await vi.advanceTimersByTimeAsync(0);
  const base = h.poll.mock.calls.length;
  h.health(true); await vi.advanceTimersByTimeAsync(15_000);
  const during = h.poll.mock.calls.length - base;
  server = [ev('r', 1), ev('r', 2)];
  h.health(false); await vi.advanceTimersByTimeAsync(0);
  const afterUp = h.poll.mock.calls.length; h.push(ev('r', 2)); h.push(ev('r', 3));
  await vi.advanceTimersByTimeAsync(120_000);
  log('P4', { pollsWhileDown15s: during, pollsAfterUpWithin2min: h.poll.mock.calls.length - afterUp, delivered: h.delivered.map(e => e.seq) });
  expect(during).toBe(3); expect(h.poll.mock.calls.length - afterUp).toBe(0);
  expect(h.delivered.map(e => e.seq)).toEqual([1, 2, 3]); h.stop();
});

it('P5 hidden tab polls at 5s, visible again stops', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let hidden = false; vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  const h = harness(async () => []); h.health(false); await vi.advanceTimersByTimeAsync(0);
  const b = h.poll.mock.calls.length; hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(20_000); const hiddenPolls = h.poll.mock.calls.length - b;
  hidden = false; document.dispatchEvent(new Event('visibilitychange')); const c = h.poll.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  log('P5', { hiddenPolls20s: hiddenPolls, visiblePolls60s: h.poll.mock.calls.length - c });
  expect(hiddenPolls).toBe(4); expect(h.poll.mock.calls.length - c).toBe(0); h.stop();
});

it('P6 disposal: no timers left, listener removed, unsubscribe once, retry no-op, late socket events dropped', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const removeSpy = vi.spyOn(document, 'removeEventListener');
  const h = harness(async () => { throw new Error('x'); });
  await vi.advanceTimersByTimeAsync(0); h.health(true); await vi.advanceTimersByTimeAsync(0);
  h.stop(); const n = h.poll.mock.calls.length;
  document.dispatchEvent(new Event('visibilitychange')); h.source.retry(); h.push(ev('z', 9)); h.health(false); h.health(true);
  await vi.advanceTimersByTimeAsync(300_000);
  log('P6', { timers: vi.getTimerCount(), pollsAfterStop: h.poll.mock.calls.length - n, unsub: h.unsubscribe.mock.calls.length, removedVisibility: removeSpy.mock.calls.some(c => c[0] === 'visibilitychange'), delivered: h.delivered.length });
  expect(vi.getTimerCount()).toBe(0); expect(h.poll.mock.calls.length).toBe(n); expect(h.unsubscribe).toHaveBeenCalledOnce(); expect(h.delivered).toEqual([]);
});

it('P7 never runs two polls concurrently (retry spam + recovery while in flight)', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(() => new Promise(r => setTimeout(() => r([]), 3_000)));
  for (let i = 0; i < 5; i++) { h.source.retry(); h.health(i % 2 === 0); await vi.advanceTimersByTimeAsync(700); }
  await vi.advanceTimersByTimeAsync(60_000);
  log('P7', { maxConcurrentPolls: h.maxInflight(), polls: h.poll.mock.calls.length });
  expect(h.maxInflight()).toBe(1); h.stop();
});

it('P8 supabase source: topic, private flag, status mapping, payload delivery, dispose', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let onMsg: (m: { payload: GraphEvent }) => void = () => {}; let onStatus: (s: string) => void = () => {};
  const channel = { on: vi.fn((_t, _f, cb) => { onMsg = cb; return channel; }), subscribe: vi.fn(cb => { onStatus = cb; return channel; }) };
  const client = { channel: vi.fn(() => channel), removeChannel: vi.fn(async () => 'ok') };
  const poll = vi.fn(async () => [] as GraphEvent[]);
  const delivered: GraphEvent[] = []; const conn: boolean[] = [];
  const stop = createSupabaseEventSource(client as never, 'abc', poll).listen(e => delivered.push(...e), o => conn.push(o));
  await vi.advanceTimersByTimeAsync(0);
  const statusPolls: Record<string, number> = {};
  for (const s of ['SUBSCRIBED', 'CHANNEL_ERROR', 'SUBSCRIBED', 'TIMED_OUT', 'SUBSCRIBED', 'CLOSED']) { const b = poll.mock.calls.length; onStatus(s); await vi.advanceTimersByTimeAsync(5_000); statusPolls[s + '#' + Object.keys(statusPolls).length] = poll.mock.calls.length - b; }
  onMsg({ payload: ev('s', 1) }); onMsg({ payload: ev('s', 1) });
  stop(); onMsg({ payload: ev('s', 2) });
  log('P8', { topic: client.channel.mock.calls[0], statusPolls, delivered: delivered.map(e => e.seq), removed: client.removeChannel.mock.calls.length, conn });
  expect(client.channel).toHaveBeenCalledWith('jarvis:conversation:abc', { config: { private: true } });
  expect(delivered.map(e => e.seq)).toEqual([1]); expect(client.removeChannel).toHaveBeenCalledOnce();
  expect(statusPolls['CHANNEL_ERROR#1']).toBeGreaterThanOrEqual(1); expect(statusPolls['TIMED_OUT#3']).toBeGreaterThanOrEqual(1); expect(statusPolls['CLOSED#5']).toBeGreaterThanOrEqual(1);
});

it('P9 INFO: malformed broadcast payload (undefined) behaviour', async () => {
  let onMsg: (m: { payload: unknown }) => void = () => {};
  const channel = { on: vi.fn((_t, _f, cb) => { onMsg = cb; return channel; }), subscribe: vi.fn(() => channel) };
  const client = { channel: vi.fn(() => channel), removeChannel: vi.fn() };
  const delivered: unknown[] = [];
  const stop = createSupabaseEventSource(client as never, 'abc', async () => []).listen(e => delivered.push(...e), () => {});
  let threw: string | null = null; try { onMsg({ payload: undefined }); } catch (e) { threw = (e as Error).constructor.name; }
  let threw2: string | null = null; try { onMsg({ payload: { runId: 'x' } }); } catch (e) { threw2 = (e as Error).constructor.name; }
  log('P9 INFO', { undefinedPayloadThrows: threw, partialPayloadDelivered: delivered.length, partialThrows: threw2 });
  stop();
});

it('P10 INFO: a throwing deliver() during poll is treated as a poll failure and the batch is marked seen', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let calls = 0; const conn: boolean[] = [];
  const poll = vi.fn(async () => [ev('d', 1)]);
  const stop = createEventSource({ subscribe: () => () => {}, poll }, 'c').listen(() => { calls++; if (calls === 1) throw new Error('render bug'); }, o => conn.push(o));
  await vi.advanceTimersByTimeAsync(30_000);
  log('P10 INFO', { deliverCalls: calls, polls: poll.mock.calls.length, conn });
  stop();
});
