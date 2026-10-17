import { useEffect, useId, useRef, useState } from "react";
import { ViewInArAction } from "@/features/jarvis/ar/ViewInArAction";
import type { ArDevice, ArModel } from "@/features/jarvis/ar/ar-support";

interface Props extends ArModel {
  title: string;
  posterUrl: string;
  status: "ready" | "loading" | "failed";
  onRetry: () => void;
  device?: ArDevice;
}

/** Shell-side slot content for the OVD-804 thread's `arActionSlot`: MORE plus the AR sheet.
 * Lives outside src/features/jarvis because the import boundary keeps React hooks out of the feature core. */
export function ArMoreAction({ title, ...props }: Props) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const moreButton = trigger.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheet.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
      if (event.key !== "Tab") return;
      const controls = Array.from(sheet.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? []);
      const first = controls[0];
      const last = controls.at(-1);
      const outside = !sheet.current?.contains(document.activeElement);
      if (event.shiftKey && (outside || document.activeElement === first || document.activeElement === sheet.current)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (outside || document.activeElement === last || document.activeElement === sheet.current)) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      moreButton?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (open && !sheet.current?.contains(document.activeElement)) sheet.current?.focus();
  }, [open, props.status]);

  return <>
    <button ref={trigger} className="jarvis-ar-row" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>MORE</button>
    {open && <div className="jarvis-ar-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget) setOpen(false);
    }}>
      <div ref={sheet} className="jarvis-ar-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="jarvis-ar-grabber" aria-hidden="true" />
        <h2 id={titleId}>{title}</h2>
        <ViewInArAction {...props} />
        <button className="jarvis-ar-row jarvis-ar-cancel" onClick={() => setOpen(false)}>CANCEL</button>
      </div>
    </div>}
  </>;
}
