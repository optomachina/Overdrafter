import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ArrowDownToLine, ArrowUp, Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  getJobText, importContext, importResult, queue, restore, serialize,
  type Workbench, type WorkbenchRecord,
} from "@/features/engineering/prepared-workflow";

import { EngineeringConversationLayout, ConversationMessage, ProposalCard } from "@/features/engineering/EngineeringConversationLayout";
import { interpretPreparedMessage, confirmPreparedProposal, type ConversationReply, type ConversationClarification } from "@/features/engineering/prepared-conversation";
import { PreparedCadPanel } from "@/features/engineering/PreparedCadPanel";
import { parsePreparedPreview, restorePreparedPreviews, savePreparedPreviews, PREVIEW_IMPORT_LIMIT, type PreviewEntry } from "@/features/engineering/prepared-preview";

const PREVIEW_KEY = "overdrafter.engineering-previews.v1";
const STORAGE_KEY = "overdrafter.engineering-workbench.v1";
const CHECK_LABELS: Record<string, string> = {
  input_identity: "Input file identity",
  native_integrity: "Native model integrity",
  dimension: "Requested dimension",
  assembly_references: "Assembly references",
  component_placements: "Component positions",
  save_reopen: "Save and reopen",
  source_preservation: "Original files preserved",
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The operation could not be completed.";
}

async function readJsonFile(file: File): Promise<string> {
  // Preserve a possible BOM for the contract validator; File.text() discards it.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
}

function executionLabel(record: WorkbenchRecord): string {
  if (record.execution === "succeeded") return "Native execution succeeded";
  if (record.execution === "failed") return "Native execution failed";
  return "Waiting for Workstation result";
}

function verificationLabel(record: WorkbenchRecord): string {
  if (record.checks === "passed") return "Native checks passed (imported evidence)";
  if (record.checks === "failed") return "Checks failed or incomplete";
  return "Unverified";
}

