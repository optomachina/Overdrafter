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
} from "@/features/quotes/export-control";

type PendingPrompt = {
  resolve: (answer: ExportControlAnswer | null) => void;
};

/**
 * OVD-723 upload declaration. Mounted once at the app root; the upload API
 * asks through `requestExportControlAnswer`. There is no default answer, and
 * closing the dialog resolves null, which blocks the upload.
 */
export function ExportControlDeclarationDialogHost() {
  const pendingRef = useRef<PendingPrompt | null>(null);
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<ExportControlAnswer | null>(null);

  const settle = useCallback((value: ExportControlAnswer | null) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setOpen(false);
    setAnswer(null);
    pending?.resolve(value);
  }, []);

  useEffect(() => {
    const unregister = registerExportControlDeclarationPrompter(
      () =>
        new Promise<ExportControlAnswer | null>((resolve) => {
          // A second prompt while one is open cancels the first.
          pendingRef.current?.resolve(null);
          pendingRef.current = { resolve };
          setAnswer(null);
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

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) settle(null);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Are these files export-controlled?</DialogTitle>
          <DialogDescription>
            The OverDrafter beta does not accept ITAR, EAR-controlled (other than EAR99), CUI, or
            distribution-limited technical data. Answer before uploading.
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
            {getExportControlBlockMessage("export_declaration_not_clean")}
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
            {blocked ? "Stop upload" : "Continue upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
