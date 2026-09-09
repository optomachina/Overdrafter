import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ArrowDownToLine, ArrowRight, FileBox, FileJson, RotateCcw } from "lucide-react";
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

function ResultDetails({ record }: { record: WorkbenchRecord }) {
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

/** Local operator workbench: saved intent and imported evidence never imply automatic dispatch. */
export default function EngineeringWorkbench() {
  const [workbench, setWorkbench] = useState<Workbench | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [depth, setDepth] = useState("8");
  const [busy, setBusy] = useState(true);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("Opening saved workbench…");
  const [confirmReset, setConfirmReset] = useState(false);
  const locked = useRef(true);
  const savedText = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    async function openSaved() {
      try {
        const text = localStorage.getItem(STORAGE_KEY);
        const next = text === null ? null : await restore(text);
        if (!active) return;
        savedText.current = text;
        setWorkbench(next);
        setSelectedId(next?.records[0]?.job.jobId ?? null);
        setNotice(next ? "Saved workbench restored and revalidated." : "Import prepared context to begin.");
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

  async function mutate(operation: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { locked.current = false; setBusy(false); }
  }

  function persist(next: Workbench) {
    const text = serialize(next);
    if (localStorage.getItem(STORAGE_KEY) !== savedText.current) {
      setStorageBlocked(true);
      throw new Error("The saved workbench changed in another tab. Refresh before continuing; your current view was kept.");
    }
    try { localStorage.setItem(STORAGE_KEY, text); }
    catch (cause) { throw new Error(`Could not save this change. Your previous workbench was kept. ${errorMessage(cause)}`); }
    savedText.current = text;
    setWorkbench(next);
  }

  function importFile(event: ChangeEvent<HTMLInputElement>, kind: "context" | "result") {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || storageBlocked) return;
    void mutate(async () => {
      const text = await readJsonFile(file);
      if (kind === "context") {
        if (workbench) throw new Error("Reset the current workbench before importing different context.");
        const next = await importContext(text);
        persist(next);
        setNotice("Prepared context imported. Source files will be checked again on Workstation.");
      } else {
        if (!workbench) throw new Error("Import prepared context before a native result.");
        const next = await importResult(workbench, text);
        persist(next);
        const changed = next.records.find((record, index) => record.resultText !== workbench.records[index]?.resultText);
        if (changed) setSelectedId(changed.job.jobId);
        setNotice("Native result imported and matched to its exact request. Adoption remains unverified.");
      }
    });
  }

  function queueChange(event: FormEvent) {
    event.preventDefault();
    if (!workbench || storageBlocked) return;
    void mutate(async () => {
      const next = await queue(workbench, Number(depth));
      persist(next);
      setSelectedId(next.records[next.records.length - 1].job.jobId);
      setNotice("Decision saved. Download its request for the Workstation operator.");
    });
  }

  function download(record: WorkbenchRecord) {
    if (locked.current) return;
    try {
      const url = URL.createObjectURL(new Blob([getJobText(record)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `prepared-dimension-${record.job.jobId}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice("Request downloaded. Run it on Workstation, then import the returned result. Downloading does not start CAD.");
    } catch (cause) { setError(`Could not download the request. ${errorMessage(cause)}`); }
  }

  function resetWorkbench() {
    void mutate(async () => {
      try { localStorage.removeItem(STORAGE_KEY); }
      catch (cause) { throw new Error(`Could not reset the workbench. Saved data was kept. ${errorMessage(cause)}`); }
      savedText.current = null;
      setWorkbench(null);
      setSelectedId(null);
      setStorageBlocked(false);
      setConfirmReset(false);
      setNotice("Local workbench reset. Import prepared context to begin.");
    });
  }

  const selected = workbench?.records.find((record) => record.job.jobId === selectedId);
  const disabled = busy || storageBlocked;
  const atCapacity = (workbench?.records.length ?? 0) >= 5;

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-7 flex flex-wrap items-start justify-between gap-4 border-b pb-6">
          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">OverDrafter / Internal engineering</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Prepared assembly workbench</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">Queue a dimension change, run the saved request on Workstation, and compare its native result.</p>
          </div>
          {(workbench || storageBlocked) && <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmReset(true)}><RotateCcw aria-hidden="true" />Reset workbench</Button>}
        </header>
        <p className="mb-5 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">Synthetic assembly · local browser storage · operator handoff. Imported evidence is checked for consistency; this browser does not authenticate its origin or inspect native files.</p>
        {error && !confirmReset && <p role="alert" className="mb-4 border border-destructive/50 bg-card p-4 text-sm">{error}</p>}
        <p role="status" aria-live="polite" className="mb-5 text-sm text-muted-foreground">{notice}</p>
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.8fr)]" aria-busy={busy}>
          <section aria-labelledby="context-heading" className="min-w-0 border bg-card">
            <div className="border-b px-5 py-4"><h2 id="context-heading" className="flex items-center gap-2 text-lg font-medium"><FileBox className="size-4" aria-hidden="true" />Prepared context</h2></div>
            <div className="space-y-5 p-5">
              {!workbench && <div className="space-y-3"><p className="text-sm leading-relaxed text-muted-foreground">Import the context JSON captured from the prepared assembly on Workstation. Native CAD files stay on that machine.</p><label htmlFor="context-file" className="block text-sm font-medium">Import prepared context</label><Input id="context-file" type="file" accept=".json,application/json" disabled={disabled} onChange={(event) => importFile(event, "context")} /></div>}
              {workbench && <>
                <div><p className="break-all font-mono text-base">{workbench.context.assemblyPath}</p><p className="mt-2 text-xs text-muted-foreground">Configuration <span className="font-mono text-foreground">{workbench.context.configuration}</span> · {workbench.context.files.length} files</p></div>
                <ul className="space-y-2 border-y py-3">{workbench.context.files.map((file) => <li key={file.path} className="break-all font-mono text-xs leading-relaxed">{file.path}<span className="block text-muted-foreground">{file.bytes.toLocaleString()} bytes</span></li>)}</ul>
                <div><p className="text-xs text-muted-foreground">Baseline depth</p><p className="mt-1 font-mono text-2xl">{workbench.context.dimension.baseline} <span className="text-sm">mm</span></p><p className="mt-2 break-all font-mono text-xs text-muted-foreground">{workbench.context.dimension.occurrence}</p></div>
                <form onSubmit={queueChange} className="space-y-3 border-t pt-4">
                  <label htmlFor="requested-depth" className="block text-sm font-medium">Requested depth (mm)</label>
                  <Input id="requested-depth" type="number" min={workbench.context.dimension.minimum} max={workbench.context.dimension.maximum} step="any" required value={depth} disabled={disabled || atCapacity} onChange={(event) => setDepth(event.target.value)} aria-describedby="depth-help" />
                  <p id="depth-help" className="text-xs text-muted-foreground">{workbench.context.dimension.minimum}–{workbench.context.dimension.maximum} mm. Each change starts from the same baseline.</p>
                  <Button className="w-full" type="submit" disabled={disabled || atCapacity}>Queue dimension change<ArrowRight aria-hidden="true" /></Button>
                  {atCapacity && <p className="text-xs text-muted-foreground">Five decisions are recorded. Review them before explicitly resetting this workbench.</p>}
                </form>
                <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Context identity and limits</summary><p className="mt-2 break-all font-mono">{workbench.contextSha256}</p><ul className="mt-3 space-y-2">{workbench.context.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></details>
              </>}
            </div>
          </section>
          <section aria-labelledby="queue-heading" className="min-w-0 border bg-card">
            <div className="flex items-center justify-between border-b px-5 py-4"><h2 id="queue-heading" className="text-lg font-medium">Decisions & results</h2><span className="font-mono text-xs text-muted-foreground">{workbench?.records.length ?? 0} / 5</span></div>
            {!workbench?.records.length && <div className="px-5 py-14 text-center"><FileJson className="mx-auto mb-3 size-7 text-muted-foreground" aria-hidden="true" /><p className="text-sm font-medium">Your first change starts here</p><p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">Import prepared context and queue a depth. Results appear only after a native result is imported.</p></div>}
            {!!workbench?.records.length && <>
              <ul aria-label="Queued decisions" className="divide-y border-b">{workbench.records.map((record, index) => <li key={record.job.jobId}><button type="button" disabled={disabled} aria-pressed={selectedId === record.job.jobId} onClick={() => setSelectedId(record.job.jobId)} className={`flex w-full items-start justify-between gap-3 border-l-2 px-5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60 ${selectedId === record.job.jobId ? "border-destructive bg-muted/50" : "border-transparent hover:bg-muted/30"}`}><span className="font-mono text-sm">{String(index + 1).padStart(2, "0")} · 5 → {record.job.depthMm} mm</span><span className="text-right text-xs text-muted-foreground">{executionLabel(record)}</span></button></li>)}</ul>
              {selected && <div className="space-y-5 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-mono text-lg">5 → {selected.job.depthMm} mm</h3><Button variant="outline" size="sm" disabled={disabled} onClick={() => download(selected)}><ArrowDownToLine aria-hidden="true" />Download request JSON</Button></div>
                <p className="text-xs leading-relaxed text-muted-foreground">Give the exact downloaded request to the Workstation operator. Import the returned JSON below; this page does not dispatch or monitor CAD.</p>
                <div className="space-y-2"><label htmlFor="result-file" className="block text-sm font-medium">Import native result</label><Input id="result-file" type="file" accept=".json,application/json" disabled={disabled} onChange={(event) => importFile(event, "result")} /></div>
                <ResultDetails record={selected} />
              </div>}
            </>}
          </section>
        </div>
      </div>
      <AlertDialog open={confirmReset} onOpenChange={(open) => { if (!busy) setConfirmReset(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Reset the local workbench?</AlertDialogTitle><AlertDialogDescription>This removes the saved context, queued decisions, and imported results from this browser. Exported files on your computers are kept. Reset is required before importing a different context.</AlertDialogDescription></AlertDialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirmReset(false)}>Keep workbench</Button><Button variant="destructive" disabled={busy} onClick={resetWorkbench}>Reset saved workbench</Button></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
