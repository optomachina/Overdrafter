import { createElement, useEffect, useRef, useState } from 'react';
import { loadModelViewer } from './model-loader';

type ModelElement = HTMLElement & { cameraOrbit: string; fieldOfView: string; jumpCameraToGoal(): void; getCameraOrbit(): { theta: number; phi: number; radius: number }; getFieldOfView(): number };
const hasWebGL = () => !!document.createElement('canvas').getContext('webgl2');
export function ModelView({ uri, pictures, step, webgl = hasWebGL }: { uri: string; pictures: string[]; step?: string; webgl?: () => boolean }) {
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
      <p role="alert">3D view · Unavailable. This device could not open the 3D view. The pictures and the STEP file are still available.</p>{pictures.map(p => <img key={p} src={p} alt="Plate picture" />)}<button onClick={() => { setState('loading'); setAttempt(a => a + 1); }}>TRY AGAIN</button>
    </> : <>{state === 'loading' && <p role="status">Loading 3D model</p>}{createElement('model-viewer', { key: attempt, ref: model, src: uri, 'camera-controls': true, alt: 'Derived model review' })}<p>Drag to orbit. Pinch to zoom.</p>{['ROTATE', 'ZOOM IN', 'ZOOM OUT', 'FIT'].map((label, i) => <button key={label} disabled={state !== 'ready'} onClick={() => { const m = model.current!; if (i === 0) { const orbit = m.getCameraOrbit(); m.cameraOrbit = `${orbit.theta + Math.PI / 4}rad ${orbit.phi}rad ${orbit.radius}m`; } else if (i === 3) { m.cameraOrbit = 'auto auto auto'; m.fieldOfView = 'auto'; } else m.fieldOfView = `${Math.min(90, Math.max(5, m.getFieldOfView() * (i === 1 ? 0.8 : 1.25)))}deg`; m.jumpCameraToGoal(); }}>{label}</button>)}</>}{step && <a href={step} download>DOWNLOAD STEP</a>}</>;
}
