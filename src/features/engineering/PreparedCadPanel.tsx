import { useMemo } from "react";
import { Box } from "lucide-react";
import { CadModelThumbnail } from "@/components/CadModelThumbnail";
import { Button } from "@/components/ui/button";
import { findPreparedPreview, preparedPreviewSource, type PreviewEntry } from "./prepared-preview";
import type { Workbench, WorkbenchRecord } from "./prepared-workflow";

type Props = {
  readonly workbench: Workbench | null;
  readonly record?: WorkbenchRecord;
  readonly entries: readonly PreviewEntry[];
  readonly view: "baseline" | "candidate";
  readonly onView: (view: "baseline" | "candidate") => void;
};

function emptyCadMessage(workbench: Props["workbench"], record: Props["record"], view: Props["view"]) {
  let emptyTitle = "Your assembly appears here";
  let emptyMessage = "Import prepared context and its native STEP preview using Workbench tools.";
  if (workbench && view === "baseline") {
    emptyTitle = "Baseline CAD preview needed";
    emptyMessage = "The assembly context is ready. Import its matching STEP preview to inspect the original geometry.";
  } else if (view === "candidate" && (record?.execution === "failed" || record?.checks === "failed")) {
    emptyTitle = "Candidate evaluation failed";
    emptyMessage = "The native result did not establish verified candidate geometry. Review the failure details in the conversation before recording another evaluation.";
  } else if (view === "candidate") {
    emptyTitle = "Waiting for candidate geometry";
    emptyMessage = "A proposed depth does not change this view. Import the matching successful native result and its STEP preview to see the actual candidate.";
  }
  return { emptyTitle, emptyMessage };
}

/** Display only the exact native export bound to the selected baseline or completed request. */
export function PreparedCadPanel({ workbench, record, entries, view, onView }: Props) {
  const baseline = workbench ? findPreparedPreview(entries, workbench) : undefined;
  const candidate = workbench && record ? findPreparedPreview(entries, workbench, record) : undefined;
  const displayed = view === "baseline" ? baseline : candidate;
  const source = useMemo(() => displayed ? preparedPreviewSource(displayed) : null, [displayed]);
  const { emptyTitle, emptyMessage } = emptyCadMessage(workbench, record, view);
  const depth = view === "baseline" ? workbench?.context.dimension.baseline : record?.result?.measurements?.afterDepthMm;
  return (
    <div className="flex h-full min-h-[380px] flex-col sm:min-h-[460px] lg:min-h-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-3 sm:px-4">
        <fieldset className="m-0 flex min-w-0 rounded-lg border-0 bg-muted p-1">
          <legend className="sr-only">CAD comparison</legend>
          <Button variant={view === "baseline" ? "secondary" : "ghost"} className={view === "baseline" ? "border border-border bg-card shadow-sm hover:bg-card" : "border border-transparent"} size="sm" aria-pressed={view === "baseline"} onClick={() => onView("baseline")}>Before · 5 mm</Button>
          <Button variant={view === "candidate" ? "secondary" : "ghost"} className={view === "candidate" ? "border border-border bg-card shadow-sm hover:bg-card" : "border border-transparent"} size="sm" aria-pressed={view === "candidate"} disabled={!record} onClick={() => onView("candidate")}>After{record ? ` · ${record.job.depthMm} mm` : ""}</Button>
        </fieldset>
        <span className="text-xs text-muted-foreground">{displayed ? "Native STEP export" : "No geometry loaded"}</span>
      </div>
      <div className="relative min-h-[280px] flex-1 p-2 sm:min-h-[340px] lg:min-h-[220px]">
        {source ? <CadModelThumbnail source={source} autoRotate={false} className="h-full min-h-[280px] w-full !rounded-lg !border-0 !bg-[linear-gradient(160deg,#eef0ed,#d8ddda)] sm:min-h-[340px] lg:min-h-[220px]" /> : (
          <div className="flex h-full min-h-[280px] flex-col items-center justify-center px-6 text-center">
            <Box className="mb-5 size-9 text-muted-foreground/60" strokeWidth={1.2} aria-hidden="true" />
            <h2 className="text-base font-medium">{emptyTitle}</h2>
            <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{emptyMessage}</p>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
        <span>{displayed ? `Two components · ${depth} mm depth · Default` : "Geometry is shown only when its evidence matches."}</span>
        {displayed && <span>Drag to orbit · Scroll to zoom</span>}
      </div>
      {displayed && <details className="border-t px-4 py-2 text-xs text-muted-foreground"><summary className="cursor-pointer py-1">Preview source and limitations</summary><p className="my-2 break-all">STEP SHA-256: {displayed.preview.step.sha256}</p><p className="mb-2">Imported conversion evidence; preview identity does not authenticate its origin or approve adoption.</p><ul className="mb-2 list-inside list-disc space-y-1">{displayed.preview.limitations.map((line) => <li key={line}>{line}</li>)}</ul></details>}
    </div>
  );
}
