import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphEvent } from '../core/types';
import { JarvisThread } from './JarvisThread';
import type { EventSource } from './event-source';
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
