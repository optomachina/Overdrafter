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
export function ArMoreAction({ title, ...props }: Readonly<Props>) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const moreButton = trigger.current;
    const dialog = modal.current;
    // showModal() puts the dialog in the top layer and makes the rest of the page inert. The `open`
    // attribute alone is a non-modal dialog, so browsers without showModal() only get the fallback.
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheet.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
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
    {open && <dialog ref={modal} className="jarvis-ar-backdrop" aria-modal="true" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); setOpen(false); }}>
      <button type="button" className="jarvis-ar-scrim" aria-label="Close sheet" tabIndex={-1} onClick={() => setOpen(false)} />
      <div ref={sheet} className="jarvis-ar-sheet" tabIndex={-1}>
        <div className="jarvis-ar-grabber" aria-hidden="true" />
        <h2 id={titleId}>{title}</h2>
        <ViewInArAction {...props} />
        <button className="jarvis-ar-row jarvis-ar-cancel" onClick={() => setOpen(false)}>CANCEL</button>
      </div>
    </dialog>}
  </>;
}
