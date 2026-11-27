import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { withLocalFixtureContext } from "@/features/quotes/fixture-navigation";
import {
  clearUploadBatch,
  formatUploadBatchMessage,
  useUploadBatchSnapshot,
} from "@/features/quotes/upload-batch-store";

/**
 * The batch lives in a module store, so this strip survives a route change
 * that unmounts the page which started the upload.
 */
export function UploadBatchOutcome() {
  const snapshot = useUploadBatchSnapshot();
  const navigate = useNavigate();
  const batchRunning = snapshot?.phase === "running";

  useEffect(() => {
    if (!batchRunning) {
      return;
    }
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [batchRunning]);

  if (!snapshot) {
    return null;
  }

  const projectId = snapshot.result.projectId;
  const canAdd =
    snapshot.phase === "complete" && snapshot.result.failed.length > 0 && Boolean(projectId);

  return (
    <div
      role="status"
      aria-label="Upload result"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card px-4 py-3 text-[13px] leading-relaxed text-foreground md:px-6"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 font-mono text-[12px]">{formatUploadBatchMessage(snapshot)}</p>
        {canAdd && projectId ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              navigate(withLocalFixtureContext(`/projects/${projectId}?addParts=1`));
            }}
          >
            Add them to this project
          </Button>
        ) : null}
        {snapshot.phase === "complete" ? (
          <Button type="button" size="sm" variant="ghost" onClick={clearUploadBatch}>
            Dismiss
          </Button>
        ) : null}
      </div>
      {snapshot.result.warnings.length > 0 ? (
        <ul className="mt-2 space-y-1 text-muted-foreground">
          {snapshot.result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
