import type { GraphEvent } from '../core/types';

export type ControlEvent = Extract<GraphEvent, { type: 'control_requested' | 'control_applied' | 'control_rejected' }>;
export type AppliedEvent = Extract<GraphEvent, { type: 'control_applied' }>;
export type ControlKind = Extract<GraphEvent, { type: 'control_requested' }>['kind'];

/** One command from its control_requested event to the applied or rejected event that carries the same commandId. */
export interface ControlCommand {
  commandId: string;
  kind: ControlKind;
  /** Echoed by the server on control_requested; how a tab recognises the command it sent itself. */
  idempotencyKey: string;
  settled: boolean;
}

export interface ControlLifecycle {
  /** The newest control event of any kind. It drives the status message only, never the run state. */
  latest: ControlEvent | undefined;
  /** The newest control_applied event. An applied cancel is terminal. */
  applied: AppliedEvent | undefined;
  commands: readonly ControlCommand[];
  /** A command of this kind has been requested and is waiting for its checkpoint (not yet applied or rejected). */
  queued: Readonly<Record<ControlKind, boolean>>;
}

/**
 * Folds the ordered control events of a run into its command lifecycle.
 *
 * Every event settles only the command it names. A request is a queued command until its own applied or rejected
 * event arrives, so a rejection of some other command (a duplicate cancel, a pause refused while cancelling, a pause
 * superseded by a cancel) cannot undo a command that is still waiting for a checkpoint. The one exception is an
 * applied cancel: it ends the run, so nothing stays queued behind it.
 */
export function controlLifecycle(events: readonly GraphEvent[]): ControlLifecycle {
  const commands = new Map<string, ControlCommand>();
  let latest: ControlEvent | undefined, applied: AppliedEvent | undefined;
  for (const event of events) {
    if (event.type === 'control_requested') {
      // After an applied cancel the run is over: the graph rejects the request as terminal, and nothing waits for a checkpoint.
      commands.set(event.commandId, { commandId: event.commandId, kind: event.kind, idempotencyKey: event.idempotencyKey, settled: applied?.kind === 'cancel' });
      latest = event;
    } else if (event.type === 'control_applied' || event.type === 'control_rejected') {
      const command = commands.get(event.commandId);
      if (command) command.settled = true;
      latest = event;
      if (event.type === 'control_applied') {
        applied = event;
        if (event.kind === 'cancel') commands.forEach(c => { c.settled = true; });
      }
    }
  }
  const all = [...commands.values()];
  const waiting = (kind: ControlKind) => all.some(c => c.kind === kind && !c.settled);
  return { latest, applied, commands: all, queued: { pause: waiting('pause'), cancel: waiting('cancel') } };
}
