import { createElement, useEffect, useRef, useState } from 'react';
import { loadModelViewer } from './model-loader';

type ModelElement = HTMLElement & { cameraOrbit: string; fieldOfView: string; jumpCameraToGoal(): void; getCameraOrbit(): { theta: number; phi: number; radius: number }; getFieldOfView(): number };
const hasWebGL = () => !!document.createElement('canvas').getContext('webgl2');
const CAMERA_CONTROLS = ['ROTATE', 'ZOOM IN', 'ZOOM OUT', 'FIT'] as const;

/** Applies one button's camera change, then always snaps to the new goal (every control moves the camera). */
function moveCamera(m: ModelElement, label: typeof CAMERA_CONTROLS[number]) {
  if (label === 'ROTATE') {
    const orbit = m.getCameraOrbit();
    m.cameraOrbit = `${orbit.theta + Math.PI / 4}rad ${orbit.phi}rad ${orbit.radius}m`;
  } else if (label === 'FIT') {
    m.cameraOrbit = 'auto auto auto';
    m.fieldOfView = 'auto';
  } else {
    m.fieldOfView = `${Math.min(90, Math.max(5, m.getFieldOfView() * (label === 'ZOOM IN' ? 0.8 : 1.25)))}deg`;
  }
  m.jumpCameraToGoal();
}

export function ModelView({ uri, pictures, step, webgl = hasWebGL }: Readonly<{ uri: string; pictures: string[]; step?: string; webgl?: () => boolean }>) {
  const [state, setState] = useState('loading');
  const [attempt, setAttempt] = useState(0);
  const model = useRef<ModelElement>(null);
  useEffect(() => {
    let alive = true;
    try {
      if (!webgl()) { setState('error'); return; }
      setState('loading');
      loadModelViewer().catch(() => { if (alive) setState('error'); });
    } catch { setState('error'); }
    return () => { alive = false; };
  }, [attempt, webgl]);
  useEffect(() => {
    const element = model.current;
    const load = () => setState('ready'), error = () => setState('error');
    element?.addEventListener('load', load); element?.addEventListener('error', error);
    return () => { element?.removeEventListener('load', load); element?.removeEventListener('error', error); };
  }, [attempt, state]);
  return <>
    <p>Derived review view; STEP is authoritative.</p>{state === 'error' ? <>
      <p role="alert">3D view · Unavailable. This device could not open the 3D view. The pictures and the STEP file are still available.</p>{pictures.map((p, i) => <img key={p} src={p} alt={i === 0 ? 'Iso' : 'Top view'} />)}<button onClick={() => { setState('loading'); setAttempt(a => a + 1); }}>TRY AGAIN</button>
    </> : <>{state === 'loading' && <output>Loading 3D model</output>}{createElement('model-viewer', { key: attempt, ref: model, src: uri, 'camera-controls': true, alt: 'Derived model review' })}<p>Drag to orbit. Pinch to zoom.</p>{CAMERA_CONTROLS.map(label => <button key={label} disabled={state !== 'ready'} onClick={() => moveCamera(model.current!, label)}>{label}</button>)}</>}{step && <a href={step} download>DOWNLOAD STEP</a>}</>;
}
