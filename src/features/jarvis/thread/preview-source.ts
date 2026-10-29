import type { GraphEvent } from '../core/types';
import type { ThreadClient } from './client';
import type { EventSource } from './event-source';
import isoUrl from './preview-assets/iso.png?url';
import topUrl from './preview-assets/top.png?url';
import glbUrl from './preview-assets/plate.glb?url';
import stepUrl from './preview-assets/plate.step?url';

/** Exclusively synthetic preview. Every artifact is a local generated plate fixture. */
/** `prompt` is the request the sample answers. `answerWithinMs` lets an unanswered choice fall back to the best guess, like a real run's timeout. */
export function createPreview({ prompt = 'Make a 4 inch square plate.', answerWithinMs }: { prompt?: string; answerWithinMs?: number } = {}) {
  let seq = 0;
  let halted = false, answered = false; // a pause or cancel stops the synthetic job; late decisions deliver nothing
  let deliver: (events: GraphEvent[]) => void = () => { };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const envelope = () => ({ runId: 'plate-preview', seq: ++seq, at: Date.now() });
  const publish = (event: GraphEvent) => deliver([event]);
  const later = (fn: () => void) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, 800); timers.add(timer); };
  const files = ['iso.png', 'top.png', 'plate.glb', 'plate.step'];
  const kinds = ['png', 'png', 'glb', 'step'] as const, mimeTypes = ['image/png', 'image/png', 'model/gltf-binary', 'model/step'];
  const artifacts = [isoUrl, topUrl, glbUrl, stepUrl].map((uri, i) => ({ kind: kinds[i], uri }));
  const result = () => {
    artifacts.forEach((a, i) => publish({ ...envelope(), type: 'artifact', nodeId: 'domain_agent', agentId: 'cad', ...a, name: files[i], mimeType: mimeTypes[i], dimensionsMm: { x: 101.6, y: 101.6, z: 6.35 } }));
    publish({ ...envelope(), type: 'result', nodeId: 'result', agentId: 'cad', summary: 'Plate review ready', picks: { thickness: '0.250 in' }, artifacts });
  };
  const timeout = () => {
    answered = true;
    publish({ ...envelope(), type: 'decision_resolved', nodeId: 'concept_picks', decisionId: 'thickness', choice: '0.250 in', rationale: 'No answer in time; default thickness for this sample plate.', outcome: 'skipped_best_guess', cause: 'timeout' });
    publish({ ...envelope(), type: 'status', nodeId: 'domain_agent', state: 'started', message: 'Preparing the CAD review' });
    later(result);
  };
  const source: EventSource = {
    retry() { }, listen(events, connection) {
      deliver = events; connection(false);
      publish({ ...envelope(), type: 'status', nodeId: 'concept_picks', state: 'started', message: prompt });
      later(() => {
        publish({ ...envelope(), type: 'decision_requested', nodeId: 'concept_picks', decisionId: 'thickness', question: 'Choose plate thickness', options: ['0.250 in', '0.125 in', '0.500 in'], recommended: '0.250 in', bestGuess: '0.250 in', timeoutMs: answerWithinMs ?? 60000 });
        if (answerWithinMs !== undefined) {
          const timer = setTimeout(() => { timers.delete(timer); if (!answered && !halted) timeout(); }, answerWithinMs); timers.add(timer);
        }
      });
      return () => { timers.forEach(clearTimeout); timers.clear(); deliver = () => { }; };
    }
  };
  const client: ThreadClient = {
    resolve(_run, decisionId, answer) {
      if (halted || answered) return Promise.resolve({ status: 409 });
      answered = true;
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
