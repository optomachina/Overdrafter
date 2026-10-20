import { createElement, useEffect, useRef, useState } from 'react';
import { loadModelViewer } from './model-loader';

type ModelElement = HTMLElement & { cameraOrbit: string; cameraTarget: string; fieldOfView: string; jumpCameraToGoal(): void; getCameraOrbit(): { theta: number; phi: number; radius: number }; getFieldOfView(): number };
const hasWebGL = () => !!document.createElement('canvas').getContext('webgl2');
const CAMERA_CONTROLS = ['ROTATE', 'ZOOM IN', 'ZOOM OUT', 'FIT'] as const;

/** Applies one button's camera change, then always snaps to the new goal (every control moves the camera). */
function moveCamera(m: ModelElement, label: typeof CAMERA_CONTROLS[number]) {
  if (label === 'ROTATE') {
    const orbit = m.getCameraOrbit();
    m.cameraOrbit = `${orbit.theta + Math.PI / 4}rad ${orbit.phi}rad ${orbit.radius}m`;
  } else if (label === 'FIT') {
    // Panning is on by default and moves the target, so FIT must also return the target to the model's centre.
    m.cameraOrbit = 'auto auto auto';
    m.cameraTarget = 'auto auto auto';
    m.fieldOfView = 'auto';
  } else {
    m.fieldOfView = `${Math.min(90, Math.max(5, m.getFieldOfView() * (label === 'ZOOM IN' ? 0.8 : 1.25)))}deg`;
  }
  m.jumpCameraToGoal();
}

export function ModelView({ uri, pictures, step, webgl = hasWebGL }: Readonly<{ uri: string; pictures: string[]; step?: string; webgl?: () => boolean }>) {
  const [state, setState] = useState('loading');
  const [attempt, setAttempt] = useState(0);
  // A failed import() is cached for the life of the page, so when the viewer script itself fails only a reload can recover it.
  const [scriptFailed, setScriptFailed] = useState(false);
  const model = useRef<ModelElement>(null), intro = useRef<HTMLParagraphElement>(null);
  // model-viewer 4.4.0 caches a failed GLB load as an empty model under the exact URL, so a retry of the same URL fails forever.
  // A fragment is a new cache key and never reaches the server, which keeps signed URLs valid.
  const src = attempt === 0 ? uri : `${uri.split('#')[0]}#retry-${attempt}`;
  useEffect(() => {
    let alive = true;
    try {
      if (!webgl()) { setState('error'); return; }
      setState('loading');
      loadModelViewer().catch(() => { if (alive) { setScriptFailed(true); setState('error'); } });
    } catch { setState('error'); }
    return () => { alive = false; };
  }, [attempt, webgl]);
  useEffect(() => {
    const element = model.current;
    const load = () => setState('ready'), error = () => setState('error');
    element?.addEventListener('load', load); element?.addEventListener('error', error);
    return () => { element?.removeEventListener('load', load); element?.removeEventListener('error', error); };
  }, [attempt, state]);
  // TRY AGAIN removes itself, so move focus to a stable element first instead of letting it fall to the page body.
  const retry = () => { intro.current?.focus(); setState('loading'); setAttempt(a => a + 1); };
  return <>
    <p ref={intro} tabIndex={-1}>Derived review view; STEP is authoritative.</p>{state === 'error' ? <>
      <p role="alert">3D view · Unavailable. This device could not open the 3D view. The pictures and the STEP file are still available.{scriptFailed && ' Reload the page to try again.'}</p>{pictures.map((p, i) => <img key={p} src={p} alt={i === 0 ? 'Iso' : 'Top view'} />)}{!scriptFailed && <button onClick={retry}>TRY AGAIN</button>}
    </> : <>{state === 'loading' && <output>Loading 3D model</output>}{createElement('model-viewer', { key: attempt, ref: model, src, 'camera-controls': true, 'interaction-prompt': 'none', alt: 'Derived model review' })}<p>Drag to orbit. Pinch to zoom.</p>{CAMERA_CONTROLS.map(label => <button key={label} disabled={state !== 'ready'} onClick={() => moveCamera(model.current!, label)}>{label}</button>)}</>}{step && <a href={step} download>DOWNLOAD STEP</a>}</>;
}
