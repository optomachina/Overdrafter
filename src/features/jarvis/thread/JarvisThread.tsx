import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GraphArtifactKind, GraphDecisionRequestedEvent, GraphDecisionResolvedEvent, GraphEvent } from '../core/types';
import { controlLifecycle, type ControlEvent, type ControlLifecycle } from './control-lifecycle';
import type { ThreadClient } from './client';
import type { EventSource } from './event-source';
import { ModelView } from './ModelView';
import { ThreadDialog } from './ThreadDialog';
import { ViewInArAction } from '../ar/ViewInArAction';
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
type FailureEvent = Extract<GraphEvent, { type: 'error' }>;

// The event that ended the run, if any: an applied cancel, an error or the result. The first one wins, because the graph emits
// nothing after it but control answers. The thread stops its clock there and never starts it again for that run.
function endingEvent(events: readonly GraphEvent[]): GraphEvent | undefined {
  return events.find(e => e.type === 'error' || e.type === 'result' || (e.type === 'control_applied' && e.kind === 'cancel'));
}

// Reverse scan instead of Array#findLast: the app tsconfig targets ES2020 without the ES2023 lib.
function lastOf<T extends GraphEvent>(events: readonly GraphEvent[], match: (e: GraphEvent) => e is T): T | undefined {
  for (let i = events.length - 1; i >= 0; i--) { const e = events[i]; if (match(e)) return e; }
  return undefined;
}

