import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GraphArtifactKind, GraphDecisionRequestedEvent, GraphDecisionResolvedEvent, GraphEvent } from '../core/types';
import { controlLifecycle, type ControlEvent, type ControlLifecycle } from './control-lifecycle';
import type { ThreadClient } from './client';
import type { EventSource } from './event-source';
import { ThreadDialog } from './ThreadDialog';
import './thread.css';

function createKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Exhaustive so a new artifact kind fails typecheck instead of borrowing another kind's label.
const downloadLabel: Record<Exclude<GraphArtifactKind, 'png'>, string> = { step: '.STEP AUTHORITATIVE', glb: '.GLB REVIEW VIEW', usdz: '.USDZ AR VIEW' };

function safeArtifactUrl(uri: string): boolean {
  try { return ['https:', 'blob:'].includes(new URL(uri, 'https://relative.invalid').protocol); }
  catch { return false; }
}

type StatusEvent = Extract<GraphEvent, { type: 'status' }>;

// Reverse scan instead of Array#findLast: the app tsconfig targets ES2020 without the ES2023 lib.
function lastOf<T extends GraphEvent>(events: readonly GraphEvent[], match: (e: GraphEvent) => e is T): T | undefined {
  for (let i = events.length - 1; i >= 0; i--) { const e = events[i]; if (match(e)) return e; }
  return undefined;
}

function decisionLabel(resolved: GraphDecisionResolvedEvent): string {
  if (resolved.outcome !== 'skipped_best_guess') return 'Choice recorded';
  return resolved.cause === 'timeout' ? 'No answer in time. Best guess recorded' : 'Best guess recorded';
}

function nextOption(key: string, index: number, count: number): number {
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return (index + (['ArrowDown', 'ArrowRight'].includes(key) ? 1 : -1) + count) % count;
}

function workingLabel(hasArtifacts: boolean, workingName: string, pending: boolean, failed: boolean, status: StatusEvent | undefined, offline: boolean): string {
  if (hasArtifacts) return workingName;
  if (!pending && !failed && status?.nodeId === 'domain_agent') return `${workingName}${offline ? '' : ' (in progress)'}`;
  return 'none';
}

// What the run is doing as far as the thread knows. Precedence: an applied cancel (terminal) > a cancel still waiting for its
// checkpoint > an applied pause > a pause still waiting. A command is queued until its own applied or rejected event arrives,
// so another command's rejection (a duplicate cancel, a pause refused while cancelling, a pause superseded by a cancel)
// never shows a cancelling run as running. `sending` is this tab's command until the server's request for it arrives.
function controlState({ applied, queued }: ControlLifecycle, sending: string): string {
  if (applied?.kind === 'cancel') return applied.state;
  if (queued.cancel || sending === 'Cancelling') return 'Cancelling';
  if (applied) return applied.state;
  return queued.pause || sending === 'Pausing' ? 'Pausing' : '';
}

type LaneContext = { pending: boolean; stopped: string | undefined; status: StatusEvent | undefined; offline: boolean; state: string; now: number; completed: ReadonlySet<string> };

function laneLabel(node: string, lane: LaneContext): string {
  const { pending, stopped, status, offline, state, now, completed } = lane;
  if (node === 'domain_agent' && pending) return stopped ? stopped.toUpperCase() : 'WAITS FOR YOU';
  if (status?.nodeId === node) return `${offline ? 'LAST SEEN ' : ''}${state || 'WORKING'} · ${Math.max(0, Math.floor((now - status.at) / 1000))}s`;
  return completed.has(node) ? 'DONE' : 'WAITING';
}

const nodeNames: Record<string, string> = { concept_picks: 'Concept picks', domain_agent: 'CAD model', verify: 'Independent check' };

// What the polite live region says: the result once there is one, otherwise only the stage and its state (never the elapsed timer).
function announcement(result: Extract<GraphEvent, { type: 'result' }> | undefined, status: StatusEvent | undefined, deciding: boolean, state: string): string | undefined {
  if (result) return result.summary;
  if (!status) return undefined;
  return `${nodeNames[status.nodeId] ?? status.nodeId} · ${deciding ? 'WAITS FOR YOU' : state || status.state}`;
}

function controlMessage(control: ControlEvent, { applied }: ControlLifecycle, state: string): string {
  if (control.type === 'control_rejected') return `Control rejected · ${control.reason}`;
  if (control.type === 'control_applied') return `You ${control.state} the job at a checkpoint.`;
  // A request reports the run's effective state, so a command about to be rejected never contradicts the cancel still
  // waiting for its checkpoint, the pause already applied, or the cancel that already ended the run.
  if (state === 'Pausing' || state === 'Cancelling') return `${state} · Waiting for checkpoint`;
  return applied ? `You ${applied.state} the job at a checkpoint.` : `${control.kind === 'pause' ? 'Pausing' : 'Cancelling'} · Waiting for checkpoint`;
}

