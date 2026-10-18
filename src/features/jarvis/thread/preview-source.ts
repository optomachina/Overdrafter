import type { GraphEvent } from '../core/types';
import type { ThreadClient } from './client';
import type { EventSource } from './event-source';
import isoUrl from './preview-assets/iso.png?url';
import topUrl from './preview-assets/top.png?url';
import stepUrl from './preview-assets/plate.step?url';

/** Exclusively synthetic preview. Every artifact is a local generated plate fixture. */
export function createPreview() {
  let seq = 0;
  let halted = false; // a pause or cancel stops the synthetic job; late decisions deliver nothing
  let deliver: (events: GraphEvent[]) => void = () => { };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const envelope = () => ({ runId: 'plate-preview', seq: ++seq, at: Date.now() });
  const publish = (event: GraphEvent) => deliver([event]);
  const later = (fn: () => void) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, 800); timers.add(timer); };
  const files = ['iso.png', 'top.png', 'plate.step'];
  const artifacts = [isoUrl, topUrl, stepUrl].map((uri, i) => ({ kind: (i < 2 ? 'png' : 'step') as 'png' | 'step', uri }));
  const result = () => {
    artifacts.forEach((a, i) => publish({ ...envelope(), type: 'artifact', nodeId: 'domain_agent', agentId: 'cad', ...a, name: files[i], mimeType: i < 2 ? 'image/png' : 'model/step', dimensionsMm: { x: 101.6, y: 101.6, z: 6.35 } }));
    publish({ ...envelope(), type: 'result', nodeId: 'result', agentId: 'cad', summary: 'Plate review ready', picks: { thickness: '0.250 in' }, artifacts });
  };
  const source: EventSource = {
    retry() { }, listen(events, connection) {
      deliver = events; connection(false);
      publish({ ...envelope(), type: 'status', nodeId: 'concept_picks', state: 'started', message: 'Make a 4 inch square plate.' });
      later(() => publish({ ...envelope(), type: 'decision_requested', nodeId: 'concept_picks', decisionId: 'thickness', question: 'Choose plate thickness', options: ['0.250 in', '0.125 in', '0.500 in'], recommended: '0.250 in', bestGuess: '0.250 in', timeoutMs: 60000 }));
      return () => { timers.forEach(clearTimeout); timers.clear(); deliver = () => { }; };
    }
  };
  const client: ThreadClient = {
    resolve(_run, decisionId, answer) {
      if (halted) return Promise.resolve({ status: 409 });
      publish({ ...envelope(), type: 'decision_resolved', nodeId: 'concept_picks', decisionId, choice: answer.choice ?? '0.250 in', rationale: 'Default thickness for this synthetic plate preview.', ...(answer.resolution === 'chosen' ? { outcome: 'chosen' as const } : { outcome: 'skipped_best_guess' as const, cause: 'skip' as const }) });
      publish({ ...envelope(), type: 'status', nodeId: 'domain_agent', state: 'started', message: 'Preparing the CAD review' });
      later(result); return Promise.resolve({ status: 200 });
    },
    control(_run, command) {
      halted = true;
      timers.forEach(clearTimeout); timers.clear();
      publish({ ...envelope(), type: 'control_requested', nodeId: 'domain_agent', commandId: command.idempotencyKey, actorId: 'sample', ...command });
      later(() => publish({ ...envelope(), type: 'control_applied', nodeId: 'domain_agent', commandId: command.idempotencyKey, checkpoint: 'agent', ...(command.kind === 'pause' ? { kind: 'pause' as const, state: 'paused' as const } : { kind: 'cancel' as const, state: 'cancelled' as const, kept: [artifacts[0]] }) }));
      return Promise.resolve({ status: 202 });
    },
  };
  return { source, client };
}
