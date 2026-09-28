import { useEffect, useRef, useState } from "react";
import { EngineeringConversationLayout, ConversationMessage } from "@/features/engineering/EngineeringConversationLayout";
import { connectPlateSession, plateApiPath, plateSession, requestPlate } from "@/features/engineering/sample-plate-client";
import type { Run } from "../../server/engineering/sample-plate-dispatch";

const checkLabels: Record<string, string> = { dimensions: "4 × 4 × ¼ in dimensions", material: "6061 Alloy material", holes: "Four through holes on a 3 × 3 in square", corners: "R½ in corners concentric with holes", threadMetadata: "Native ¼-20 UNC 2B through taps", stepDimensions: "STEP dimensions", stepHoles: "STEP through-hole geometry", stepCorners: "STEP corner geometry", documentsPreserved: "Existing documents preserved" };
export default function EngineeringPlateDemo({ privateAccess = false }: { readonly privateAccess?: boolean }) {
  const [csrf, setCsrf] = useState(""); const [run, setRun] = useState<Run>();
  const [instruction, setInstruction] = useState(""); const [error, setError] = useState("");
  const [open, setOpen] = useState(false); const [sending, setSending] = useState(false);
  const pendingId = useRef<string>();
  useEffect(() => {
    document.title = "OverDrafter | Sample plate";
    let disposed = false;
    const update = (session: Awaited<ReturnType<typeof plateSession>>) => {
      if (!disposed) { setCsrf(session.csrf); setRun(session.runs.at(-1)); setError(""); }
    };
    const connect = () => { void connectPlateSession().then(update).catch(e => { if (!disposed) setError(String(e.message)); }); };
    connect(); window.addEventListener("hashchange", connect);
    const timer = setInterval(() => { void plateSession().then(update).catch(() => {}); }, 1000);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener("hashchange", connect); };
  }, []);
  const reserved = privateAccess || (!!run && run.status !== "denied");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (sending || reserved || !csrf) return;
    setSending(true); setError("");
    pendingId.current ??= crypto.randomUUID().replace(/-/g, "");
    try { setRun(await requestPlate(csrf, pendingId.current, instruction)); }
    catch (e) { setError(e instanceof Error ? e.message : "Request not confirmed"); }
    finally { setSending(false); }
  }
  return <EngineeringConversationLayout title={privateAccess ? "Verified sample plate" : "Build the sample plate"} conversationOpen={open} onConversationToggle={() => setOpen(!open)}
    contextSummary={<p>{privateAccess ? "Private paired view of the verified Windows sample. Building is disabled." : "Local sample demo. Connected only to this Windows workstation."}</p>}
    toolsPanel={<p className="text-sm text-muted-foreground">One new plate per local launch workspace. Uncertain outcomes require inspection; the app never retries native work automatically.</p>}
    conversation={<><ConversationMessage role="assistant">{privateAccess ? "Review the completed sample and its checked files. This private view cannot start a new build." : "Ask “Build the sample plate.” Jev checks your instruction; SolidWorks builds the fixed recipe shown above."}</ConversationMessage>{run && <><ConversationMessage role="user">{run.instruction}</ConversationMessage><ConversationMessage role="assistant">{run.message}</ConversationMessage></>}</>}
    composer={privateAccess ? <p className="px-5 py-4 text-sm">Verified sample · new builds disabled</p> : <form onSubmit={submit} className="flex items-center gap-2 px-3 py-2">
      <input aria-label="Plate instruction" placeholder="Build the sample plate" value={instruction} disabled={reserved || sending}
        onChange={e => { setInstruction(e.target.value); if (run?.status === "denied") pendingId.current = undefined; }} className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm outline-none" />
      <button disabled={!csrf || reserved || sending || !instruction.trim()} className="rounded-full bg-white px-5 py-2 text-sm font-medium text-black disabled:opacity-40" type="submit">{sending ? "Sending…" : "Build"}</button>
    </form>}
    cadPanel={<div className="mx-auto grid max-w-5xl gap-8 px-6 py-8 md:grid-cols-2">
      <div><p className="text-xs uppercase tracking-widest text-muted-foreground">{privateAccess ? "Private verified sample" : "Local SolidWorks sample"}</p><h2 className="mt-3 text-3xl font-semibold">Your sample plate.</h2>
        <p className="mt-4 text-muted-foreground">4 × 4 × ¼ in · 6061 Alloy</p><p className="mt-2 text-sm text-muted-foreground">Four ¼-20 UNC 2B through taps on a 3 × 3 in square. R½ in outer corners concentric with the holes.</p>
        <svg viewBox="0 0 240 240" role="img" aria-label="Illustration of the fixed sample recipe, not a CAD preview" className="mx-auto mt-6 w-64 max-w-full"><rect x="20" y="20" width="200" height="200" rx="25" fill="#d5dee3" stroke="#647887" strokeWidth="2"/>{[[45,45],[45,195],[195,45],[195,195]].map(([x,y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="6.25" fill="white" stroke="#647887" strokeWidth="2"/>)}<path d="M45 45H195V195H45Z" fill="none" stroke="#8399a6" strokeDasharray="4 4"/></svg><p className="text-center text-xs text-muted-foreground">Recipe illustration · cosmetic threads in native file</p>
      </div>
      <section aria-label="Build result" className="rounded-2xl border border-border p-6"><p className="text-xs uppercase tracking-widest text-muted-foreground">{run?.status ?? (csrf ? "Ready" : "Connecting")}</p>
        <output className="mt-3 block text-lg font-medium">{run?.message ?? "Enter an instruction to build this exact sample."}</output>{error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
        {run?.result && <><ul className="mt-5 space-y-2 text-sm">{Object.entries(run.result.checks).map(([name, passed]) => <li key={name}>{passed ? "✓" : "✕"} {checkLabels[name] ?? name}</li>)}</ul><div className="mt-6 flex gap-4">{run.result.files.map(file => <a className="text-sm underline" key={file.name} href={plateApiPath(`/files/${run.id}/${file.name}`)}>Download {file.name.split(".").at(-1)}</a>)}</div><p className="mt-4 text-xs text-muted-foreground">STEP contains hole geometry. Native SLDPRT also records thread specifications; no helical thread solids.</p></>}
        {run?.decision && <p className="mt-6 text-xs text-muted-foreground">Jev {run.decision.model}: {(run.decision.elapsedMs / 1000).toFixed(2)} s · {run.decision.inputTokens} input / {run.decision.outputTokens} output tokens · ${run.decision.costUsd.toFixed(8)} inference. {run.result && `Build and checks: ${run.result.elapsedSeconds.toFixed(2)} s.`}</p>}
      </section>
    </div>} />;
}
