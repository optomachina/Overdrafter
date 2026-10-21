import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelView } from './ModelView';
import { loadModelViewer } from './model-loader';

// The real loader would pull in model-viewer and three; these tests drive the loader's outcome directly.
vi.mock('./model-loader', () => ({ loadModelViewer: vi.fn() }));
const load = vi.mocked(loadModelViewer);
afterEach(() => { cleanup(); load.mockReset(); });
const viewerOf = (container: HTMLElement) => container.querySelector('model-viewer')!;

describe('viewer retry and failure handling', () => {
  it('says a reload is needed, and offers no TRY AGAIN, when the viewer script itself failed to load', async () => {
    load.mockRejectedValue(new Error('chunk failed'));
    render(<ModelView uri="/plate.glb" pictures={['/iso.png', '/top.png']} step="/plate.step" webgl={() => true} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('3D view · Unavailable.');
    expect(alert.textContent).toContain('Reload the page to try again.');
    expect(screen.queryByRole('button', { name: 'TRY AGAIN' })).toBeNull();
    expect(screen.getByRole('img', { name: 'Iso' }).getAttribute('src')).toBe('/iso.png');
    expect(screen.getByRole('img', { name: 'Top view' }).getAttribute('src')).toBe('/top.png');
    expect(screen.getByRole('link', { name: 'DOWNLOAD STEP' }).getAttribute('href')).toBe('/plate.step');
  });

  it('does not promise a reload for a model error, and still offers TRY AGAIN', () => {
    load.mockResolvedValue({} as never);
    const { container } = render(<ModelView uri="/plate.glb" pictures={['/iso.png']} webgl={() => true} />);
    fireEvent(viewerOf(container), new Event('error'));
    expect(screen.getByRole('alert').textContent).not.toContain('Reload the page');
    expect(screen.getByRole('button', { name: 'TRY AGAIN' })).toBeTruthy();
  });

  it('retries a failed model under a new URL fragment, because model-viewer caches the failed load under the exact URL', () => {
    load.mockResolvedValue({} as never);
    const { container } = render(<ModelView uri="/plate.glb?token=abc#old" pictures={['/iso.png']} webgl={() => true} />);
    expect(viewerOf(container).getAttribute('src')).toBe('/plate.glb?token=abc#old');
    fireEvent(viewerOf(container), new Event('error')); fireEvent.click(screen.getByRole('button', { name: 'TRY AGAIN' }));
    expect(viewerOf(container).getAttribute('src')).toBe('/plate.glb?token=abc#retry-1');
    fireEvent(viewerOf(container), new Event('error')); fireEvent.click(screen.getByRole('button', { name: 'TRY AGAIN' }));
    expect(viewerOf(container).getAttribute('src')).toBe('/plate.glb?token=abc#retry-2');
  });

  it('keeps keyboard focus inside the viewer when TRY AGAIN removes itself', () => {
    load.mockResolvedValue({} as never);
    const { container } = render(<ModelView uri="/plate.glb" pictures={['/iso.png']} webgl={() => true} />);
    fireEvent(viewerOf(container), new Event('error'));
    const retry = screen.getByRole('button', { name: 'TRY AGAIN' }); retry.focus(); expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    expect(screen.queryByRole('button', { name: 'TRY AGAIN' })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByText('Derived review view; STEP is authoritative.'));
  });

  it('turns off the viewer\'s animated interaction hint, since the written instructions and buttons cover it', () => {
    load.mockResolvedValue({} as never);
    const { container } = render(<ModelView uri="/plate.glb" pictures={[]} webgl={() => true} />);
    expect(viewerOf(container).getAttribute('interaction-prompt')).toBe('none');
  });
});
