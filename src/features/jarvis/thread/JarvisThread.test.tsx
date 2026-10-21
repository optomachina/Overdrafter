import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphEvent } from '../core/types';
import { JarvisThread } from './JarvisThread';
import type { ThreadClient } from './client';
import type { EventSource } from './event-source';
import { createPreview } from './preview-source';
import { readFileSync } from 'node:fs';

afterEach(cleanup);
// vitest stubs CSS imports, so read the stylesheet source for the layout contract test.
const css = readFileSync('src/features/jarvis/thread/thread.css', 'utf8');
const base = { runId: 'run', at: 1000, nodeId: 'domain_agent' as const };
const decision: GraphEvent = { ...base, seq: 2, type: 'decision_requested', decisionId: 'd', question: 'Thickness?', options: ['Thin', 'Thick'], recommended: 'Thin', bestGuess: 'Thick', timeoutMs: 60000 };
function setup() {
  let push: (events: GraphEvent[]) => void = () => { };
  const source: EventSource = { listen: fn => { push = fn; return () => { }; }, retry: vi.fn() };
  const client = { resolve: vi.fn().mockResolvedValue({ status: 200 }), control: vi.fn().mockResolvedValue({ status: 202 }) };
  render(<JarvisThread source={source} client={client} runId="run" />);
  return { client, send: (...events: GraphEvent[]) => act(() => push(events)) };
}
const artifact = (seq: number, kind: 'png' | 'glb' | 'step' | 'usdz'): Extract<GraphEvent, { type: 'artifact' }> => ({ ...base, seq, type: 'artifact', agentId: 'cad', kind, name: kind, mimeType: '', uri: `/${kind}`, dimensionsMm: { x: 101.6, y: 101.6, z: 6.35 } });

// The server answers every command with control_requested, echoing the idempotency key the tab sent, then applied or rejected under the same commandId.
const requested = (seq: number, kind: 'pause' | 'cancel', commandId: string, idempotencyKey = commandId): GraphEvent => ({ ...base, seq, type: 'control_requested', kind, commandId, actorId: 'owner', idempotencyKey });
const rejected = (seq: number, kind: 'pause' | 'cancel', commandId: string, reason: 'terminal' | 'duplicate' | 'cancel_pending' | 'superseded'): GraphEvent => ({ ...base, seq, type: 'control_rejected', kind, commandId, reason });
const sentKey = (client: { control: ReturnType<typeof vi.fn> }, call = 0): string => client.control.mock.calls[call][1].idempotencyKey;

