import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  EXPORT_CONTROL_ANSWER_OPTIONS,
  EXPORT_CONTROL_HELP_PATH,
  getExportControlBlockMessage,
  registerExportControlDeclarationPrompter,
  type ExportControlAnswer,
  type ExportControlPromptMode,
} from "@/features/quotes/export-control";

type PendingPrompt = {
  resolve: (answer: ExportControlAnswer | null) => void;
};

const DECLARE_BLOCKED_MESSAGE =
  "Your answer will be recorded. The OverDrafter beta cannot quote these files, and they will not be sent to any supplier.";

/**
 * OVD-723 export-control declaration. Mounted once at the app root; the upload
 * API and the part page ask through `requestExportControlAnswer`. The answer
 * is recorded for the whole part, so the question names every file on it.
 * There is no default answer, and closing the dialog resolves null, which
 * blocks the upload or records nothing.
 */
export function ExportControlDeclarationDialogHost() {
  const pendingRef = useRef<PendingPrompt | null>(null);
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<ExportControlAnswer | null>(null);
  const [mode, setMode] = useState<ExportControlPromptMode>("upload");

  const settle = useCallback((value: ExportControlAnswer | null) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setOpen(false);
    setAnswer(null);
    pending?.resolve(value);
  }, []);

  useEffect(() => {
    const unregister = registerExportControlDeclarationPrompter(
      (nextMode) =>
        new Promise<ExportControlAnswer | null>((resolve) => {
          // A second prompt while one is open cancels the first.
          pendingRef.current?.resolve(null);
          pendingRef.current = { resolve };
          setAnswer(null);
          setMode(nextMode === "declare" ? "declare" : "upload");
          setOpen(true);
        }),
    );

    return () => {
      unregister();
      pendingRef.current?.resolve(null);
      pendingRef.current = null;
    };
  }, []);

  const blocked = answer === "controlled" || answer === "unsure";
  const declaring = mode === "declare";
  let confirmLabel = blocked ? "Stop upload" : "Continue upload";
  if (declaring) confirmLabel = "Save answer";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) settle(null);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Are any files on this part export-controlled?</DialogTitle>
          <DialogDescription>
            Your answer covers every file on this part: files already uploaded and any you add
            later. The OverDrafter beta does not accept ITAR, EAR-controlled (other than EAR99),
            CUI, or distribution-limited technical data.
            {declaring ? " Quotes for this part stay on hold until you answer." : " Answer before uploading."}
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-2">
          <legend className="sr-only">Export-control classification</legend>
          {EXPORT_CONTROL_ANSWER_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer gap-3 rounded-md border border-paper-hairline p-3 text-sm",
                answer === option.value && "border-foreground",
              )}
            >
              <input
                type="radio"
                name="export-control-answer"
                value={option.value}
                checked={answer === option.value}
                onChange={() => setAnswer(option.value)}
                className="mt-1"
              />
              <span>
                <span className="block font-medium">{option.label}</span>
                <span className="block text-paper-muted">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {blocked ? (
          <p role="alert" className="text-sm text-destructive">
            {declaring ? DECLARE_BLOCKED_MESSAGE : getExportControlBlockMessage("export_declaration_not_clean")}
          </p>
        ) : null}

        <p className="text-xs text-paper-muted">
          Files that carry export-control markings are held for review after upload.{" "}
          <a className="underline" href={EXPORT_CONTROL_HELP_PATH}>
            Beta terms
          </a>
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => settle(null)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={answer === null}
            onClick={() => settle(answer)}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