function Dimensions({ artifacts }: Readonly<{ artifacts: Extract<GraphEvent, { type: 'artifact' }>[] }>) {
  const d = artifacts.find(a => a.dimensionsMm)?.dimensionsMm;
  if (!d) return null;
  return <>
    <p>{[d.x, d.y, d.z].map(n => (n / 25.4).toFixed(3)).join(' × ')} in</p>
    <p className="jt-muted">{[d.x, d.y, d.z].map(n => n.toFixed(3)).join(' × ')} mm</p>
  </>;
}

function Decision({ event, resolved, client, offline, stopped }: Readonly<{ event: GraphDecisionRequestedEvent; resolved?: GraphDecisionResolvedEvent; client: ThreadClient; offline: boolean; stopped?: string }>) {
  const [selected, setSelected] = useState(event.recommended);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), key = useRef<string | null>(null);
  const send = async (skip: boolean) => {
    if (locked.current) return;
    locked.current = true; setPending(true); setError('');
    try {
      const response = await client.resolve(event.runId, event.decisionId, { resolution: skip ? 'skipped_best_guess' : 'chosen', choice: skip ? undefined : selected, idempotencyKey: key.current ?? (key.current = createKey()) });
      if (response.status >= 400) throw new Error(response.status === 403 ? '403 · This decision could not be resolved.' : 'The decision could not be saved.');
    } catch (e) { setError(e instanceof Error ? e.message : 'The decision could not be saved.'); locked.current = false; setPending(false); }
  };
  let body: ReactNode;
  if (resolved) {
    body = <>
      <p>{decisionLabel(resolved)} · {resolved.choice}</p>
      <p>{resolved.rationale}</p>
      <a href="#jarvis-message" onClick={() => document.getElementById("jarvis-message")?.focus()}>Change</a>
    </>;
  } else if (stopped) {
    body = <p>No choice was recorded. The job is {stopped}.</p>;
  } else {
    body = <>
      <div role="radiogroup" aria-label={event.question}>{event.options.map((option, i) => <button key={option} role="radio" aria-checked={selected === option} tabIndex={selected === option ? 0 : -1} disabled={pending || offline} onClick={() => setSelected(option)} onKeyDown={e => {
        if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault(); const next = nextOption(e.key, i, event.options.length);
        setSelected(event.options[next]); (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
      }}><span aria-hidden="true">{selected === option ? '●' : '○'}</span> {option}</button>)}</div>
      <p id={`skip-${event.seq}`}>If you skip, Jarvis uses its best guess, {event.bestGuess}, records it in the design history, and keeps going. You can change it later.</p>
      <div className="jt-actions">
        <button className="jt-primary" disabled={pending || offline} onClick={() => void send(false)}>APPROVE {selected}</button>
        <button aria-describedby={`skip-${event.seq}`} disabled={pending || offline} onClick={() => void send(true)}>{pending ? 'SAVING' : 'SKIP'}</button>
      </div>
    </>;
  }
  return <section>
    <h2>{event.question}</h2>{body}{error && <p role="alert">{error}</p>}</section>;
}

