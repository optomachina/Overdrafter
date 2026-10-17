import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { GraphDecisionRequestedEvent, GraphDecisionResolvedEvent, GraphEvent } from '../core/types';
import type { ThreadClient } from './client';
import type { EventSource } from './event-source';
import { ModelView } from './ModelView';
import { ThreadDialog } from './ThreadDialog';
import './thread.css';

function Decision({ event, resolved, client, offline }: { event: GraphDecisionRequestedEvent; resolved?: GraphDecisionResolvedEvent; client: ThreadClient; offline: boolean }) {
  const [selected, select] = useState(event.recommended);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), key = useRef(crypto.randomUUID());
  const send = async (skip: boolean) => {
    if (locked.current) return;
    locked.current = true; setPending(true); setError('');
    try {
      const response = await client.resolve(event.runId, event.decisionId, { resolution: skip ? 'skipped_best_guess' : 'chosen', choice: skip ? undefined : selected, idempotencyKey: key.current });
      if (response.status >= 400) throw new Error(response.status === 403 ? '403 · This decision could not be resolved.' : 'The decision could not be saved.');
    } catch (e) { setError(e instanceof Error ? e.message : 'The decision could not be saved.'); locked.current = false; setPending(false); }
  };
  return <section>
    <h2>{event.question}</h2>{resolved ? <>
      <p>{resolved.outcome === 'skipped_best_guess' ? resolved.cause === 'timeout' ? 'No answer in time. Best guess recorded' : 'Best guess recorded' : 'Choice recorded'} · {resolved.choice}</p>
      <p>{resolved.rationale}</p>
      <a href="#jarvis-message" onClick={() => document.getElementById("jarvis-message")?.focus()}>Change</a>
    </> : <>
      <div role="radiogroup" aria-label={event.question}>{event.options.map((option, i) => <button key={option} role="radio" aria-checked={selected === option} tabIndex={selected === option ? 0 : -1} disabled={pending || offline} onClick={() => select(option)} onKeyDown={e => {
        if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault(); const next = e.key === 'Home' ? 0 : e.key === 'End' ? event.options.length - 1 : (i + (['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : -1) + event.options.length) % event.options.length;
        select(event.options[next]); (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
      }}>{selected === option ? '●' : '○'} {option}</button>)}</div>
      <p id={`skip-${event.seq}`}>If you skip, Jarvis uses its best guess, {event.bestGuess}, records it in the design history, and keeps going. You can change it later.</p>
      <div className="jt-actions">
        <button className="jt-primary" disabled={pending || offline} onClick={() => void send(false)}>APPROVE {selected}</button>
        <button aria-describedby={`skip-${event.seq}`} disabled={pending || offline} onClick={() => void send(true)}>{pending ? 'SAVING' : 'SKIP'}</button>
      </div>
    </>}{error && <p role="alert">{error}</p>}</section>;
}

export function JarvisThread({ source, client, runId, arActionSlot, workingName = "candidate" }: { source: EventSource; client: ThreadClient; runId: string; workingName?: string; arActionSlot?: ReactNode }) {
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
  const status = events.filter(e => e.type === 'status').at(-1);
  const decisions = events.filter(e => e.type === 'decision_requested');
  const resolutions = events.filter(e => e.type === 'decision_resolved');
  const pending = decisions.some(d => !resolutions.some(r => r.decisionId === d.decisionId));
  const control = events.filter(e => e.type === 'control_requested' || e.type === 'control_applied' || e.type === 'control_rejected').at(-1);
  useEffect(() => { if (control?.type === 'control_applied' || control?.type === 'control_rejected') { inFlight.current = false; setCommand(''); } }, [control]);
  const applied = control?.type === 'control_applied' ? control : undefined;
  const result = events.find(e => e.type === 'result');
  const failure = events.find(e => e.type === 'error');
  const artifacts = events.filter(e => e.type === 'artifact');
  const refs = applied?.kind === 'cancel' ? applied.kept : result?.artifacts ?? artifacts;
  const pictures = refs.filter(a => a.kind === 'png').map(a => a.uri), glb = refs.find(a => a.kind === 'glb'), step = refs.find(a => a.kind === 'step');
  const working = artifacts.length ? workingName : !pending && !failure && status?.nodeId === 'domain_agent' ? `${workingName}${offline ? '' : ' (in progress)'}` : 'none';
  const state = applied?.state ?? (control?.type === 'control_requested' ? control.kind === 'pause' ? 'Pausing' : 'Cancelling' : command);
  const sendControl = async (kind: 'pause' | 'cancel') => {
    if (inFlight.current) return;
    inFlight.current = true; setCommand(kind === 'pause' ? 'Pausing' : 'Cancelling'); setError('');
    const key = keys.current.get(kind) ?? crypto.randomUUID(); keys.current.set(kind, key);
    try { const response = await client.control(runId, { kind, idempotencyKey: key }); if (response.status >= 400) throw new Error('Control request failed.'); }
    catch { inFlight.current = false; setCommand(''); setError('Control request failed. Try again.'); }
  };
  return <main className="jt">
    <header>
      <h1>Jarvis</h1>
    </header>
    <div className="jt-state" aria-label="Baseline and design state">{offline && 'Offline · '}Working {working} · Committed none{offline && <button onClick={() => source.retry()}>RETRY</button>}</div>
    <div className="jt-log" aria-live="polite">{!events.length && <p>No requests yet. Example: Make a 4 inch square plate.</p>}{status && <p>{status.message}</p>}{events.length > 0 && !result && <>
      <ol className="jt-lanes">{(['concept_picks', 'domain_agent', 'verify'] as const).map((node, i) => <li key={node}>
        <span>{['Concept picks', 'CAD model', 'Independent check'][i]}</span>
        <span>{node === 'domain_agent' && pending ? 'WAITS FOR YOU' : status?.nodeId === node ? `${offline ? 'LAST SEEN ' : ''}${state || 'WORKING'} · ${Math.max(0, Math.floor((now - status.at) / 1000))}s` : events.some(e => e.type === 'status' && e.nodeId === node && e.state === 'completed') ? 'DONE' : 'WAITING'}</span>
      </li>)}</ol>{!failure && applied?.kind !== 'cancel' && <div>
        <button disabled={offline || !!state} onClick={() => void sendControl('pause')}>{state || 'PAUSE'}</button>
        <button disabled={offline || inFlight.current} onClick={() => setConfirm(true)}>CANCEL</button>
      </div>}</>}{decisions.map(d => <Decision key={`${d.runId}:${d.decisionId}`} event={d} resolved={resolutions.find(r => r.decisionId === d.decisionId)} client={client} offline={offline} />)}{control && <p>{control.type === 'control_applied' ? `You ${control.state} the job at a checkpoint.` : control.type === 'control_rejected' ? `Control rejected · ${control.reason}` : control.kind === 'pause' ? 'Pausing · Waiting for checkpoint' : 'Cancelling · Waiting for checkpoint'}</p>}{failure && <p role="alert">CAD: FAIL · {failure.message}</p>}{error && <p role="alert">{error}</p>}{result && <h2>{result.summary}</h2>}{applied?.kind === 'cancel' && <h2>Work kept</h2>}{pictures.map((p, i) => i === 0 && glb ? <button className="jt-picture" key={p} onClick={() => setViewer(true)}>
        <img src={p} alt="Iso" />Iso · tap for 3D</button> : <img key={p} src={p} alt="Top view" />)}{glb && <button onClick={() => setViewer(true)}>OPEN 3D VIEW</button>}{arActionSlot}{artifacts.find(a => a.dimensionsMm)?.dimensionsMm && (() => {
          const d = artifacts.find(a => a.dimensionsMm)!.dimensionsMm!; return <>
            <p>{[d.x, d.y, d.z].map(n => (n / 25.4).toFixed(3)).join(' × ')} in</p>
            <p className="jt-muted">{[d.x, d.y, d.z].map(n => n.toFixed(3)).join(' × ')} mm</p>
          </>;
        })()}{refs.filter(a => a.kind !== 'png').map(a => <a key={a.uri} href={a.uri} download>{a.kind === 'step' ? '.STEP AUTHORITATIVE' : '.GLB REVIEW VIEW'}</a>)}{step && <a href={step.uri} download>DOWNLOAD STEP</a>}</div>
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