function ResultDetails({ record }: { readonly record: WorkbenchRecord }) {
  const result = record.result;
  const measurements = result?.measurements;
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 divide-x border border-border text-sm sm:grid-cols-4">
        {[
          ["Decision", "Accepted for evaluation"],
          ["Execution", executionLabel(record)],
          ["Verification", verificationLabel(record)],
          ["Adoption", "Not adopted"],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0 p-3">
            <dt className="mb-2 text-xs text-muted-foreground">{label}</dt>
            <dd className="font-mono text-xs leading-relaxed">{value}</dd>
          </div>
        ))}
      </dl>
      {result?.failureReason && (
        <p className="border-l-2 border-destructive bg-muted/40 p-3 text-sm">
          <strong>Execution stopped.</strong> {result.failureReason}
        </p>
      )}
      {measurements && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="pb-3 text-left font-medium">Measured comparison</caption>
            <thead className="border-b text-xs text-muted-foreground">
              <tr><th scope="col" className="py-2">Measurement</th><th scope="col">Before</th><th scope="col">After</th></tr>
            </thead>
            <tbody className="font-mono text-sm">
              <tr className="border-b"><th scope="row" className="py-3 text-left font-normal">Depth (mm)</th><td>{measurements.beforeDepthMm}</td><td>{measurements.afterDepthMm}</td></tr>
              <tr className="border-b"><th scope="row" className="py-3 text-left font-normal">Volume (mm³)</th><td>{measurements.beforeVolumeMm3.toFixed(3)}</td><td>{measurements.afterVolumeMm3.toFixed(3)}</td></tr>
            </tbody>
          </table>
        </div>
      )}
      <div>
        <h3 className="mb-2 text-sm font-medium">Required checks</h3>
        <ul className="divide-y border-y border-border">
          {record.job.requiredChecks.map((id) => {
            const check = result?.checks.find((entry) => entry.id === id);
            let verdict = "Pending";
            if (result) verdict = "Missing";
            if (check) verdict = check.verdict === "pass" ? "Pass" : "Fail";
            return (
              <li key={id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span>{CHECK_LABELS[id] ?? id}</span>
                <span className="font-mono text-xs">{verdict}</span>
              </li>
            );
          })}
        </ul>
      </div>
      {result?.candidateRoot && (
        <div>
          <h3 className="text-sm font-medium">Private candidate on Workstation</h3>
          <p className="mt-2 break-all rounded border bg-muted/40 p-3 font-mono text-xs">{result.candidateRoot}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">This package has not been adopted in SolidWorks or PDM.</p>
        </div>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer py-1">Request identity and evidence</summary>
        <dl className="mt-2 space-y-2 break-all font-mono">
          <div><dt>Request</dt><dd>{record.job.jobId}</dd></div>
          <div><dt>Attempt</dt><dd>{record.job.attemptId}</dd></div>
          <div><dt>Request SHA-256</dt><dd>{record.requestSha256}</dd></div>
          {result?.checks.map((check) => (
            <div key={check.id}><dt>{CHECK_LABELS[check.id]} evidence SHA-256</dt><dd>{check.evidenceSha256}</dd></div>
          ))}
        </dl>
      </details>
    </div>
  );
}

/** Conversation decisions and imported geometry preserve the existing explicit operator handoff. */
export default function EngineeringWorkbench() {
  const [workbench, setWorkbench] = useState<Workbench | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [conversationOpen, setConversationOpen] = useState(false);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const [messages, setMessages] = useState<readonly { id: number; role: "user" | "assistant"; text: string; recordId?: string }[]>([]);
  const [reply, setReply] = useState<ConversationReply | null>(null);
  const [clarification, setClarification] = useState<ConversationClarification | null>(null);
  const [previews, setPreviews] = useState<readonly PreviewEntry[]>([]);
  const [cadView, setCadView] = useState<"baseline" | "candidate">("baseline");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewStorageBlocked, setPreviewStorageBlocked] = useState(false);
  const [busy, setBusy] = useState(true);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("Opening saved workbench…");
  const [confirmReset, setConfirmReset] = useState(false);
  const locked = useRef(true);
  const savedText = useRef<string | null>(null);
  const savedPreviews = useRef<string | null>(null);
  const messageId = useRef(0);
  const endOfConversation = useRef<HTMLDivElement>(null);
  const resetConfirmation = useRef<{ text: string | null } | null>(null);

  useEffect(() => {
    let active = true;
    async function openSaved() {
      try {
        const text = localStorage.getItem(STORAGE_KEY);
        savedText.current = text;
        const next = text === null ? null : await restore(text);
        if (!active) return;
        setWorkbench(next);
        setSelectedId(next?.records[0]?.job.jobId ?? null);
        setNotice(next ? "Saved workbench restored and revalidated." : "Import prepared context to begin.");
        try {
          const previewText = localStorage.getItem(PREVIEW_KEY);
          savedPreviews.current = previewText;
          const restored = next && previewText ? await restorePreparedPreviews(previewText, next) : [];
          if (active) setPreviews(restored);
        } catch (cause) {
          if (active) {
            setPreviewStorageBlocked(true);
            setNotice("Saved requests and results restored; CAD previews need attention.");
            setPreviewError(`Saved CAD previews could not be restored. Their saved bytes were kept, and requests and results are available. Use Reset workbench before importing replacement previews. ${errorMessage(cause)}`);
          }
        }
      } catch (cause) {
        if (!active) return;
        setStorageBlocked(true);
        setError(`Saved workbench could not be opened. No saved data was changed. ${errorMessage(cause)}`);
        setNotice("Refresh to retry, or explicitly reset the saved workbench.");
      } finally {
        if (active) { locked.current = false; setBusy(false); }
      }
    }
    void openSaved();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (messages.length || reply || error || previewError || (workbench?.records.length ?? 0) >= 5) setConversationOpen(true);
  }, [messages, reply, error, previewError, workbench?.records.length]);

  useEffect(() => {
    const input = messageInput.current;
    if (!input) return;
    const resize = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    };
    resize();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth !== width) { width = input.clientWidth; resize(); }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [message]);

  useEffect(() => {
    endOfConversation.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages.length, reply, workbench, conversationOpen, previewError]);

  async function mutate(operation: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    try { await operation(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { locked.current = false; setBusy(false); }
  }

  function assertCurrentStorage() {
    if (localStorage.getItem(STORAGE_KEY) !== savedText.current) {
      setStorageBlocked(true);
      throw new Error("The saved workbench changed in another tab. Refresh before continuing; your current view was kept.");
    }
  }
  function persist(next: Workbench) {
    const text = serialize(next);
    assertCurrentStorage();
    try { localStorage.setItem(STORAGE_KEY, text); }
    catch (cause) { throw new Error(`Could not save this change. Your previous workbench was kept. ${errorMessage(cause)}`); }
    savedText.current = text; setWorkbench(next);
  }

  function appendMessages(user: string, assistant: string) {
    const next = [
      { id: ++messageId.current, role: "user" as const, text: user },
      { id: ++messageId.current, role: "assistant" as const, text: assistant },
    ];
    setMessages((previous) => [...previous.slice(-38), ...next]);
  }
  function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (locked.current || storageBlocked || !message.trim()) return;
    try {
      assertCurrentStorage();
      const response = interpretPreparedMessage(message, workbench, clarification);
      appendMessages(message.trim(), response.message);
      setReply(response);
      setClarification(response.kind === "clarification" ? response.clarification : null);
      setMessage(""); setError(null);
    } catch (cause) { setError(errorMessage(cause)); }
  }
  function evaluateProposal() {
    if (!workbench || reply?.kind !== "proposal" || storageBlocked) return;
    const proposal = reply.proposal;
    void mutate(async () => {
      assertCurrentStorage();
      const depth = confirmPreparedProposal(proposal, workbench);
      const next = await queue(workbench, depth);
      persist(next);
      const acceptedId = next.records[next.records.length - 1].job.jobId;
      setSelectedId(acceptedId);
      const receiptMessage = { id: ++messageId.current, role: "assistant" as const, text: "", recordId: acceptedId };
      setMessages((previous) => [...previous.slice(-39), receiptMessage]);
      setCadView("baseline"); setReply(null); setClarification(null);
      setNotice("Decision saved. Download its request for the Workstation operator.");
    });
  }

  async function importNativeResultText(text: string) {
    if (!workbench) throw new Error("Import prepared context before a native result.");
    const next = await importResult(workbench, text);
    persist(next);
    const changed = next.records.find((record, index) => record.resultText !== workbench.records[index]?.resultText);
    if (changed) { setSelectedId(changed.job.jobId); setCadView("candidate"); setConversationOpen(true); }
    setNotice("Native result imported and matched to its exact request. Adoption remains unverified.");
  }

  async function importCadPreviewText(text: string) {
    if (!workbench) throw new Error("Import prepared context before its CAD preview.");
    const entry = await parsePreparedPreview(text, workbench);
    const saved = savePreparedPreviews(previews, entry);
    const validated = await restorePreparedPreviews(saved, workbench);
    assertCurrentStorage();
    if (localStorage.getItem(PREVIEW_KEY) !== savedPreviews.current) throw new Error("Saved CAD previews changed in another tab. Refresh before importing another preview.");
    try { localStorage.setItem(PREVIEW_KEY, saved); }
    catch (cause) { throw new Error(`Could not save the CAD preview. Existing previews were kept. ${errorMessage(cause)}`); }
    savedPreviews.current = saved; setPreviews(validated); setPreviewError(null);
    if (entry.preview.role === "candidate") {
      const matching = workbench.records.find((record) => record.requestSha256 === entry.preview.requestSha256);
      setSelectedId(matching?.job.jobId ?? null); setCadView("candidate");
    } else setCadView("baseline");
    setNotice("CAD preview imported. Exact STEP bytes and native package bindings match.");
  }

  function importFile(event: ChangeEvent<HTMLInputElement>, kind: "context" | "result" | "preview") {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || storageBlocked) return;
    void mutate(async () => {
      if (kind === "preview" && previewStorageBlocked) throw new Error("CAD preview imports are blocked to preserve saved evidence. Use Reset workbench before importing replacement previews.");
      if (file.size > (kind === "preview" ? PREVIEW_IMPORT_LIMIT : 2_000_000)) throw new Error("This import exceeds its file-size limit.");
      const text = await readJsonFile(file);
      assertCurrentStorage();
      if (kind === "context") {
        if (workbench) throw new Error("Reset the current workbench before importing different context.");
        const next = await importContext(text);
        persist(next); setReply(null); setClarification(null); setPreviews([]); setCadView("baseline");
        setNotice("Prepared context imported. Source files will be checked again on Workstation.");
      } else if (kind === "result") {
        await importNativeResultText(text);
      } else {
        await importCadPreviewText(text);
      }
    });
  }

  function download(record: WorkbenchRecord) {
    if (locked.current) return;
    try {
      const url = URL.createObjectURL(new Blob([getJobText(record)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `prepared-dimension-${record.job.jobId}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice("Request downloaded. Run it on Workstation, then import the returned result. Downloading does not start CAD.");
    } catch (cause) { setError(`Could not download the request. ${errorMessage(cause)}`); }
  }
  function openResetDialog() {
    if (locked.current) return;
    resetConfirmation.current = null;
    try {
      const text = localStorage.getItem(STORAGE_KEY);
      if (text !== savedText.current) { setStorageBlocked(true); throw new Error("The saved workbench changed in another tab. Refresh to review it before opening a new reset confirmation."); }
      resetConfirmation.current = { text }; setError(null); setConfirmReset(true);
    } catch (cause) { setError(`Could not prepare reset. No saved data was changed. ${errorMessage(cause)}`); }
  }
  function closeResetDialog() {
    if (locked.current) return;
    resetConfirmation.current = null; setConfirmReset(false);
  }
  function resetWorkbench() {
    void mutate(async () => {
      const confirmation = resetConfirmation.current;
      if (localStorage.getItem(STORAGE_KEY) !== confirmation?.text) {
        resetConfirmation.current = null; setConfirmReset(false); setStorageBlocked(true);
        throw new Error("The saved workbench changed after this confirmation opened. No saved data was changed. Refresh to review it and confirm reset again.");
      }
      try { localStorage.removeItem(STORAGE_KEY); }
      catch (cause) { throw new Error(`Could not reset the workbench. Saved data was kept. ${errorMessage(cause)}`); }
      savedText.current = null; resetConfirmation.current = null;
      setWorkbench(null); setSelectedId(null); setStorageBlocked(false); setConfirmReset(false);
      setMessages([]); setReply(null); setClarification(null); setPreviews([]); setCadView("baseline");
      setNotice("Local workbench reset. Import prepared context to begin.");
      // Orphaned preview bytes are harmless: every future import/restore rebinds them to context.
      if (localStorage.getItem(PREVIEW_KEY) === savedPreviews.current) {
        try { localStorage.removeItem(PREVIEW_KEY); savedPreviews.current = null; setPreviewStorageBlocked(false); setPreviewError(null); }
        catch { setPreviewStorageBlocked(true); setPreviewError("Requests were reset; saved preview bytes could not be cleared. They will not display without matching context and evidence. Refresh and use Reset workbench before importing replacement previews."); }
      } else {
        setPreviewStorageBlocked(true);
        setPreviewError("Requests were reset; newer CAD previews from another tab were kept. Refresh before continuing.");
      }
    });
  }

  const selected = workbench?.records.find((record) => record.job.jobId === selectedId);
  const disabled = busy || storageBlocked;
  const atCapacity = (workbench?.records.length ?? 0) >= 5;
  const contextSummary = workbench ? <><p className="font-medium">synthetic-assembly.SLDASM</p><p className="mt-1 text-xs text-muted-foreground">Two components · Default · Original depth 5 mm</p></> : <p className="text-muted-foreground">Choose a prepared assembly to begin.</p>;
  const renderDecision = (record: WorkbenchRecord, index: number) => <ConversationMessage role="assistant" key={record.job.jobId}>
      <button type="button" disabled={disabled} aria-pressed={selectedId === record.job.jobId} onClick={() => { setSelectedId(record.job.jobId); setCadView("baseline"); }} className="w-full rounded-lg border px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="font-medium">{String(index + 1).padStart(2, "0")} · 5 → {record.job.depthMm} mm</span><span className="mt-1 block text-xs text-muted-foreground">{executionLabel(record)}</span>
      </button>
      {selectedId === record.job.jobId && <div className="space-y-3">
        <p>{record.checks === "passed" ? `The native model measured ${record.result?.measurements?.afterDepthMm} mm. All required checks passed. The candidate is ready for your review.` : "Your evaluation decision is saved. The original assembly remains the baseline while the Workstation result is pending or incomplete."}</p>
        <p className="text-xs text-muted-foreground">{verificationLabel(record)} · Not adopted</p>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => download(record)}><ArrowDownToLine className="size-3.5" aria-hidden="true" />Download request JSON</Button>
        <details className="rounded-lg border px-3 py-1"><summary className="cursor-pointer py-2 text-xs font-medium">Checks and measured results</summary><div className="py-3"><ResultDetails record={record} /></div></details>
      </div>}
    </ConversationMessage>;
  const conversation = <>
    {workbench?.records.filter((record) => !messages.some((item) => item.recordId === record.job.jobId)).map((record) => renderDecision(record, workbench.records.indexOf(record)))}
    {messages.map((item) => {
      const record = item.recordId ? workbench?.records.find((entry) => entry.job.jobId === item.recordId) : undefined;
      if (record && workbench) return renderDecision(record, workbench.records.indexOf(record));
      return <ConversationMessage key={item.id} role={item.role}><p className="whitespace-pre-wrap">{item.text}</p></ConversationMessage>;
    })}
    {reply?.kind === "proposal" && <ProposalCard><p className="mb-1 text-xs text-muted-foreground">Proposed evaluation</p><p className="text-xl font-medium">5 → {reply.proposal.depthMm} mm</p><p className="mt-2 text-xs text-muted-foreground">Private candidate · preserve both component positions · rebuild, save/reopen and all seven checks</p><div className="mt-4 flex flex-wrap gap-2"><Button disabled={disabled || atCapacity} onClick={evaluateProposal}><Check className="size-4" aria-hidden="true" />Evaluate this change</Button><Button variant="ghost" disabled={disabled} onClick={() => { setReply(null); setClarification(null); setNotice("Proposal canceled. No evaluation request was saved."); }}>Cancel proposal</Button></div></ProposalCard>}
    {atCapacity && <p className="text-xs text-muted-foreground">Five decisions are recorded. Review them before explicitly resetting this workbench.</p>}
    {error && !confirmReset && <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm">{error}</p>}
    {previewError && <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm">{previewError}</p>}
    <p role="status" aria-live="polite" className="text-xs leading-5 text-muted-foreground">{notice}</p><div ref={endOfConversation} />
  </>;
  const composer = <form onSubmit={sendMessage} className="flex items-end gap-2">
    <label className="sr-only" htmlFor="engineering-message">Message</label>
    <textarea ref={messageInput} id="engineering-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ask OverDrafter…" rows={1} maxLength={512} disabled={disabled || atCapacity} className="min-h-10 max-h-40 min-w-0 flex-1 resize-none border-0 bg-transparent px-3 py-2 text-base leading-6 text-white outline-none placeholder:text-neutral-400 disabled:opacity-50" />
    <Button type="submit" aria-label="Send message" size="icon" className="size-10 shrink-0 rounded-full bg-white text-black hover:bg-neutral-200 disabled:opacity-30" disabled={disabled || atCapacity || !message.trim()}><ArrowUp className="size-4" aria-hidden="true" /></Button>
  </form>;
  const toolsPanel = <div className="space-y-4 text-xs">
    <p className="leading-5 text-muted-foreground">Operator controls for this local prepared-assembly workflow. The browser does not dispatch or monitor SolidWorks. Native files stay on Workstation.</p>
    {!workbench && <div><label htmlFor="context-file" className="mb-2 block font-medium">Import prepared context</label><Input id="context-file" type="file" accept=".json,application/json" disabled={disabled} onChange={(event) => importFile(event, "context")} /></div>}
    {workbench && <>
      <div><label htmlFor="result-file" className="mb-2 block font-medium">Import native result</label><Input id="result-file" type="file" accept=".json,application/json" disabled={disabled} onChange={(event) => importFile(event, "result")} /></div>
      <div><label htmlFor="preview-file" className="mb-2 block font-medium">Import CAD preview</label><Input id="preview-file" type="file" accept=".json,application/json" disabled={disabled || previewStorageBlocked} onChange={(event) => importFile(event, "preview")} /><p className="mt-2 text-muted-foreground">Import a baseline export or the exact completed candidate export. STEP bytes and native source identities are rechecked on refresh.</p></div>
      <details><summary className="cursor-pointer py-1">Context identity and limits</summary><p className="my-2 break-all font-mono">{workbench.contextSha256}</p><ul className="list-inside list-disc space-y-1">{workbench.context.limitations.map((line) => <li key={line}>{line}</li>)}</ul></details>
    </>}
    <p className="leading-5 text-muted-foreground">Accepted decisions and evidence are saved locally. Unconfirmed conversation messages stay in this tab. Imported evidence is checked for consistency; its origin is not authenticated.</p>
    {(workbench || storageBlocked) && <Button variant="outline" size="sm" disabled={busy} onClick={openResetDialog}><RotateCcw className="size-3.5" aria-hidden="true" />Reset workbench</Button>}
  </div>;
  return <>
    <EngineeringConversationLayout conversationOpen={conversationOpen} onConversationToggle={() => setConversationOpen((open) => !open)} conversation={conversation} composer={composer} cadPanel={<PreparedCadPanel workbench={workbench} record={selected} entries={previews} view={cadView} onView={setCadView} />} toolsPanel={toolsPanel} contextSummary={contextSummary} />
    <AlertDialog open={confirmReset} onOpenChange={(open) => { if (!open) closeResetDialog(); }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Reset the local workbench?</AlertDialogTitle><AlertDialogDescription>This removes the saved context, queued decisions, imported results, and CAD previews from this browser. Exported files on your computers are kept. If saved data changes, refresh and review it before resetting.</AlertDialogDescription></AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter><Button variant="outline" disabled={busy} onClick={closeResetDialog}>Keep workbench</Button><Button variant="destructive" disabled={busy} onClick={resetWorkbench}>Reset saved workbench</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
