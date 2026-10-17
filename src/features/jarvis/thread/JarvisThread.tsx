import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { GraphArtifactKind, GraphDecisionRequestedEvent, GraphDecisionResolvedEvent, GraphEvent } from '../core/types';
import type { ThreadClient } from './client';
import type { EventSource } from './event-source';
import { ModelView } from './ModelView';
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
type ControlEvent = Extract<GraphEvent, { type: 'control_requested' | 'control_applied' | 'control_rejected' }>;

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

function controlState(control: ControlEvent | undefined, command: string): string {
  if (control?.type === 'control_applied') return control.state;
  if (control?.type === 'control_requested') return control.kind === 'pause' ? 'Pausing' : 'Cancelling';
  return command;
}

function laneLabel(node: string, pending: boolean, status: StatusEvent | undefined, offline: boolean, state: string, now: number, events: GraphEvent[]): string {
  if (node === 'domain_agent' && pending) return 'WAITS FOR YOU';
  if (status?.nodeId === node) return `${offline ? 'LAST SEEN ' : ''}${state || 'WORKING'} · ${Math.max(0, Math.floor((now - status.at) / 1000))}s`;
  return events.some(e => e.type === 'status' && e.nodeId === node && e.state === 'completed') ? 'DONE' : 'WAITING';
}

function controlMessage(control: ControlEvent): string {
  if (control.type === 'control_applied') return `You ${control.state} the job at a checkpoint.`;
  if (control.type === 'control_rejected') return `Control rejected · ${control.reason}`;
  return control.kind === 'pause' ? 'Pausing · Waiting for checkpoint' : 'Cancelling · Waiting for checkpoint';
}

function Dimensions({ artifacts }: Readonly<{ artifacts: Extract<GraphEvent, { type: 'artifact' }>[] }>) {
  const d = artifacts.find(a => a.dimensionsMm)?.dimensionsMm;
  if (!d) return null;
  return <>
    <p>{[d.x, d.y, d.z].map(n => (n / 25.4).toFixed(3)).join(' × ')} in</p>
    <p className="jt-muted">{[d.x, d.y, d.z].map(n => n.toFixed(3)).join(' × ')} mm</p>
  </>;
}

function Decision({ event, resolved, client, offline }: Readonly<{ event: GraphDecisionRequestedEvent; resolved?: GraphDecisionResolvedEvent; client: ThreadClient; offline: boolean }>) {
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
  return <section>
    <h2>{event.question}</h2>{resolved ? <>
      <p>{decisionLabel(resolved)} · {resolved.choice}</p>
      <p>{resolved.rationale}</p>
      <a href="#jarvis-message" onClick={() => document.getElementById("jarvis-message")?.focus()}>Change</a>
    </> : <>
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
    </>}{error && <p role="alert">{error}</p>}</section>;
}