describe('web thread', () => {
  it('T1 renders status, decision, then result pictures', () => {
    const s = setup();
    s.send({ ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' });
    expect(screen.getByText('Making plate')).toBeTruthy();
    s.send(decision); expect(screen.getByRole('radiogroup')).toBeTruthy();
    s.send(artifact(3, 'png'), artifact(4, 'glb'), artifact(5, 'step'), { ...base, seq: 6, type: 'result', nodeId: 'result', agentId: 'cad', summary: 'Plate ready', picks: {}, artifacts: [{ kind: 'png', uri: '/png' }, { kind: 'glb', uri: '/glb' }, { kind: 'step', uri: '/step' }] });
    expect(screen.getByRole('heading', { name: 'Plate ready' })).toBeTruthy(); expect(screen.getByRole('img', { name: 'Iso' })).toBeTruthy();
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
  it('T8 a paused run keeps its partial artifacts visible', () => {
    const s = setup();
    s.send({ ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' }, artifact(2, 'png'), artifact(3, 'step'));
    s.send({ ...base, seq: 4, type: 'control_applied', commandId: 'c', checkpoint: 'agent', kind: 'pause', state: 'paused' });
    expect(screen.getByText('You paused the job at a checkpoint.')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Iso' }).getAttribute('src')).toBe('/png');
    expect(screen.getByRole('link', { name: 'DOWNLOAD STEP' }).getAttribute('href')).toBe('/step');
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

// Only a rejection can renew the cancel key: an applied cancel ends the run and removes CANCEL (covered below).
it('renews the cancel key after control_rejected, with insecure-origin crypto fallback', () => {
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
    s.send(requested(2, 'cancel', 'c', sentKey(s.client)), rejected(3, 'cancel', 'c', 'terminal'));
    // Another tab's pause request does not keep this tab from sending a fresh cancel.
    s.send(requested(4, 'pause', 'next', 'remote'));
    cancel();
    const keys = s.client.control.mock.calls.map(call => call[1].idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[a-f0-9]{32}$/);
    expect(keys[1]).not.toBe(keys[0]);
  } finally { uuid.mockRestore(); }
});
it('releases the in-flight lock when the pause is applied, so CANCEL can still be sent', () => {
  const s = setup(); s.send({ ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' });
  fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
  expect(screen.getByRole('button', { name: 'CANCEL' }).hasAttribute('disabled')).toBe(true);
  s.send(requested(2, 'pause', 'c', sentKey(s.client)), { ...base, seq: 3, type: 'control_applied', commandId: 'c', checkpoint: 'agent', kind: 'pause', state: 'paused' });
  fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
  fireEvent.click(screen.getByRole('button', { name: 'CANCEL REQUEST' }));
  expect(s.client.control.mock.calls.map(call => call[1].kind)).toEqual(['pause', 'cancel']);
});

describe('a later command does not undo an applied control', () => {
  const started: GraphEvent = { ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' };
  const live = () => document.querySelector('[aria-live="polite"]')?.textContent;
  // What the graph emits when another command targets a run that already stopped.
  const later = (seq: number, kind: 'pause' | 'cancel', reason: 'terminal' | 'duplicate'): [GraphEvent, GraphEvent] => [
    { ...base, seq, type: 'control_requested', kind, commandId: `late-${kind}`, actorId: 'owner', idempotencyKey: `late-${kind}` },
    { ...base, seq: seq + 1, type: 'control_rejected', kind, commandId: `late-${kind}`, reason },
  ];

  it.each(['pause', 'cancel'] as const)('a cancelled run keeps only the kept work and no controls when a later %s is rejected', kind => {
    const s = setup();
    s.send(started, artifact(2, 'png'), artifact(3, 'glb'), artifact(4, 'step'), { ...base, seq: 5, type: 'control_applied', commandId: 'c', checkpoint: 'agent', kind: 'cancel', state: 'cancelled', kept: [{ kind: 'step', uri: '/kept.step' }] });
    const expectCancelled = () => {
      expect(screen.getByRole('heading', { name: 'Work kept' })).toBeTruthy();
      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/kept.step', '/kept.step']);
      // The run is over: no PAUSE (whatever its label) and no CANCEL.
      expect(screen.queryAllByRole('button')).toEqual([]);
      expect(screen.getByText(/^cancelled · \d+s$/)).toBeTruthy();
      expect(live()).toBe('CAD model · cancelled');
    };
    expectCancelled();
    const [requested, rejected] = later(6, kind, 'terminal');
    s.send(requested); expectCancelled();
    s.send(rejected); expectCancelled();
    expect(screen.getByText('Control rejected · terminal')).toBeTruthy();
  });
  it('a paused run stays paused, with PAUSE still unavailable, when a repeated pause is rejected', () => {
    const s = setup();
    s.send(started, { ...base, seq: 2, type: 'control_applied', commandId: 'c', checkpoint: 'agent', kind: 'pause', state: 'paused' }, ...later(3, 'pause', 'duplicate'));
    expect(screen.getByRole('button', { name: 'paused' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'CANCEL' }).hasAttribute('disabled')).toBe(false);
    expect(live()).toBe('CAD model · paused');
  });
});

describe('a command stays queued until its own applied or rejected event', () => {
  const started: GraphEvent = { ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' };
  const pauseApplied = (seq: number, commandId: string): GraphEvent => ({ ...base, seq, type: 'control_applied', commandId, checkpoint: 'agent', kind: 'pause', state: 'paused' });
  const cancelApplied = (seq: number, commandId: string): GraphEvent => ({ ...base, seq, type: 'control_applied', commandId, checkpoint: 'agent', kind: 'cancel', state: 'cancelled', kept: [] });
  const live = () => document.querySelector('[aria-live="polite"]')?.textContent;
  const buttons = () => screen.queryAllByRole('button').map(b => `${b.textContent}${b.hasAttribute('disabled') ? ' (disabled)' : ''}`);
  const sendCancel = () => { fireEvent.click(screen.getByRole('button', { name: 'CANCEL' })); fireEvent.click(screen.getByRole('button', { name: 'CANCEL REQUEST' })); };
  // The run is cancelling: PAUSE shows the state, and nothing in the thread invites another command.
  const expectCancelling = () => {
    expect(buttons()).toEqual(['Cancelling (disabled)', 'CANCEL (disabled)']);
    expect(live()).toBe('CAD model · Cancelling');
    expect(screen.getByText(/^Cancelling · \d+s$/)).toBeTruthy();
  };

  describe.each([['cancel', 'duplicate'], ['pause', 'cancel_pending']] as const)('a cancel queued before a %s that is rejected as %s', (kind, reason) => {
    it('keeps showing Cancelling, with PAUSE and CANCEL unavailable, until the cancel is applied', () => {
      const s = setup();
      s.send(started, requested(2, 'cancel', 'queued-cancel'));
      expectCancelling();
      expect(screen.getByText('Cancelling · Waiting for checkpoint')).toBeTruthy();
      s.send(requested(3, kind, 'late'));
      expectCancelling();
      expect(screen.getByText('Cancelling · Waiting for checkpoint')).toBeTruthy();
      s.send(rejected(4, kind, 'late', reason));
      expectCancelling();
      expect(screen.getByText(`Control rejected · ${reason}`)).toBeTruthy();
      s.send(cancelApplied(5, 'queued-cancel'));
      expect(buttons()).toEqual([]);
      expect(screen.getByRole('heading', { name: 'Work kept' })).toBeTruthy();
      expect(screen.getByText(/^cancelled · \d+s$/)).toBeTruthy();
      expect(live()).toBe('CAD model · cancelled');
      expect(s.client.control).not.toHaveBeenCalled();
    });
  });

  it('keeps this tab\'s own cancel locked while another tab\'s pause is requested and rejected', () => {
    const s = setup(); s.send(started); sendCancel();
    s.send(requested(2, 'cancel', 'own-cancel', sentKey(s.client)));
    expectCancelling();
    s.send(requested(3, 'pause', 'remote-pause'));
    expectCancelling();
    s.send(rejected(4, 'pause', 'remote-pause', 'cancel_pending'));
    expectCancelling();
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(s.client.control).toHaveBeenCalledTimes(1);
    s.send(cancelApplied(5, 'own-cancel'));
    expect(screen.getByRole('heading', { name: 'Work kept' })).toBeTruthy();
    expect(buttons()).toEqual([]);
  });

  it('keeps Cancelling when the pause it superseded is rejected, as the graph does just before it applies the cancel', () => {
    const s = setup(); s.send(started);
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    s.send(requested(2, 'pause', 'own-pause', sentKey(s.client)));
    expect(buttons()).toEqual(['Pausing (disabled)', 'CANCEL (disabled)']);
    s.send(requested(3, 'cancel', 'remote-cancel'));
    expectCancelling();
    // The pause was this tab's own command, so this releases the tab's lock. The queued cancel must still hold the controls.
    s.send(rejected(4, 'pause', 'own-pause', 'superseded'));
    expectCancelling();
    s.send(cancelApplied(5, 'remote-cancel'));
    expect(screen.getByRole('heading', { name: 'Work kept' })).toBeTruthy();
    expect(buttons()).toEqual([]);
  });

  it('keeps Cancelling after a cancel queued behind an applied pause, through a rejected duplicate pause', () => {
    const s = setup(); s.send(started, pauseApplied(2, 'paused'));
    expect(buttons()).toEqual(['paused (disabled)', 'CANCEL']);
    s.send(requested(3, 'cancel', 'queued-cancel'));
    expectCancelling();
    s.send(requested(4, 'pause', 'late'), rejected(5, 'pause', 'late', 'cancel_pending'));
    expectCancelling();
    s.send(cancelApplied(6, 'queued-cancel'));
    expect(screen.getByRole('heading', { name: 'Work kept' })).toBeTruthy();
  });

  it('keeps showing paused while another tab\'s repeated pause waits for its rejection', () => {
    const s = setup(); s.send(started, pauseApplied(2, 'paused'), requested(3, 'pause', 'late'));
    expect(buttons()).toEqual(['paused (disabled)', 'CANCEL']);
    expect(live()).toBe('CAD model · paused');
    expect(screen.getByText('You paused the job at a checkpoint.')).toBeTruthy();
    s.send(rejected(4, 'pause', 'late', 'duplicate'));
    expect(buttons()).toEqual(['paused (disabled)', 'CANCEL']);
    expect(live()).toBe('CAD model · paused');
  });

  it('returns to the state it interrupted when the queued cancel is itself rejected', () => {
    const s = setup(); s.send(started, requested(2, 'cancel', 'queued-cancel'));
    expectCancelling();
    s.send(rejected(3, 'cancel', 'queued-cancel', 'terminal'));
    expect(buttons()).toEqual(['PAUSE', 'CANCEL']);
    expect(live()).toBe('CAD model · started');
    s.send(pauseApplied(4, 'paused'), requested(5, 'cancel', 'second-cancel'), rejected(6, 'cancel', 'second-cancel', 'terminal'));
    expect(buttons()).toEqual(['paused (disabled)', 'CANCEL']);
  });

  it('does not release this tab\'s in-flight pause when a different command is rejected', () => {
    const s = setup(); s.send(started);
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    s.send(requested(2, 'pause', 'own-pause', sentKey(s.client)), requested(3, 'pause', 'remote-pause'), rejected(4, 'pause', 'remote-pause', 'duplicate'));
    expect(buttons()).toEqual(['Pausing (disabled)', 'CANCEL (disabled)']);
    s.send(pauseApplied(5, 'own-pause'));
    expect(buttons()).toEqual(['paused (disabled)', 'CANCEL']);
    sendCancel();
    expect(s.client.control.mock.calls.map(call => call[1].kind)).toEqual(['pause', 'cancel']);
  });

  it('releases this tab\'s lock and renews its pause key when its own pause is rejected', () => {
    const s = setup(); s.send(started);
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    s.send(requested(2, 'pause', 'own-pause', sentKey(s.client)), rejected(3, 'pause', 'own-pause', 'terminal'));
    expect(buttons()).toEqual(['PAUSE', 'CANCEL']);
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    expect(s.client.control).toHaveBeenCalledTimes(2);
    expect(sentKey(s.client, 1)).not.toBe(sentKey(s.client, 0));
  });

  it('does not let the cancel confirmation send a second cancel once one is queued from another tab', () => {
    const s = setup(); s.send(started);
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    expect(screen.getByRole('button', { name: 'CANCEL REQUEST' }).hasAttribute('disabled')).toBe(false);
    s.send(requested(2, 'cancel', 'remote-cancel'));
    const confirm = screen.getByRole('button', { name: 'CANCEL REQUEST' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirm);
    expect(s.client.control).not.toHaveBeenCalled();
  });

  it('recognises its own command in the DEV preview, where the synthetic server echoes the key', () => {
    vi.useFakeTimers();
    try {
      render(<JarvisThread {...createPreview()} runId="plate-preview" />);
      fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
      act(() => { vi.advanceTimersByTime(800); });
      expect(buttons()).toEqual(['paused (disabled)', 'CANCEL']);
      sendCancel();
      expect(screen.getByText('Cancelling · Waiting for checkpoint')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(800); });
      expect(screen.getByRole('heading', { name: 'Work kept' })).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it('settles a command whose request arrives after its rejection in the same batch, by sequence', () => {
    const s = setup(); s.send(started, rejected(3, 'cancel', 'late-cancel', 'terminal'), requested(2, 'cancel', 'late-cancel'));
    expect(buttons()).toEqual(['PAUSE', 'CANCEL']);
  });
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
it('handles a usdz artifact event without mislabelling it as the GLB review view', () => {
  const s = setup();
  s.send(artifact(1, 'glb'), artifact(2, 'usdz'), artifact(3, 'step'));
  const links = screen.getAllByRole('link').map(link => [link.textContent, link.getAttribute('href')]);
  expect(links).toEqual(expect.arrayContaining([['.GLB REVIEW VIEW', '/glb'], ['.USDZ AR VIEW', '/usdz'], ['.STEP AUTHORITATIVE', '/step']]));
  expect(links.filter(([label]) => label === '.GLB REVIEW VIEW')).toHaveLength(1);
});

describe('pending decision with an applied pause or cancel', () => {
  const applied = (kind: 'pause' | 'cancel'): GraphEvent => kind === 'pause'
    ? { ...base, seq: 10, type: 'control_applied', commandId: 'c', checkpoint: 'agent', kind, state: 'paused' }
    : { ...base, seq: 10, type: 'control_applied', commandId: 'c', checkpoint: 'agent', kind, state: 'cancelled', kept: [] };
  const started: GraphEvent = { ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' };

  it('is actionable before any pause or cancel', () => {
    const s = setup(); s.send(started, decision);
    expect(screen.getByRole('button', { name: 'APPROVE Thin' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('WAITS FOR YOU')).toBeTruthy();
    expect(document.querySelector('.jt-log')?.classList.contains('jt-has-bar')).toBe(true);
  });
  it.each([['pause', 'paused'], ['cancel', 'cancelled']] as const)('removes the controls and bar and labels the lane after %s', (kind, state) => {
    const s = setup(); s.send(started, decision, applied(kind));
    expect(screen.queryByRole('button', { name: /APPROVE/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'SKIP' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(document.querySelector('.jt-actions')).toBeNull();
    expect(document.querySelector('.jt-has-bar')).toBeNull();
    expect(screen.queryByText('WAITS FOR YOU')).toBeNull();
    expect(screen.getByText(state.toUpperCase())).toBeTruthy();
    expect(screen.getByText(`No choice was recorded. The job is ${state}.`)).toBeTruthy();
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(state);
    expect(s.client.resolve).not.toHaveBeenCalled();
  });
  it('stays unanswerable when a cancel is requested after the pause was applied', () => {
    const s = setup(); s.send(started, decision, applied('pause'), { ...base, seq: 11, type: 'control_requested', kind: 'cancel', commandId: 'd', actorId: 'owner', idempotencyKey: 'k' });
    expect(screen.queryByRole('button', { name: /APPROVE/ })).toBeNull();
  });
  it('announces the result in the live region', () => {
    const s = setup(); s.send(started, { ...base, seq: 5, type: 'result', nodeId: 'result', agentId: 'cad', summary: 'Plate review ready', picks: {}, artifacts: [] });
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Plate review ready');
  });
});

describe('fixed decision bar layout contract (jsdom has no layout; the real-browser measurement is in the PR notes)', () => {
  it('shares one bar-height property between the bar and the log reserve, and keeps the in-flow reserve', () => {
    expect(css).toMatch(/\.jt-actions\s*\{[^}]*height:\s*var\(--jt-bar-h\)/);
    expect(css).toMatch(/\.jt-actions\s*\{[^}]*bottom:\s*calc\(var\(--jt-footer-h\) \+ var\(--jt-safe-b\)\)/);
    expect(css).toMatch(/\.jt-log\.jt-has-bar\s*\{\s*padding-bottom:\s*calc\(var\(--jt-bar-h\) \+ 16px\)/);
    expect(css).toMatch(/\.jt footer\s*\{[^}]*min-height:\s*calc\(var\(--jt-footer-h\) \+ var\(--jt-safe-b\)\)/);
    // No bottom padding on the root, so the sticky footer ends at the viewport edge and the bar sits exactly on it.
    expect(css).toMatch(/\.jt\s*\{[^}]*padding:\s*16px 16px 0;/);
    expect(css).toMatch(/--jt-bar-h:\s*\d+px/);
  });
  it('only reserves the bar space while a decision is pending and unresolved', () => {
    const s = setup(); s.send(decision);
    expect(document.querySelector('.jt-log')?.classList.contains('jt-has-bar')).toBe(true);
    s.send({ ...base, seq: 3, type: 'decision_resolved', decisionId: 'd', choice: 'Thin', rationale: 'r', outcome: 'chosen' });
    expect(document.querySelector('.jt-log')?.classList.contains('jt-has-bar')).toBe(false);
  });
});

it('confirming CANCEL REQUEST moves focus to the heading, not body, because the opener is disabled in flight', () => {
  const s = setup(); s.send({ ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' });
  const opener = screen.getByRole('button', { name: 'CANCEL' }); opener.focus(); fireEvent.click(opener);
  fireEvent.click(screen.getByRole('button', { name: 'CANCEL REQUEST' }));
  expect(screen.getByRole('button', { name: 'CANCEL' }).hasAttribute('disabled')).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Jarvis', level: 1 }));
  expect(document.activeElement).not.toBe(document.body);
});
it.each(['KEEP COOKING', 'Close dialog', 'Escape'] as const)('dismissing the cancel sheet via %s restores focus to CANCEL', way => {
  const s = setup(); s.send({ ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' });
  const opener = screen.getByRole('button', { name: 'CANCEL' }); opener.focus(); fireEvent.click(opener);
  if (way === 'Escape') fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); else fireEvent.click(screen.getByRole('button', { name: way }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(s.client.control).not.toHaveBeenCalled();
});

it('closes an open cancel confirmation when the run changes so it cannot cancel the new run', () => {
  let push: (events: GraphEvent[]) => void = () => { };
  const source: EventSource = { listen: fn => { push = fn; return () => { }; }, retry: vi.fn() };
  const client = { resolve: vi.fn(), control: vi.fn().mockResolvedValue({ status: 202 }) };
  const view = render(<JarvisThread source={source} client={client} runId="run" />);
  act(() => push([{ ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' }]));
  fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  view.rerender(<JarvisThread source={source} client={client} runId="other" />);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(client.control).not.toHaveBeenCalled();
});

// A control request outlives a run switch. Its result belongs to the run it was issued for, so it must never release the lock,
// clear the pending state or show an error on the run that is on screen now.
describe('a control result that arrives after the run changed', () => {
  type Reply = { status: number };
  type Deferred = { promise: Promise<Reply>; settle: (reply: Reply) => void; fail: (reason: unknown) => void };
  const deferred = (): Deferred => {
    let settle: Deferred['settle'] = () => { }, fail: Deferred['fail'] = () => { };
    const promise = new Promise<Reply>((resolve, reject) => { settle = resolve; fail = reject; });
    return { promise, settle, fail };
  };
  const started = (runId: string): GraphEvent => ({ ...base, runId, seq: 1, type: 'status', state: 'started', message: `Making plate ${runId}` });
  const buttons = () => screen.queryAllByRole('button').map(b => `${b.textContent}${b.hasAttribute('disabled') ? ' (disabled)' : ''}`);
  const idle = ['PAUSE', 'CANCEL'];
  const pausing = ['Pausing (disabled)', 'CANCEL (disabled)'];
  const failed = 'Control request failed. Try again.';

  // The source hands each listener its own push, as a per-run subscription does; only the newest listener belongs to the shown run.
  function mount() {
    const pushes: ((events: GraphEvent[]) => void)[] = [];
    const source: EventSource = { listen: fn => { pushes.push(fn); return () => { }; }, retry: vi.fn() };
    const replies: Deferred[] = [];
    const client = { resolve: vi.fn(), control: vi.fn<ThreadClient['control']>(() => { const reply = deferred(); replies.push(reply); return reply.promise; }) };
    const view = render(<JarvisThread source={source} client={client} runId="run" />);
    return {
      client, replies,
      show: (runId: string) => view.rerender(<JarvisThread source={source} client={client} runId={runId} />),
      deliver: (...events: GraphEvent[]) => act(() => pushes[pushes.length - 1](events)),
    };
  }

  it.each([
    ['rejects', (reply: Deferred) => reply.fail(new Error('network down'))],
    ['answers with an error status', (reply: Deferred) => reply.settle({ status: 500 })],
  ] as const)('does not release the other run\'s in-flight control when the old request %s', async (_how, fail) => {
    const m = mount();
    m.deliver(started('run'));
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    expect(m.client.control).toHaveBeenLastCalledWith('run', { kind: 'pause', idempotencyKey: expect.any(String) });
    m.show('other'); m.deliver(started('other'));
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    expect(m.client.control).toHaveBeenLastCalledWith('other', { kind: 'pause', idempotencyKey: expect.any(String) });
    expect(buttons()).toEqual(pausing);

    await act(async () => fail(m.replies[0]));
    expect(buttons()).toEqual(pausing);
    expect(screen.queryByRole('alert')).toBeNull();
    // Only the new run's own result may release it.
    await act(async () => m.replies[1].fail(new Error('network down')));
    expect(buttons()).toEqual(idle);
    expect(screen.getByRole('alert').textContent).toBe(failed);
  });

  it('still releases a run\'s own control when its request fails while that run is shown, and retries with the same key', async () => {
    const m = mount();
    m.deliver(started('run'));
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    expect(buttons()).toEqual(pausing);
    await act(async () => m.replies[0].fail(new Error('network down')));
    expect(buttons()).toEqual(idle);
    expect(screen.getByRole('alert').textContent).toBe(failed);
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    expect(m.client.control.mock.calls[1][1].idempotencyKey).toBe(m.client.control.mock.calls[0][1].idempotencyKey);
  });

  it('shows no error on the new run for a request that failed after the switch, and leaves its controls usable', async () => {
    const m = mount();
    m.deliver(started('run'));
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    m.show('other'); m.deliver(started('other'));
    expect(buttons()).toEqual(idle);
    await act(async () => m.replies[0].fail(new Error('network down')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(buttons()).toEqual(idle);
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    expect(m.client.control).toHaveBeenCalledTimes(2);
    expect(m.client.control).toHaveBeenLastCalledWith('other', { kind: 'pause', idempotencyKey: expect.any(String) });
  });

  it('drops the error the old run was showing when the run changes', async () => {
    const m = mount();
    m.deliver(started('run'));
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    await act(async () => m.replies[0].fail(new Error('network down')));
    expect(screen.getByRole('alert').textContent).toBe(failed);
    m.show('other'); m.deliver(started('other'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a request from an earlier visit to the same run from releasing the current visit', async () => {
    const m = mount();
    m.deliver(started('run'));
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    m.show('other'); m.show('run'); m.deliver(started('run'));
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    expect(m.client.control).toHaveBeenCalledTimes(2);
    expect(buttons()).toEqual(pausing);
    await act(async () => m.replies[0].fail(new Error('network down')));
    expect(buttons()).toEqual(pausing);
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => m.replies[1].fail(new Error('network down')));
    expect(buttons()).toEqual(idle);
    expect(screen.getByRole('alert').textContent).toBe(failed);
  });

  // The run epoch cannot tell two requests of one run apart. A request the server already settled (its key is gone) must not release the
  // lock of the command sent after it, because the late failure is about the settled request, not the one that is still waiting.
  describe('within the same run', () => {
    const paused = ['paused (disabled)', 'CANCEL'];
    const cancelling = ['Cancelling (disabled)', 'CANCEL (disabled)'];
    const settledPause = (key: string, how: 'applied' | 'rejected'): GraphEvent[] => [
      requested(2, 'pause', 'own-pause', key),
      how === 'applied'
        ? { ...base, seq: 3, type: 'control_applied', commandId: 'own-pause', checkpoint: 'agent', kind: 'pause', state: 'paused' }
        : rejected(3, 'pause', 'own-pause', 'terminal'),
    ];
    const confirmCancel = () => { fireEvent.click(screen.getByRole('button', { name: 'CANCEL' })); fireEvent.click(screen.getByRole('button', { name: 'CANCEL REQUEST' })); };

    it.each([
      ['rejects', (reply: Deferred) => reply.fail(new Error('network down'))],
      ['answers with an error status', (reply: Deferred) => reply.settle({ status: 500 })],
    ] as const)('keeps a cancel locked when the pause that was already applied %s late', async (_how, fail) => {
      const m = mount();
      m.deliver(started('run'));
      fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
      m.deliver(...settledPause(sentKey(m.client), 'applied'));
      expect(buttons()).toEqual(paused);
      confirmCancel();
      expect(m.client.control.mock.calls.map(call => call[1].kind)).toEqual(['pause', 'cancel']);
      expect(buttons()).toEqual(cancelling);

      await act(async () => fail(m.replies[0]));
      expect(buttons()).toEqual(cancelling);
      expect(screen.queryByRole('alert')).toBeNull();
      // Only the cancel's own failure may release the cancel, and then it retries with the key it already sent.
      await act(async () => m.replies[1].fail(new Error('network down')));
      expect(buttons()).toEqual(paused);
      expect(screen.getByRole('alert').textContent).toBe(failed);
      confirmCancel();
      expect(sentKey(m.client, 2)).toBe(sentKey(m.client, 1));
    });

    it('keeps a cancel locked when the pause that was already rejected fails late', async () => {
      const m = mount();
      m.deliver(started('run'));
      fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
      m.deliver(...settledPause(sentKey(m.client), 'rejected'));
      expect(buttons()).toEqual(idle);
      confirmCancel();
      expect(buttons()).toEqual(cancelling);

      await act(async () => m.replies[0].fail(new Error('network down')));
      expect(buttons()).toEqual(cancelling);
      expect(screen.queryByRole('alert')).toBeNull();
      await act(async () => m.replies[1].fail(new Error('network down')));
      expect(buttons()).toEqual(idle);
      expect(screen.getByRole('alert').textContent).toBe(failed);
    });

    it('lets the cancel settle normally after a late failure of the settled pause', async () => {
      const m = mount();
      m.deliver(started('run'));
      fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
      m.deliver(...settledPause(sentKey(m.client), 'applied'));
      confirmCancel();
      await act(async () => m.replies[0].fail(new Error('network down')));
      m.deliver(requested(4, 'cancel', 'own-cancel', sentKey(m.client, 1)), { ...base, seq: 5, type: 'control_applied', commandId: 'own-cancel', checkpoint: 'agent', kind: 'cancel', state: 'cancelled', kept: [] });
      expect(screen.getByRole('heading', { name: 'Work kept' })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      await act(async () => m.replies[1].settle({ status: 202 }));
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

it('orders events by sequence when batches arrive out of order', () => {
  const s = setup();
  s.send({ ...base, seq: 2, type: 'status', state: 'started', message: 'Second stage' });
  s.send({ ...base, seq: 1, type: 'status', state: 'started', nodeId: 'concept_picks', message: 'First stage' });
  expect(screen.getByText('Second stage')).toBeTruthy();
  expect(screen.queryByText('First stage')).toBeNull();
});
it('stops listening to the source when it unmounts or the run changes', () => {
  const unsubscribe = vi.fn();
  const source: EventSource = { listen: () => unsubscribe, retry: vi.fn() };
  const client = { resolve: vi.fn(), control: vi.fn() };
  const view = render(<JarvisThread source={source} client={client} runId="run" />);
  view.rerender(<JarvisThread source={source} client={client} runId="other" />);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});

// A run that ended (failed, cancelled or completed) has nothing left to time. The lanes read a clock frozen at the ending event,
// the interval stops, and the lane the run ended in names how it ended instead of staying WORKING.
describe('a run that ended stops its clock and shows how it ended', () => {
  afterEach(() => vi.useRealTimers());
  const status = (seq: number, nodeId: 'concept_picks' | 'domain_agent' | 'verify', state: 'started' | 'completed', at = 1000): GraphEvent => ({ ...base, seq, at, nodeId, type: 'status', state, message: `${nodeId} ${state}` });
  const error = (seq: number, at: number, nodeId: 'domain_agent' | 'verify' = 'domain_agent'): GraphEvent => ({ ...base, seq, at, nodeId, type: 'error', code: nodeId === 'verify' ? 'verify_failed' : 'agent_failed', message: 'No model returned' });
  const lanes = () => [...document.querySelectorAll('.jt-lanes li')].map(li => li.lastElementChild?.textContent);
  const live = () => document.querySelector('[aria-live="polite"]')?.textContent;

  it('turns WORKING into FAILED at the error and stops counting', () => {
    vi.useFakeTimers(); vi.setSystemTime(11000);
    const s = setup(); s.send(status(1, 'domain_agent', 'started'));
    expect(lanes()).toEqual(['WAITING', 'WORKING · 10s', 'WAITING']);
    expect(live()).toBe('CAD model · started');
    // The error is stamped 5s after the stage started, though the clock on the wall is further on: the lane reads the error's time.
    act(() => vi.advanceTimersByTime(2000));
    s.send(error(2, 6000));
    expect(lanes()).toEqual(['WAITING', 'FAILED · 5s', 'WAITING']);
    expect(screen.queryByText(/WORKING/)).toBeNull();
    expect(live()).toBe('CAD model · failed');
    expect(screen.getByRole('alert').textContent).toBe('CAD: FAIL · No model returned');
    act(() => vi.advanceTimersByTime(30000));
    expect(lanes()).toEqual(['WAITING', 'FAILED · 5s', 'WAITING']);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('marks the lane the graph failed in and keeps the stages it finished as DONE', () => {
    vi.useFakeTimers(); vi.setSystemTime(11000);
    const s = setup();
    s.send(status(1, 'concept_picks', 'started'), status(2, 'concept_picks', 'completed'), status(3, 'domain_agent', 'started'), status(4, 'domain_agent', 'completed'), status(5, 'verify', 'started'));
    expect(lanes()).toEqual(['DONE', 'DONE', 'WORKING · 10s']);
    s.send(error(6, 4000, 'verify'));
    expect(lanes()).toEqual(['DONE', 'DONE', 'FAILED · 3s']);
    expect(live()).toBe('Independent check · failed');
    act(() => vi.advanceTimersByTime(30000));
    expect(lanes()).toEqual(['DONE', 'DONE', 'FAILED · 3s']);
  });
  it('shows FAILED, not a pending command, when the run failed with a pause still queued behind the error', () => {
    vi.useFakeTimers(); vi.setSystemTime(11000);
    const s = setup(); s.send(status(1, 'domain_agent', 'started'), requested(2, 'pause', 'queued'));
    expect(lanes()[1]).toBe('Pausing · 10s');
    // The graph answers every command still queued when it fails with a terminal rejection, after the error itself.
    s.send(error(3, 4000));
    expect(lanes()[1]).toBe('FAILED · 3s');
    expect(live()).toBe('CAD model · failed');
    s.send(rejected(4, 'pause', 'queued', 'terminal'));
    expect(lanes()[1]).toBe('FAILED · 3s');
    expect(screen.getByText('Control rejected · terminal')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
  it('shows FAILED without a timer when the error is the first thing the lane has heard', () => {
    const s = setup(); s.send(error(1, 1000));
    expect(lanes()).toEqual(['WAITING', 'FAILED', 'WAITING']);
    expect(screen.queryByText(/WORKING/)).toBeNull();
  });
  it('stops the timer of a cancelled run at the cancel', () => {
    vi.useFakeTimers(); vi.setSystemTime(11000);
    const s = setup(); s.send(status(1, 'domain_agent', 'started'));
    expect(lanes()[1]).toBe('WORKING · 10s');
    s.send({ ...base, seq: 2, at: 4000, type: 'control_applied', commandId: 'c', checkpoint: 'agent', kind: 'cancel', state: 'cancelled', kept: [] });
    expect(lanes()[1]).toBe('cancelled · 3s');
    act(() => vi.advanceTimersByTime(30000));
    expect(lanes()[1]).toBe('cancelled · 3s');
    expect(live()).toBe('CAD model · cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('shows no timer and stops the interval once the run completed', () => {
    vi.useFakeTimers(); vi.setSystemTime(11000);
    const s = setup(); s.send(status(1, 'domain_agent', 'started'));
    expect(vi.getTimerCount()).toBe(1);
    s.send({ ...base, seq: 2, at: 5000, type: 'result', nodeId: 'result', agentId: 'cad', summary: 'Plate ready', picks: {}, artifacts: [] });
    expect(lanes()).toEqual([]);
    expect(screen.queryByText(/WORKING|\d+s$/)).toBeNull();
    expect(live()).toBe('Plate ready');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('starts the clock again for the next run after a run ended', () => {
    vi.useFakeTimers(); vi.setSystemTime(11000);
    let push: (events: GraphEvent[]) => void = () => { };
    const source: EventSource = { listen: fn => { push = fn; return () => { }; }, retry: vi.fn() };
    const client = { resolve: vi.fn(), control: vi.fn() };
    const view = render(<JarvisThread source={source} client={client} runId="run" />);
    act(() => push([status(1, 'domain_agent', 'started'), error(2, 6000)]));
    expect(lanes()[1]).toBe('FAILED · 5s');
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(<JarvisThread source={source} client={client} runId="other" />);
    act(() => push([{ ...status(1, 'domain_agent', 'started'), runId: 'other' }]));
    expect(lanes()[1]).toBe('WORKING · 10s');
    act(() => vi.advanceTimersByTime(1000));
    expect(lanes()[1]).toBe('WORKING · 11s');
  });
});

// A request whose reply was lost shows "Try again" while the server may still have received it. The server's own answer for that
// command, echoed with this tab's key, is the truth, so the alert ends there instead of contradicting an applied or rejected command.
describe('the transport alert ends when this tab\'s own command settles', () => {
  const lost = 'Control request failed. Try again.';
  const started: GraphEvent = { ...base, seq: 1, type: 'status', state: 'started', message: 'Making plate' };
  async function lostReply() {
    const s = setup(); s.client.control.mockRejectedValueOnce(new Error('network down'));
    s.send(started);
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }));
    await act(async () => { });
    expect(screen.getByRole('alert').textContent).toBe(lost);
    return s;
  }

  it('drops the alert when the command it was about is applied', async () => {
    const s = await lostReply();
    s.send(requested(2, 'pause', 'c', sentKey(s.client)));
    expect(screen.getByRole('alert').textContent).toBe(lost);
    s.send({ ...base, seq: 3, type: 'control_applied', commandId: 'c', checkpoint: 'agent', kind: 'pause', state: 'paused' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('You paused the job at a checkpoint.')).toBeTruthy();
  });
  it('drops the alert when the command it was about is rejected, and the rejection says why', async () => {
    const s = await lostReply();
    s.send(requested(2, 'pause', 'c', sentKey(s.client)), rejected(3, 'pause', 'c', 'duplicate'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Control rejected · duplicate')).toBeTruthy();
  });
  it('keeps the alert while only another tab\'s command settles', async () => {
    const s = await lostReply();
    s.send(requested(2, 'pause', 'remote', 'other-tab'), rejected(3, 'pause', 'remote', 'duplicate'));
    expect(screen.getByRole('alert').textContent).toBe(lost);
    expect(screen.getByText('Control rejected · duplicate')).toBeTruthy();
  });
});