export function JarvisThread({ source, client, runId, arActionSlot, workingName = "candidate" }: Readonly<{ source: EventSource; client: ThreadClient; runId: string; workingName?: string; arActionSlot?: ReactNode }>) {
  const [events, setEvents] = useState<GraphEvent[]>([]), [offline, setOffline] = useState(false);
  const [confirm, setConfirm] = useState(false), [command, setCommand] = useState(''), [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const inFlight = useRef(false), keys = useRef(new Map<string, string>());
  const epoch = useRef(0);
  useEffect(() => {
    // An open cancel confirmation belongs to the run it was opened for; confirming it after a switch would cancel the new run.
    setEvents([]); setCommand(''); setConfirm(false); inFlight.current = false; keys.current.clear(); return source.listen(batch => setEvents(previous => {
      const byId = new Map(previous.map(e => [`${e.runId}:${e.seq}`, e]));
      batch.filter(e => e.runId === runId).forEach(e => byId.set(`${e.runId}:${e.seq}`, e));
      return [...byId.values()].sort((a, b) => a.seq - b.seq);
    }), setOffline);
  }, [source, runId]);
  // A control request outlives a run switch, and its result belongs to the run it was issued for. Leaving a run (a switch or an unmount)
  // ends the epoch each request captured when it was issued, so a late result is ignored instead of clearing the lock, the pending state
  // or the error of whatever run is shown now. It is an epoch, not the run id: a request from an earlier visit to the same run is stale too.
  useEffect(() => { setError(''); return () => { epoch.current += 1; }; }, [source, runId]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const closeConfirm = useCallback(() => setConfirm(false), []);
  const heading = useRef<HTMLHeadingElement>(null);
  const status = lastOf(events, (e): e is StatusEvent => e.type === 'status');
  const decisions = events.filter(e => e.type === 'decision_requested');
  const resolutions = events.filter(e => e.type === 'decision_resolved');
  const pending = decisions.some(d => !resolutions.some(r => r.decisionId === d.decisionId));
  const lifecycle = useMemo(() => controlLifecycle(events), [events]);
  const { latest: control, applied } = lifecycle;
  // This tab's command ends only with its own applied or rejected event, matched through the idempotency key the server echoes on
  // its request. Any other command's outcome (a remote pause, a duplicate cancel) leaves the lock and the key where they are.
  useEffect(() => {
    for (const command of lifecycle.commands) {
      if (!command.settled || keys.current.get(command.kind) !== command.idempotencyKey) continue;
      keys.current.delete(command.kind); inFlight.current = false; setCommand('');
    }
  }, [lifecycle]);
  // Nothing resumes a job, so any applied pause or cancel leaves a pending decision unanswerable.
  const stopped = applied?.state;
  const deciding = pending && !stopped;
  const result = events.find(e => e.type === 'result');
  const failure = events.find(e => e.type === 'error');
  const artifacts = events.filter(e => e.type === 'artifact').filter(a => safeArtifactUrl(a.uri));
  const refs = (applied?.kind === 'cancel' ? applied.kept : result?.artifacts ?? artifacts).filter(a => safeArtifactUrl(a.uri));
  const pictures = refs.filter(a => a.kind === 'png').map(a => a.uri), step = refs.find(a => a.kind === 'step');
  const working = workingLabel(artifacts.length > 0, workingName, pending, !!failure, status, offline);
  const state = controlState(lifecycle, command);
  const lane: LaneContext = { pending, stopped, status, offline, state, now, completed: new Set(events.flatMap(e => e.type === 'status' && e.state === 'completed' ? [e.nodeId] : [])) };
  const sendControl = async (kind: 'pause' | 'cancel') => {
    if (inFlight.current) return;
    const issued = epoch.current;
    inFlight.current = true; setCommand(kind === 'pause' ? 'Pausing' : 'Cancelling'); setError('');
    const key = keys.current.get(kind) ?? createKey(); keys.current.set(kind, key);
    try { const response = await client.control(runId, { kind, idempotencyKey: key }); if (response.status >= 400) throw new Error('Control request failed.'); }
    catch {
      // Issued for a run that is no longer shown: that run's lock, command and error are already gone, and the shown run's are not this request's.
      if (epoch.current !== issued) return;
      inFlight.current = false; setCommand(''); setError('Control request failed. Try again.');
    }
  };
  return <main className="jt">
    <header>
      <h1 ref={heading} tabIndex={-1}>Jarvis</h1>
    </header>
    <div className="jt-state" aria-label="Baseline and design state">{offline && 'Offline · '}Working {working} · Committed none{offline && <button onClick={() => source.retry()}>RETRY</button>}</div>
    <p aria-live="polite" className="sr-only">{announcement(result, status, deciding, state)}</p>
    <div className={deciding ? 'jt-log jt-has-bar' : 'jt-log'}>{!events.length && <p>No requests yet. Example: Make a 4 inch square plate.</p>}{status && <p>{status.message}</p>}{events.length > 0 && !result && <>
      <ol className="jt-lanes">{(['concept_picks', 'domain_agent', 'verify'] as const).map(node => <li key={node}>
        <span>{nodeNames[node]}</span>
        <span>{laneLabel(node, lane)}</span>
      </li>)}</ol>{!failure && applied?.kind !== 'cancel' && <div>
        <button disabled={offline || !!state} onClick={() => void sendControl('pause')}>{state || 'PAUSE'}</button>
        <button disabled={offline || inFlight.current || lifecycle.queued.cancel} onClick={() => setConfirm(true)}>CANCEL</button>
      </div>}</>}{decisions.map(d => <Decision key={`${d.runId}:${d.decisionId}`} event={d} resolved={resolutions.find(r => r.decisionId === d.decisionId)} client={client} offline={offline} stopped={stopped} />)}{control && <p>{controlMessage(control, lifecycle, state)}</p>}{failure && <p role="alert">CAD: FAIL · {failure.message}</p>}{error && <p role="alert">{error}</p>}{result && <h2>{result.summary}</h2>}{applied?.kind === 'cancel' && <h2>Work kept</h2>}{pictures.map((p, i) => <img key={p} src={p} alt={i === 0 ? 'Iso' : 'Top view'} />)}{arActionSlot}<Dimensions artifacts={artifacts} />{refs.filter(a => a.kind !== 'png').map(a => <a key={a.uri} href={a.uri} download>{downloadLabel[a.kind]}</a>)}{step && <a href={step.uri} download>DOWNLOAD STEP</a>}</div>
    <footer>
      <label htmlFor="jarvis-message">Message Jarvis</label>
      <textarea id="jarvis-message" placeholder="Describe the part you need" />
      <p className="jt-muted">Preview only. Messages are not sent.</p>
    </footer>{confirm && <ThreadDialog sheet close={closeConfirm} fallbackFocus={heading}>
      <h2>Cancel request?</h2>
      <p>Jarvis stops at the next safe checkpoint. Work done so far stays in the thread.</p>
      <button disabled={inFlight.current || lifecycle.queued.cancel} onClick={() => { void sendControl('cancel'); setConfirm(false); }}>CANCEL REQUEST</button>
    </ThreadDialog>}</main>;
}
