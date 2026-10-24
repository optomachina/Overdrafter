import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCallback, useRef, useState } from 'react';
import { ThreadDialog } from './ThreadDialog';

afterEach(cleanup);
function Example() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return <>
    <button onClick={() => setOpen(true)}>OPEN</button>{open && <ThreadDialog close={close}>
      <p>Review</p>
      <button>FIT</button>
    </ThreadDialog>}</>;
}
it('focuses CLOSE, contains keyboard focus, closes on Escape and restores the opener', () => {
  render(<Example />);
  const opener = screen.getByRole('button', { name: 'OPEN' }); opener.focus(); fireEvent.click(opener);
  const close = screen.getByRole('button', { name: 'CLOSE' }); expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'FIT' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' }); expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(opener);
});

it('focuses primary KEEP COOKING in the cancel sheet and dismisses without cancelling', () => {
  const close = vi.fn();
  render(<ThreadDialog sheet close={close}><button>CANCEL REQUEST</button></ThreadDialog>);
  const keep = screen.getByRole('button', { name: 'KEEP COOKING' });
  expect(document.activeElement).toBe(keep);
  expect(keep.className).toBe('jt-primary');
  fireEvent.click(keep);
  fireEvent.keyDown(keep, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  expect(close).toHaveBeenCalledTimes(3);
});

it('falls back to the given element when the opener is disabled by the time the dialog closes', () => {
  function Disabling() {
    const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
    const fallback = useRef<HTMLHeadingElement>(null);
    const close = useCallback(() => setOpen(false), []);
    return <>
      <h1 ref={fallback} tabIndex={-1}>Home</h1>
      <button disabled={busy} onClick={() => setOpen(true)}>OPEN</button>
      {open && <ThreadDialog sheet close={close} fallbackFocus={fallback}><button onClick={() => { setBusy(true); setOpen(false); }}>GO</button></ThreadDialog>}</>;
  }
  render(<Disabling />);
  const opener = screen.getByRole('button', { name: 'OPEN' }); opener.focus(); fireEvent.click(opener);
  fireEvent.click(screen.getByRole('button', { name: 'GO' }));
  expect(opener.hasAttribute('disabled')).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Home' }));
});
it('prefers the opener over the fallback when the opener is still focusable', () => {
  function Enabled() {
    const [open, setOpen] = useState(false), fallback = useRef<HTMLHeadingElement>(null);
    const close = useCallback(() => setOpen(false), []);
    return <><h1 ref={fallback} tabIndex={-1}>Home</h1><button onClick={() => setOpen(true)}>OPEN</button>{open && <ThreadDialog close={close} fallbackFocus={fallback}><p>x</p></ThreadDialog>}</>;
  }
  render(<Enabled />);
  const opener = screen.getByRole('button', { name: 'OPEN' }); opener.focus(); fireEvent.click(opener);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(document.activeElement).toBe(opener);
});

it('pulls focus back into the dialog when it sits outside, in either Tab direction', () => {
  render(<Example />);
  const opener = screen.getByRole('button', { name: 'OPEN' }); opener.focus(); fireEvent.click(opener);
  const close = screen.getByRole('button', { name: 'CLOSE' }), fit = screen.getByRole('button', { name: 'FIT' });
  (document.activeElement as HTMLElement).blur(); expect(document.activeElement).toBe(document.body);
  fireEvent.keyDown(document.body, { key: 'Tab' }); expect(document.activeElement).toBe(close);
  opener.focus(); fireEvent.keyDown(opener, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(fit);
});
