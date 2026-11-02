import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { JarvisThread } from "@/features/jarvis/thread/JarvisThread";
import { createPreview } from "@/features/jarvis/thread/preview-source";
import type { EventSource } from "@/features/jarvis/thread/event-source";
import type { ThreadClient } from "@/features/jarvis/thread/client";

// OVD-805 front door. Until the DesignGraph transport is connected (OVD-803), every run is the
// synthetic sample plate, and the page says so next to the composer.
const idleSource: EventSource = { retry() { }, listen(_events, connection) { connection(false); return () => { }; } };
const idleClient: ThreadClient = { resolve: () => Promise.resolve({ status: 409 }), control: () => Promise.resolve({ status: 409 }) };
const ANSWER_WITHIN_MS = 2_000;

export default function Jarvis() {
  const [request, setRequest] = useState<{ text: string; id: number } | null>(null);
  const run = useMemo(() => request ? createPreview({ prompt: request.text, answerWithinMs: ANSWER_WITHIN_MS }) : { source: idleSource, client: idleClient }, [request]);
  const send = useCallback((text: string) => setRequest(previous => ({ text, id: (previous?.id ?? 0) + 1 })), []);
  return <div className="jarvis-page">
    <nav className="jarvis-page-nav" aria-label="Jarvis"><Link to="/">← OverDrafter</Link><span>Sample run</span></nav>
    <JarvisThread {...run} runId="plate-preview" workingName="PLATE R1" request={request?.text} onSend={send}
      note={<p className="jt-muted">Sample run: Jarvis answers with a generated sample plate until live CAD jobs are connected. Unanswered choices use the best guess after {ANSWER_WITHIN_MS / 1000}s.</p>} />
  </div>;
}