// The first picture is always the iso view, with or without a 3D model to open.
function pictureAlt(index: number): string {
  return index === 0 ? 'Iso' : 'Top view';
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

// `now` is the clock the elapsed time reads. The thread freezes it at the event that ended the run, so a finished run stops counting.
type LaneContext = { pending: boolean; stopped: string | undefined; status: StatusEvent | undefined; failure: FailureEvent | undefined; offline: boolean; state: string; now: number; completed: ReadonlySet<string> };

function laneLabel(node: string, lane: LaneContext): string {
  const { pending, stopped, status, failure, offline, state, now, completed } = lane;
  const seen = offline ? 'LAST SEEN ' : '';
  const elapsed = (from: StatusEvent) => `${Math.max(0, Math.floor((now - from.at) / 1000))}s`;
  if (failure) {
    // A failed run is over, so no lane is working, pausing or waiting for an answer, whatever command was still queued behind the
    // error. The lane the graph failed in says so, and its clock stopped at the error. The others keep what they had finished.
    if (failure.nodeId === node) return status?.nodeId === node ? `${seen}FAILED · ${elapsed(status)}` : `${seen}FAILED`;
    return completed.has(node) ? 'DONE' : 'WAITING';
  }
  if (node === 'domain_agent' && pending) return stopped ? stopped.toUpperCase() : 'WAITS FOR YOU';
  if (status?.nodeId === node) return `${seen}${state || 'WORKING'} · ${elapsed(status)}`;
  return completed.has(node) ? 'DONE' : 'WAITING';
}

const nodeNames: Record<string, string> = { concept_picks: 'Concept picks', domain_agent: 'CAD model', verify: 'Independent check' };

// What the polite live region says: the result once there is one, a failure as failed rather than as the stage it was in,
// otherwise only the stage and its state (never the elapsed timer).
function announcement(result: Extract<GraphEvent, { type: 'result' }> | undefined, failure: FailureEvent | undefined, status: StatusEvent | undefined, deciding: boolean, state: string): string | undefined {
  if (result) return result.summary;
  if (failure) return `${nodeNames[failure.nodeId] ?? failure.nodeId} · failed`;
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

function absoluteUrl(uri: string): string {
  try { return new URL(uri, window.location.href).href; } catch { return uri; }
}

/** `onSend` makes the composer live; without it the composer stays a labelled preview. `request` echoes what the user asked. */
export function JarvisThread({ source, client, runId, arActionSlot, workingName = "candidate", onSend, request, note }: Readonly<{ source: EventSource; client: ThreadClient; runId: string; workingName?: string; arActionSlot?: ReactNode; onSend?: (message: string) => void; request?: string; note?: ReactNode }>) {
  const [draft, setDraft] = useState('');
  const submit = () => { const message = draft.trim(); if (!message || !onSend) return; onSend(message); setDraft(''); };
  const [events, setEvents] = useState<GraphEvent[]>([]), [offline, setOffline] = useState(false);
  const [viewer, setViewer] = useState(false), [confirm, setConfirm] = useState(false), [command, setCommand] = useState(''), [error, setError] = useState('');
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
  const closeViewer = useCallback(() => setViewer(false), []), closeConfirm = useCallback(() => setConfirm(false), []);
  const heading = useRef<HTMLHeadingElement>(null);
  const viewerRun = useRef({ source, runId }), focusHeadingAfterClose = useRef(false);
  useEffect(() => {
    const changed = viewerRun.current.source !== source || viewerRun.current.runId !== runId;
    viewerRun.current = { source, runId };
    if (changed && viewer) {
      focusHeadingAfterClose.current = true;
      setViewer(false);
    } else if (!viewer && focusHeadingAfterClose.current) {
      // Wait for dialog cleanup: synchronous artifacts can reuse its opener for another run.
      focusHeadingAfterClose.current = false;
      heading.current?.focus();
    }
  }, [source, runId, viewer]);
  const status = lastOf(events, (e): e is StatusEvent => e.type === 'status');
  const decisions = events.filter(e => e.type === 'decision_requested');
  const resolutions = events.filter(e => e.type === 'decision_resolved');
  const pending = decisions.some(d => !resolutions.some(r => r.decisionId === d.decisionId));
  const lifecycle = useMemo(() => controlLifecycle(events), [events]);
  const { latest: control, applied } = lifecycle;
  // This tab's command ends only with its own applied or rejected event, matched through the idempotency key the server echoes on
  // its request. Any other command's outcome (a remote pause, a duplicate cancel) leaves the lock and the key where they are.
  // Settling also ends the transport alert: a request whose reply was lost shows "Try again" until the server's own answer for the
  // same command arrives, and that answer (an applied state or a "Control rejected" line) is the truth the alert must not contradict.
  useEffect(() => {
    for (const command of lifecycle.commands) {
      if (!command.settled || keys.current.get(command.kind) !== command.idempotencyKey) continue;
      keys.current.delete(command.kind); inFlight.current = false; setCommand(''); setError('');
    }
  }, [lifecycle]);
  // A run that ended (cancelled, failed or completed) has nothing left to time: the clock the lanes read stops at the ending event
  // and the interval stops with it. A different run starts it again, with a fresh reading so its first elapsed time is not stale.
  const ending = endingEvent(events), over = ending !== undefined;
  useEffect(() => {
    if (over) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [over]);
  // Nothing resumes a job, so any applied pause or cancel leaves a pending decision unanswerable.
  const stopped = applied?.state;
  const deciding = pending && !stopped;
  const result = events.find(e => e.type === 'result');
  const failure = events.find(e => e.type === 'error');
  const artifacts = events.filter(e => e.type === 'artifact').filter(a => safeArtifactUrl(a.uri));
  const refs = (applied?.kind === 'cancel' ? applied.kept : result?.artifacts ?? artifacts).filter(a => safeArtifactUrl(a.uri));
  const pictures = refs.filter(a => a.kind === 'png').map(a => a.uri), glb = refs.find(a => a.kind === 'glb'), step = refs.find(a => a.kind === 'step');
  const working = workingLabel(artifacts.length > 0, workingName, pending, !!failure, status, offline);
  const state = controlState(lifecycle, command);
  const lane: LaneContext = { pending, stopped, status, failure, offline, state, now: ending?.at ?? now, completed: new Set(events.flatMap(e => e.type === 'status' && e.state === 'completed' ? [e.nodeId] : [])) };
  const sendControl = async (kind: 'pause' | 'cancel') => {
    if (inFlight.current) return;
    const issued = epoch.current;
    inFlight.current = true; setCommand(kind === 'pause' ? 'Pausing' : 'Cancelling'); setError('');
    const key = keys.current.get(kind) ?? createKey(); keys.current.set(kind, key);
    try { const response = await client.control(runId, { kind, idempotencyKey: key }); if (response.status >= 400) throw new Error('Control request failed.'); }
    catch {
      // Issued for a run that is no longer shown: that run's lock, command and error are already gone, and the shown run's are not this request's.
      // In the same run, a request the server already settled has had its key deleted, so the lock and the command now belong to a newer
      // request and this late failure must not release them. A request that is still the active one for its kind still holds its key.
      if (epoch.current !== issued || keys.current.get(kind) !== key) return;
      inFlight.current = false; setCommand(''); setError('Control request failed. Try again.');
    }
  };
  return <main className="jt">
    <header>
      <h1 ref={heading} tabIndex={-1}>Jarvis</h1>
    </header>
    <div className="jt-state" role="status" aria-label="Baseline and design state">{offline && 'Offline · '}Working {working} · Committed none{offline && <button onClick={() => source.retry()}>RETRY</button>}</div>
    <p aria-live="polite" className="sr-only">{announcement(result, failure, status, deciding, state)}</p>
    <div className={deciding ? 'jt-log jt-has-bar' : 'jt-log'}>{request && <p className="jt-request" aria-label="Your request">{request}</p>}{!events.length && !request && <p className="jt-empty">No requests yet. Try “design a 4 inch square plate”.</p>}{status && !result && <p>{status.message}</p>}{events.length > 0 && !result && <>
      <ol className="jt-lanes">{(['concept_picks', 'domain_agent', 'verify'] as const).map(node => <li key={node}>
        <span>{nodeNames[node]}</span>
        <span>{laneLabel(node, lane)}</span>
      </li>)}</ol>{!failure && applied?.kind !== 'cancel' && <div>
        <button disabled={offline || !!state} onClick={() => void sendControl('pause')}>{state || 'PAUSE'}</button>
        <button disabled={offline || inFlight.current || lifecycle.queued.cancel} onClick={() => setConfirm(true)}>CANCEL</button>
      </div>}</>}{decisions.map(d => <Decision key={`${d.runId}:${d.decisionId}`} event={d} resolved={resolutions.find(r => r.decisionId === d.decisionId)} client={client} offline={offline} stopped={stopped} />)}{control && <p>{controlMessage(control, lifecycle, state)}</p>}{failure && <p role="alert">CAD: FAIL · {failure.message}</p>}{error && <p role="alert">{error}</p>}{(result || applied?.kind === 'cancel' || refs.length > 0) && <section className="jt-result" data-jarvis-result aria-label={result?.summary ?? (applied?.kind === 'cancel' ? 'Work kept' : 'Work so far')}>{result && <h2>{result.summary}</h2>}{applied?.kind === 'cancel' && <h2>Work kept</h2>}{pictures.map((p, i) => i === 0 && glb ? <button className="jt-picture" key={p} onClick={() => setViewer(true)}>
        <img src={p} alt="Iso" />Iso · tap for 3D</button> : <img key={p} src={p} alt={pictureAlt(i)} />)}<div className="jt-result-actions">{glb && <button onClick={() => setViewer(true)}>OPEN 3D VIEW</button>}{glb && !arActionSlot && <ViewInArAction name={workingName} glbUrl={absoluteUrl(glb.uri)} viewUrl={window.location.href} posterUrl={pictures[0] ?? ''} onRetry={() => undefined} />}{arActionSlot}</div><Dimensions artifacts={artifacts} /><div className="jt-downloads">{refs.filter(a => a.kind !== 'png').map(a => <a key={a.uri} href={a.uri} download>{downloadLabel[a.kind]}</a>)}{step && <a href={step.uri} download>DOWNLOAD STEP</a>}</div></section>}</div>
    <footer>
      <label htmlFor="jarvis-message">Message Jarvis</label>
      {onSend ? <form className="jt-compose" onSubmit={e => { e.preventDefault(); submit(); }}>
        <textarea id="jarvis-message" placeholder="Describe the part you need" rows={2} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        <button type="submit" className="jt-primary" disabled={!draft.trim()}>SEND</button>
      </form> : <textarea id="jarvis-message" placeholder="Describe the part you need" />}
      {note ?? <p className="jt-muted">Preview only. Messages are not sent.</p>}
    </footer>{viewer && glb && <ThreadDialog close={closeViewer} fallbackFocus={heading}>
      <ModelView uri={glb.uri} pictures={pictures} step={step?.uri} />
    </ThreadDialog>}{confirm && <ThreadDialog sheet close={closeConfirm} fallbackFocus={heading}>
      <h2>Cancel request?</h2>
      <p>Jarvis stops at the next safe checkpoint. Work done so far stays in the thread.</p>
      <button disabled={inFlight.current || lifecycle.queued.cancel} onClick={() => { void sendControl('cancel'); setConfirm(false); }}>CANCEL REQUEST</button>
    </ThreadDialog>}</main>;
}
