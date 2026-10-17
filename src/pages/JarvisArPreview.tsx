import { useState, type ReactNode } from "react";
import { ArMoreAction } from "@/components/jarvis/ArMoreAction";
import posterUrl from "@/features/jarvis/ar/preview-assets/plate-thumb.png";

// Deliberately inert fixture URLs: this preview proves placement, not device launch.
const model = { name: "PLATE_R1", glbUrl: "https://example.invalid/plate.glb", usdzUrl: "https://example.invalid/plate.usdz", viewUrl: "https://example.invalid/models/plate" };
const statuses = ["ready", "loading", "failed"] as const;
function MockResult({ arActionSlot }: Readonly<{ arActionSlot: ReactNode }>) {
  return <section className="jarvis-ar-card"><h2>PLATE_R1</h2><p>Result area preview</p>
    <a className="jarvis-ar-row jarvis-ar-outline" href={model.viewUrl}>OPEN 3D</a>
    {arActionSlot}
  </section>;
}
export default function JarvisArPreview() {
  const [status, setStatus] = useState<typeof statuses[number]>("ready");
  return <main className="jarvis-ar-preview"><p>SAMPLE DATA</p><h1>Jarvis AR preview</h1>
    <fieldset className="jarvis-ar-controls"><legend>AR preview state</legend>
      {statuses.map((value) => <label className="jarvis-ar-row" key={value}>
        <input type="radio" name="ar-state" value={value} checked={status === value} onChange={() => setStatus(value)} />
        {value.toUpperCase()}
      </label>)}
    </fieldset>
    <MockResult arActionSlot={<ArMoreAction {...model} title="PLATE_R1" posterUrl={posterUrl} status={status} onRetry={() => setStatus("ready")} />} />
  </main>;
}
