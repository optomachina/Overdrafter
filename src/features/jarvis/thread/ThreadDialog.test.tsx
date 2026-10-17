import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCallback, useState } from 'react';
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
  fireEvent.click(screen.getByRole('alertdialog').parentElement!);
  expect(close).toHaveBeenCalledTimes(3);
});
