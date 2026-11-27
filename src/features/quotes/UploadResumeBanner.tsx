import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { withLocalFixtureContext } from "@/features/quotes/fixture-navigation";
import { useUploadBatchSnapshot } from "@/features/quotes/upload-batch-store";
import {
  clearUploadResume,
  formatUnfinishedUploadMessage,
  unfinishedUploadNames,
  useUploadResumeRecord,
} from "@/features/quotes/upload-resume-store";

/**
 * Shown on the project that owns an upload the tab did not finish.
 * The action reuses the project page's add-parts picker and does not open a new project.
 */
export function UploadResumeBanner({ projectId }: { projectId: string }) {
  const record = useUploadResumeRecord();
  const batch = useUploadBatchSnapshot();
  const navigate = useNavigate();

  if (!record || record.projectId !== projectId) {
    return null;
  }
  if (batch?.phase === "running" && batch.result.projectId === projectId) {
    return null;
  }

  const missing = unfinishedUploadNames(record);
  if (missing.length === 0) {
    return null;
  }

  return (
    <div
      role="status"
      aria-label="Unfinished upload"
      className="border border-border bg-card px-4 py-3 text-[13px] leading-relaxed text-foreground"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 font-mono text-[12px]">{formatUnfinishedUploadMessage(missing)}</p>
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
        <Button type="button" size="sm" variant="ghost" onClick={clearUploadResume}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
