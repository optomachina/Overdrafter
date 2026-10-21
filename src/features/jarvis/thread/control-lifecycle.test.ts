import { describe, expect, it } from 'vitest';
import type { GraphEvent } from '../core/types';
import { controlLifecycle } from './control-lifecycle';

const base = { runId: 'run', at: 1000, nodeId: 'domain_agent' as const };
const request = (seq: number, kind: 'pause' | 'cancel', commandId: string, idempotencyKey = `key-${commandId}`): GraphEvent => ({ ...base, seq, type: 'control_requested', kind, commandId, actorId: 'owner', idempotencyKey });
const reject = (seq: number, kind: 'pause' | 'cancel', commandId: string, reason: 'terminal' | 'duplicate' | 'cancel_pending' | 'superseded'): GraphEvent => ({ ...base, seq, type: 'control_rejected', kind, commandId, reason });
const pauseApplied = (seq: number, commandId: string): GraphEvent => ({ ...base, seq, type: 'control_applied', commandId, checkpoint: 'agent', kind: 'pause', state: 'paused' });
const cancelApplied = (seq: number, commandId: string): GraphEvent => ({ ...base, seq, type: 'control_applied', commandId, checkpoint: 'agent', kind: 'cancel', state: 'cancelled', kept: [] });
const status: GraphEvent = { ...base, seq: 0, type: 'status', state: 'started', message: 'Making plate' };

describe('controlLifecycle', () => {
  it('has nothing queued before any control event', () => {
    expect(controlLifecycle([status])).toEqual({ latest: undefined, applied: undefined, commands: [], queued: { pause: false, cancel: false } });
  });

  it('queues a command from its request until the event that carries its own commandId', () => {
    expect(controlLifecycle([request(1, 'cancel', 'c')]).queued).toEqual({ pause: false, cancel: true });
    expect(controlLifecycle([request(1, 'cancel', 'c'), cancelApplied(2, 'c')]).queued).toEqual({ pause: false, cancel: false });
    expect(controlLifecycle([request(1, 'cancel', 'c'), reject(2, 'cancel', 'c', 'terminal')]).queued).toEqual({ pause: false, cancel: false });
    expect(controlLifecycle([request(1, 'pause', 'p'), pauseApplied(2, 'p')]).queued).toEqual({ pause: false, cancel: false });
  });

  it.each<[string, GraphEvent[]]>([
    ['a duplicate cancel', [request(2, 'cancel', 'd'), reject(3, 'cancel', 'd', 'duplicate')]],
    ['a pause refused while cancelling', [request(2, 'pause', 'd'), reject(3, 'pause', 'd', 'cancel_pending')]],
  ])('keeps a cancel queued through %s being rejected', (_name, later) => {
    const lifecycle = controlLifecycle([request(1, 'cancel', 'c'), ...later]);
    expect(lifecycle.queued.cancel).toBe(true);
    expect(lifecycle.latest?.type).toBe('control_rejected');
    expect(lifecycle.commands.map(c => [c.commandId, c.settled])).toEqual([['c', false], ['d', true]]);
  });

  it('settles a pause that a cancel superseded without settling the cancel', () => {
    const lifecycle = controlLifecycle([request(1, 'pause', 'p'), request(2, 'cancel', 'c'), reject(3, 'pause', 'p', 'superseded')]);
    expect(lifecycle.queued).toEqual({ pause: false, cancel: true });
    expect(controlLifecycle([request(1, 'pause', 'p'), request(2, 'cancel', 'c'), reject(3, 'pause', 'p', 'superseded'), cancelApplied(4, 'c')]).queued).toEqual({ pause: false, cancel: false });
  });

  it('keeps a queued cancel when a pause is applied, and tracks the newest applied event', () => {
    const lifecycle = controlLifecycle([request(1, 'pause', 'p'), pauseApplied(2, 'p'), request(3, 'cancel', 'c')]);
    expect(lifecycle.queued).toEqual({ pause: false, cancel: true });
    expect(lifecycle.applied).toMatchObject({ kind: 'pause', commandId: 'p' });
    expect(controlLifecycle([request(1, 'pause', 'p'), pauseApplied(2, 'p'), request(3, 'cancel', 'c'), cancelApplied(4, 'c')]).applied).toMatchObject({ kind: 'cancel', commandId: 'c' });
  });

  it('leaves nothing queued behind an applied cancel, including a command requested after it', () => {
    const lifecycle = controlLifecycle([request(1, 'pause', 'p'), request(2, 'cancel', 'c'), cancelApplied(3, 'c'), request(4, 'pause', 'late')]);
    expect(lifecycle.commands.map(c => [c.commandId, c.settled])).toEqual([['p', true], ['c', true], ['late', true]]);
    expect(lifecycle.queued).toEqual({ pause: false, cancel: false });
    expect(lifecycle.applied?.kind).toBe('cancel');
  });

  it('ignores an applied or rejected event for a command it never saw requested, but still reports it', () => {
    const lifecycle = controlLifecycle([request(1, 'cancel', 'c'), reject(2, 'pause', 'unknown', 'terminal')]);
    expect(lifecycle.queued.cancel).toBe(true);
    expect(lifecycle.commands).toHaveLength(1);
    expect(lifecycle.latest).toMatchObject({ type: 'control_rejected', commandId: 'unknown' });
  });

  it('keeps the idempotency key each request echoed, so a tab can recognise its own command', () => {
    const lifecycle = controlLifecycle([request(1, 'cancel', 'c', 'tab-key'), request(2, 'pause', 'p', 'other-key')]);
    expect(lifecycle.commands.map(c => [c.commandId, c.kind, c.idempotencyKey])).toEqual([['c', 'cancel', 'tab-key'], ['p', 'pause', 'other-key']]);
  });
});
