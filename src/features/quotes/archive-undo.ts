import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

type ArchiveUndoEntry = {
  label: string;
  undo: () => Promise<void>;
};

const archiveUndoStack: ArchiveUndoEntry[] = [];

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
}

export function useArchiveUndo() {
  const isUndoingRef = useRef(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "z") {
        return;
      }

      if (isEditableTarget(event.target) || isUndoingRef.current) {
        return;
      }

      const latestEntry = archiveUndoStack.at(-1);
      if (!latestEntry) {
        return;
      }

      event.preventDefault();
      isUndoingRef.current = true;

      void latestEntry
        .undo()
        .then(() => {
          archiveUndoStack.pop();
          toast.success(`${latestEntry.label} restored.`);
        })
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : `Failed to restore ${latestEntry.label.toLowerCase()}.`);
        })
        .finally(() => {
          isUndoingRef.current = false;
        });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return useCallback((entry: ArchiveUndoEntry) => {
    archiveUndoStack.push(entry);
  }, []);
}
