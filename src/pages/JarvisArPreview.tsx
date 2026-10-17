import { useState } from "react";
import { ViewInArAction } from "@/features/jarvis/ar/ViewInArAction";

// Deliberately inert fixture URLs: this preview proves placement, not device launch.
const model = { name: "PLATE_R1", glbUrl: "https://example.invalid/plate.glb", usdzUrl: "https://example.invalid/plate.usdz", viewUrl: "https://example.invalid/models/plate" };
export default function JarvisArPreview() {
  const [more, setMore] = useState(false);
  return <main className="jarvis-ar-preview"><p>SAMPLE DATA</p><h1>Jarvis AR preview</h1>
    <section className="jarvis-ar-card"><h2>PLATE_R1</h2><p>Result card placement preview</p>
      <a className="jarvis-ar-row jarvis-ar-outline" href={model.viewUrl}>OPEN 3D</a>
      <button className="jarvis-ar-row" aria-expanded={more} aria-controls="ar-more" onClick={() => setMore(!more)}>MORE</button>
    </section>
    {more && <section id="ar-more" className="jarvis-ar-sheet" aria-label="PLATE_R1 options"><h2>PLATE_R1</h2>
      <ViewInArAction {...model} posterUrl="/placeholder.svg" onRetry={() => undefined} />
      <button className="jarvis-ar-row" onClick={() => setMore(false)}>Cancel</button>
    </section>}
  </main>;
}
