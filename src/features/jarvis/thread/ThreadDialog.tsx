import { useEffect, useRef, type ReactNode } from 'react';

export function ThreadDialog({ children, close, sheet = false }: { children: ReactNode; close(): void; sheet?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement;
    const root = ref.current!;
    root.querySelector<HTMLElement>('button')?.focus();
    const keyboard = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') {
        const items = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]'));
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); opener?.focus(); };
  }, [close]);
  return <div className={`jt-overlay ${sheet ? 'jt-sheet' : ''}`} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div ref={ref} role={sheet ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={sheet ? 'Cancel request?' : '3D review'}>
      <button className={sheet ? 'jt-primary' : undefined} onClick={close}>{sheet ? 'KEEP COOKING' : 'CLOSE'}</button>{children}</div>
  </div>;
}
