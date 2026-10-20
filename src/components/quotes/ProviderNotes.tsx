import { useId, useState } from "react";
import { PROVIDER_NOTES_PREVIEW_CHARS, sanitizeProviderNotes } from "@/features/quotes/provider-notes";

export function ProviderNotes({ notes }: Readonly<{ notes: string | null | undefined }>) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const text = sanitizeProviderNotes(notes);
  const isLong = text !== null && text.length > PROVIDER_NOTES_PREVIEW_CHARS;
  const shown = text !== null && isLong && !expanded
    ? `${text.slice(0, PROVIDER_NOTES_PREVIEW_CHARS).trimEnd()}…`
    : text;

  return (
    <div className="mt-3 border-t border-border pt-2" data-testid="provider-notes">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        Provider notes
      </p>
      {shown === null ? (
        <p className="mt-1 font-mono text-xs text-muted-foreground">No provider notes</p>
      ) : (
        <>
          <p id={bodyId} className="mt-1 whitespace-pre-line break-words font-mono text-xs text-foreground">
            {shown}
          </p>
          {isLong ? (
            <button
              type="button"
              className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground underline"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
