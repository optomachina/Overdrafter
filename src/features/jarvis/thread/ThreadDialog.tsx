import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

export function ThreadDialog({ children, close, sheet = false, fallbackFocus }: Readonly<{ children: ReactNode; close(): void; sheet?: boolean; fallbackFocus?: RefObject<HTMLElement> }>) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement;
    const root = ref.current!, fallback = fallbackFocus?.current;
    root.querySelector<HTMLElement>('button')?.focus();
    const keyboard = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') {
        const items = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]'));
        const first = items[0], last = items.at(-1), active = document.activeElement;
        // Focus can sit outside the dialog (a click on plain text drops it to body); pull it back in instead of tabbing into the page behind.
        if (!root.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first)?.focus(); }
        else if (e.shiftKey && active === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      opener?.focus();
      // A command in flight can disable the opener (CANCEL) before this runs; keep focus in the page, not on body.
      if (opener && document.activeElement !== opener) fallback?.focus();
    };
  }, [close, fallbackFocus]);
  return <div className={`jt-overlay ${sheet ? 'jt-sheet' : ''}`}>
    <button type="button" className="jt-scrim" aria-label="Close dialog" tabIndex={-1} onClick={close} />
    <dialog open ref={ref} role={sheet ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={sheet ? 'Cancel request?' : '3D review'}>
      <button className={sheet ? 'jt-primary' : undefined} onClick={close}>{sheet ? 'KEEP COOKING' : 'CLOSE'}</button>{children}</dialog>
  </div>;
}
