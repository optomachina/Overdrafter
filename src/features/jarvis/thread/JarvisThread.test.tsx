import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphEvent } from '../core/types';
import { JarvisThread } from './JarvisThread';
import type { EventSource } from './event-source';

afterEach(cleanup);
const base = { runId: 'run', at: 1000, nodeId: 'domain_agent' as const };
const decision: GraphEvent = { ...base, seq: 2, type: 'decision_requested', decisionId: 'd', question: 'Thickness?', options: ['Thin', 'Thick'], recommended: 'Thin', bestGuess: 'Thick', timeoutMs: 60000 };
function setup() {
  let push: (events: GraphEvent[]) => void = () => { };
  const source: EventSource = { listen: fn => { push = fn; return () => { }; }, retry: vi.fn() };
  const client = { resolve: vi.fn().mockResolvedValue({ status: 200 }), control: vi.fn().mockResolvedValue({ status: 202 }) };
  render(<JarvisThread source={source} client={client} runId="run" />);
  return { client, send: (...events: GraphEvent[]) => act(() => push(events)) };
}
const artifact = (seq: number, kind: 'png' | 'glb' | 'step'): Extract<GraphEvent, { type: 'artifact' }> => ({ ...base, seq, type: 'artifact', agentId: 'cad', kind, name: kind, mimeType: '', uri: `/${kind}`, dimensionsMm: { x: 101.6, y: 101.6, z: 6.35 } });