export function JarvisThread({ source, client, runId, arActionSlot, workingName = "candidate" }: Readonly<{ source: EventSource; client: ThreadClient; runId: string; workingName?: string; arActionSlot?: ReactNode }>) {
  const [events, setEvents] = useState<GraphEvent[]>([]), [offline, setOffline] = useState(false);
  const [viewer, setViewer] = useState(false), [confirm, setConfirm] = useState(false), [command, setCommand] = useState(''), [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const inFlight = useRef(false), keys = useRef(new Map<string, string>());
  useEffect(() => {
    setEvents([]); setCommand(''); inFlight.current = false; keys.current.clear(); return source.listen(batch => setEvents(previous => {
      const byId = new Map(previous.map(e => [`${e.runId}:${e.seq}`, e]));
      batch.filter(e => e.runId === runId).forEach(e => byId.set(`${e.runId}:${e.seq}`, e));
      return [...byId.values()].sort((a, b) => a.seq - b.seq);
    }), setOffline);
  }, [source, runId]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const closeViewer = useCallback(() => setViewer(false), []), closeConfirm = useCallback(() => setConfirm(false), []);
  const status = lastOf(events, (e): e is StatusEvent => e.type === 'status');
  const decisions = events.filter(e => e.type === 'decision_requested');
  const resolutions = events.filter(e => e.type === 'decision_resolved');
  const pending = decisions.some(d => !resolutions.some(r => r.decisionId === d.decisionId));
  const control = lastOf(events, (e): e is ControlEvent => e.type === 'control_requested' || e.type === 'control_applied' || e.type === 'control_rejected');
  useEffect(() => { if (control?.type === 'control_applied' || control?.type === 'control_rejected') { inFlight.current = false; keys.current.delete(control.kind); setCommand(''); } }, [control]);
  const applied = control?.type === 'control_applied' ? control : undefined;
  const result = events.find(e => e.type === 'result');
  const failure = events.find(e => e.type === 'error');
  const artifacts = events.filter(e => e.type === 'artifact').filter(a => safeArtifactUrl(a.uri));
  const refs = (applied?.kind === 'cancel' ? applied.kept : result?.artifacts ?? artifacts).filter(a => safeArtifactUrl(a.uri));
  const pictures = refs.filter(a => a.kind === 'png').map(a => a.uri), glb = refs.find(a => a.kind === 'glb'), step = refs.find(a => a.kind === 'step');
  const working = workingLabel(artifacts.length > 0, workingName, pending, !!failure, status, offline);
  const state = controlState(control, command);
  const sendControl = async (kind: 'pause' | 'cancel') => {
    if (inFlight.current) return;
    inFlight.current = true; setCommand(kind === 'pause' ? 'Pausing' : 'Cancelling'); setError('');
    const key = keys.current.get(kind) ?? createKey(); keys.current.set(kind, key);
    try { const response = await client.control(runId, { kind, idempotencyKey: key }); if (response.status >= 400) throw new Error('Control request failed.'); }
    catch { inFlight.current = false; setCommand(''); setError('Control request failed. Try again.'); }
  };
  return <main className="jt">
    <header>
      <h1>Jarvis</h1>
    </header>
    <div className="jt-state" aria-label="Baseline and design state">{offline && 'Offline · '}Working {working} · Committed none{offline && <button onClick={() => source.retry()}>RETRY</button>}</div>
    <p aria-live="polite" className="sr-only">{status && `${({ concept_picks: 'Concept picks', domain_agent: 'CAD model', verify: 'Independent check' } as Record<string, string>)[status.nodeId] ?? status.nodeId} · ${pending ? 'WAITS FOR YOU' : state || status.state}`}</p>
    <div className="jt-log">{!events.length && <p>No requests yet. Example: Make a 4 inch square plate.</p>}{status && <p>{status.message}</p>}{events.length > 0 && !result && <>
      <ol className="jt-lanes">{(['concept_picks', 'domain_agent', 'verify'] as const).map((node, i) => <li key={node}>
        <span>{['Concept picks', 'CAD model', 'Independent check'][i]}</span>
        <span>{laneLabel(node, pending, status, offline, state, now, events)}</span>
      </li>)}</ol>{!failure && applied?.kind !== 'cancel' && <div>
        <button disabled={offline || !!state} onClick={() => void sendControl('pause')}>{state || 'PAUSE'}</button>
        <button disabled={offline || inFlight.current} onClick={() => setConfirm(true)}>CANCEL</button>
      </div>}</>}{decisions.map(d => <Decision key={`${d.runId}:${d.decisionId}`} event={d} resolved={resolutions.find(r => r.decisionId === d.decisionId)} client={client} offline={offline} />)}{control && <p>{controlMessage(control)}</p>}{failure && <p role="alert">CAD: FAIL · {failure.message}</p>}{error && <p role="alert">{error}</p>}{result && <h2>{result.summary}</h2>}{applied?.kind === 'cancel' && <h2>Work kept</h2>}{pictures.map((p, i) => i === 0 && glb ? <button className="jt-picture" key={p} onClick={() => setViewer(true)}>
        <img src={p} alt="Iso" />Iso · tap for 3D</button> : <img key={p} src={p} alt={pictureAlt(i)} />)}{glb && <button onClick={() => setViewer(true)}>OPEN 3D VIEW</button>}{arActionSlot}<Dimensions artifacts={artifacts} />{refs.filter(a => a.kind !== 'png').map(a => <a key={a.uri} href={a.uri} download>{downloadLabel[a.kind]}</a>)}{step && <a href={step.uri} download>DOWNLOAD STEP</a>}</div>
    <footer>
      <label htmlFor="jarvis-message">Message Jarvis</label>
      <textarea id="jarvis-message" placeholder="Describe the part you need" />
      <p className="jt-muted">Preview only. Messages are not sent.</p>
    </footer>{viewer && glb && <ThreadDialog close={closeViewer}>
      <ModelView uri={glb.uri} pictures={pictures} step={step?.uri} />
    </ThreadDialog>}{confirm && <ThreadDialog sheet close={closeConfirm}>
      <h2>Cancel request?</h2>
      <p>Jarvis stops at the next safe checkpoint. Work done so far stays in the thread.</p>
      <button disabled={inFlight.current} onClick={() => { void sendControl('cancel'); setConfirm(false); }}>CANCEL REQUEST</button>
    </ThreadDialog>}</main>;
}