describe('web thread', () => {
  it('T1 renders status, decision, then result pictures', () => {
    const s = setup();
    s.send({ ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' });
    expect(screen.getByText('Making plate')).toBeTruthy();
    s.send(decision); expect(screen.getByRole('radiogroup')).toBeTruthy();
    s.send(artifact(3, 'png'), artifact(4, 'glb'), artifact(5, 'step'), { ...base, seq: 6, type: 'result', nodeId: 'result', agentId: 'cad', summary: 'Plate ready', picks: {}, artifacts: [{ kind: 'png', uri: '/png' }, { kind: 'glb', uri: '/glb' }, { kind: 'step', uri: '/step' }] });
    expect(screen.getByText('Plate ready')).toBeTruthy(); expect(screen.getByRole('img', { name: 'Iso' })).toBeTruthy();
    expect(screen.getByText('4.000 × 4.000 × 0.250 in')).toBeTruthy();
  });
  it('T2 and T3 skips once and waits for the server recorded guess and rationale', async () => {
    const s = setup(); s.send(decision);
    const skip = screen.getByRole('button', { name: 'SKIP' }); fireEvent.click(skip); fireEvent.click(skip);
    expect(s.client.resolve).toHaveBeenCalledTimes(1);
    expect(s.client.resolve).toHaveBeenCalledWith('run', 'd', expect.objectContaining({ resolution: 'skipped_best_guess', idempotencyKey: expect.any(String) }));
    expect(screen.queryByText(/Best guess recorded/)).toBeNull();
    s.send({ ...base, seq: 3, type: 'decision_resolved', decisionId: 'd', choice: 'Server value', rationale: 'Server rationale', outcome: 'skipped_best_guess', cause: 'skip' });
    expect(screen.getByText('Best guess recorded · Server value')).toBeTruthy(); expect(screen.getByText('Server rationale')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Change')).toBeTruthy());
  });
  it('T3 Choose submits once with radio arrow selection', () => {
    const s = setup(); s.send(decision);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Thick' }), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Thin' }), { key: 'ArrowRight' });
    const approve = screen.getByRole('button', { name: 'APPROVE Thick' }); fireEvent.click(approve); fireEvent.click(approve);
    expect(s.client.resolve).toHaveBeenCalledTimes(1); expect(s.client.resolve).toHaveBeenCalledWith('run', 'd', expect.objectContaining({ resolution: 'chosen', choice: 'Thick' }));
  });
  it('T5 a forbidden resolve leaves the decision open and selected value unchanged', async () => {
    const s = setup(); s.client.resolve.mockResolvedValue({ status: 403 }); s.send(decision);
    fireEvent.click(screen.getByRole('button', { name: 'SKIP' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '403 · This decision could not be resolved.');
    expect(screen.getByRole('radio', { name: 'Thin' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText(/Best guess recorded/)).toBeNull(); expect(screen.getByRole('button', { name: 'SKIP' }).hasAttribute('disabled')).toBe(false);
  });
  it('T7 pause is submitted once and remains pausing until checkpoint', () => {
    const s = setup(); s.send({ ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' });
    const pause = screen.getByRole('button', { name: 'PAUSE' }); fireEvent.click(pause); fireEvent.click(pause);
    expect(s.client.control).toHaveBeenCalledTimes(1); expect(s.client.control).toHaveBeenCalledWith('run', { kind: 'pause', idempotencyKey: expect.any(String) });
    expect(screen.getByRole('button', { name: 'Pausing' })).toBeTruthy();
    s.send({ ...base, seq: 2, type: 'control_applied', commandId: 'c', checkpoint: 'agent', kind: 'pause', state: 'paused' });
    expect(screen.getByText('You paused the job at a checkpoint.')).toBeTruthy();
  });
  it('T7 and T8 cancel confirms once and lists exactly the kept artifacts', () => {
    const s = setup(); s.send({ ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' }, artifact(2, 'glb'));
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'KEEP COOKING' }));
    const cancel = screen.getByRole('button', { name: 'CANCEL REQUEST' }); fireEvent.click(cancel); fireEvent.click(cancel);
    expect(s.client.control).toHaveBeenCalledTimes(1); expect(s.client.control).toHaveBeenCalledWith('run', { kind: 'cancel', idempotencyKey: expect.any(String) });
    s.send({ ...base, seq: 3, type: 'control_applied', commandId: 'c', checkpoint: 'agent', kind: 'cancel', state: 'cancelled', kept: [{ kind: 'step', uri: '/kept.step' }] });
    expect(screen.getByText('Work kept')).toBeTruthy(); expect(screen.getByRole('link', { name: 'DOWNLOAD STEP' }).getAttribute('href')).toBe('/kept.step'); expect(screen.queryByRole('button', { name: 'OPEN 3D VIEW' })).toBeNull();
  });
  it('deduplicates by run and sequence and ignores other runs', () => {
    const s = setup(); s.send(decision, decision, { ...decision, runId: 'other' });
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
  });
  it('renders empty, CAD failure and rejected controls', () => {
    const s = setup(); expect(screen.getByText(/No requests yet/)).toBeTruthy();
    s.send({ ...base, seq: 1, type: 'error', code: 'agent_failed', message: 'No model returned' }, { ...base, seq: 2, type: 'control_rejected', commandId: 'c', kind: 'pause', reason: 'terminal' });
    expect(screen.getByRole('alert').textContent).toContain('No model returned'); expect(screen.getByText('Control rejected · terminal')).toBeTruthy();
  });
});

it('renders remote control requests and offline retry without enabling commands', () => {
  let push: (events: GraphEvent[]) => void = () => {};
  let connection: (offline: boolean) => void = () => {};
  const retry = vi.fn();
  const source: EventSource = { retry, listen: (e, c) => { push = e; connection = c; return () => {}; } };
  render(<JarvisThread runId="run" source={source} client={{ resolve: vi.fn(), control: vi.fn() }} />);
  act(() => push([{ ...base, seq: 1, type: 'control_requested', kind: 'pause', commandId: 'c', actorId: 'owner', idempotencyKey: 'k' }]));
  expect(screen.getByText('Pausing · Waiting for checkpoint')).toBeTruthy();
  act(() => connection(true));
  expect(screen.getByText(/Offline · Working none · Committed none/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'CANCEL' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'RETRY' })); expect(retry).toHaveBeenCalledOnce();
});
it('announces only stage and state while the elapsed timer advances', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(11000);
    const s = setup();
    s.send({ ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' });
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(document.querySelector('.jt-log')?.hasAttribute('aria-live')).toBe(false);
    expect(live.textContent).toBe('CAD model · started');
    expect(screen.getByText('WORKING · 10s')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('WORKING · 11s')).toBeTruthy();
    expect(live.textContent).toBe('CAD model · started');
    s.send({ ...base, seq: 2, nodeId: 'verify', type: 'status', state: 'started', message: 'Checking' });
    expect(live.textContent).toBe('Independent check · started');
  } finally { vi.useRealTimers(); }
});

it.each(['control_applied', 'control_rejected'] as const)('renews cancel keys after %s, with insecure-origin crypto fallback', type => {
  const uuid = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw new Error('unexpected UUID call'); });
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  try {
    const s = setup();
    s.send({ ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' });
    const cancel = () => {
      fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
      fireEvent.click(screen.getByRole('button', { name: 'CANCEL REQUEST' }));
    };
    cancel();
    s.send(type === 'control_applied'
      ? { ...base, seq: 2, type, kind: 'cancel', commandId: 'c', checkpoint: 'agent', state: 'cancelled', kept: [] }
      : { ...base, seq: 2, type, kind: 'cancel', commandId: 'c', reason: 'terminal' });
    // A subsequent server status/request permits another cancel command.
    s.send({ ...base, seq: 3, type: 'control_requested', kind: 'pause', commandId: 'next', actorId: 'owner', idempotencyKey: 'remote' });
    cancel();
    const keys = s.client.control.mock.calls.map(call => call[1].idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[a-f0-9]{32}$/);
    expect(keys[1]).not.toBe(keys[0]);
  } finally { uuid.mockRestore(); }
});

it('drops unsafe event, result and kept artifact URLs', () => {
  const s = setup();
  s.send({ ...artifact(1, 'png'), uri: 'javascript:alert(1)' }, {
    ...base, seq: 2, type: 'result', nodeId: 'result', agentId: 'cad', summary: 'Ready', picks: {},
    artifacts: [{ kind: 'step', uri: 'javascript:alert(1)' }, { kind: 'png', uri: 'data:image/png,bad' }, { kind: 'glb', uri: 'https://example.com/model.glb' }],
  });
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.queryByRole('link', { name: 'DOWNLOAD STEP' })).toBeNull();
  expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.com/model.glb');
  s.send({ ...base, seq: 3, type: 'control_applied', commandId: 'c', checkpoint: 'agent', kind: 'cancel', state: 'cancelled', kept: [{ kind: 'step', uri: 'javascript:alert(1)' }] });
  expect(screen.queryByRole('link')).toBeNull();
});
