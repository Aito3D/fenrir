/**
 * `TrackingLinkControl` — Open / Copy for the card's public tracking
 * link, mounted in `ProjectDetailPanel`'s contact row.
 *
 * The hold-completion incantation (fake timers + `userEvent.pointer`) is
 * copied from `AitoQuoteStatusActions.test.tsx`'s `holdButton` helper, which
 * exercises the same `HoldButton` through a real 500ms hold — the task
 * brief's own suggestion to mirror `AitoHoldButton.test.tsx` doesn't fit
 * here, since that file drives `HoldButton` with `fireEvent.pointerDown` +
 * `vi.advanceTimersByTime` directly and never resolves a real mutation
 * (msw) in between; `userEvent.pointer` + `shouldAdvanceTime: true` lets the
 * request's promise chain actually progress.
 *
 * `makeProject` is shared with `AitoQuoteStatusActions.test.tsx` via
 * `../fixtures/aitoProject` (not `ProjectDetailPanel.test.tsx`, which has no
 * such helper — only a single inline fixture object).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { TrackingLinkControl } from '../../components/aito/TrackingLinkControl';
import { makeProject } from '../fixtures/aitoProject';

const project = makeProject({ id: 7, tracking_configured: true });

// `holdButton` below calls `userEvent.setup(...)`, which — once a hold test
// runs — replaces jsdom's `navigator.clipboard` with its own getter-only
// stub (an own accessor property, not just the prototype's). A later
// `Object.assign(navigator, { clipboard: ... })` then throws ("Cannot set
// property clipboard of #<Navigator> which has only a getter") for every
// test that follows, because `Object.assign` does a plain `[[Set]]` rather
// than defining a fresh own property. Capturing and restoring the original
// descriptor around `Object.defineProperty` — PrinterInfoModal.test.tsx's
// pattern — undoes that stub after each test instead of accumulating it.
let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  // `copyTextToClipboard` only takes the `navigator.clipboard` branch inside
  // a secure context; jsdom's default `http://localhost:3000` test origin
  // (vitest.config.ts) is not one, so `isSecureContext` has to be forced —
  // see `clipboard.test.ts` and `PrinterInfoModal.test.tsx` for the same
  // pattern.
  vi.stubGlobal('isSecureContext', true);
  // defineProperty, not Object.assign: after a user-event test navigator
  // exposes `clipboard` as a getter-only property, and assignment throws.
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});


describe('TrackingLinkControl', () => {
  it('copies the link from the link endpoint', async () => {
    server.use(
      http.get('/api/v1/aito/7/tracking-link', () => HttpResponse.json({ tracking_url: 'https://x.pf/t/abc' })),
    );
    render(<TrackingLinkControl project={project} />);
    await userEvent.click(screen.getByRole('button', { name: /copy tracking link/i }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://x.pf/t/abc'));
    // The confirmation rises in with the panel's tick vocabulary, then
    // fades out before it unmounts instead of vanishing in one frame.
    const copied = await screen.findByTestId('tracking-copied');
    expect(copied).toHaveClass('animate-rise-sm');
    expect(screen.getByRole('button', { name: /copy tracking link/i }).querySelector('svg')).toHaveClass('animate-tick-in');
    await waitFor(() => expect(screen.getByTestId('tracking-copied')).toHaveClass('animate-fade-out-sm'), { timeout: 2500 });
    await waitFor(() => expect(screen.queryByTestId('tracking-copied')).not.toBeInTheDocument());
  });

  it('opens the link in a tab opened before the request, so the click still owns it', async () => {
    server.use(
      http.get('/api/v1/aito/7/tracking-link', () => HttpResponse.json({ tracking_url: 'https://x.pf/t/abc' })),
    );
    const tab = { location: { href: '' }, opener: {} as unknown, close: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    render(<TrackingLinkControl project={project} />);
    await userEvent.click(screen.getByRole('button', { name: /open tracking link/i }));
    // The blank tab is opened synchronously, inside the click (Safari drops a
    // window.open issued after an await), and only pointed at the URL once
    // the endpoint has minted it.
    expect(openSpy).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toBe('https://x.pf/t/abc'));
    expect(tab.opener).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('closes the blank tab and toasts when the link endpoint fails on open', async () => {
    server.use(http.get('/api/v1/aito/7/tracking-link', () => HttpResponse.json({ detail: 'x' }, { status: 500 })));
    const tab = { location: { href: '' }, opener: {} as unknown, close: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    render(<TrackingLinkControl project={project} />);
    await userEvent.click(screen.getByRole('button', { name: /open tracking link/i }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(tab.location.href).toBe('');
    expect(await screen.findByText(/error/i)).toBeInTheDocument();
    openSpy.mockRestore();
  });

  it('is disabled with a settings hint when the external URL is not configured', () => {
    render(<TrackingLinkControl project={{ ...project, tracking_configured: false }} />);
    expect(screen.getByRole('button', { name: /copy tracking link/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /open tracking link/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('href', '/settings?tab=network');
  });



  it('toasts an error and does not copy when the link endpoint fails', async () => {
    server.use(http.get('/api/v1/aito/7/tracking-link', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    render(<TrackingLinkControl project={project} />);

    await userEvent.click(screen.getByRole('button', { name: /copy tracking link/i }));

    expect(await screen.findByText(/error loading data/i)).toBeInTheDocument();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(screen.queryByText(/copied/i)).not.toBeInTheDocument();
  });

  it('toasts an error and shows no confirmation when the link endpoint returns no URL', async () => {
    server.use(http.get('/api/v1/aito/7/tracking-link', () => HttpResponse.json({ tracking_url: null })));
    render(<TrackingLinkControl project={project} />);

    await userEvent.click(screen.getByRole('button', { name: /copy tracking link/i }));

    expect(await screen.findByText(/error loading data/i)).toBeInTheDocument();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(screen.queryByText(/copied/i)).not.toBeInTheDocument();
  });

  it('toasts an error and shows no confirmation when the clipboard write fails', async () => {
    server.use(
      http.get('/api/v1/aito/7/tracking-link', () => HttpResponse.json({ tracking_url: 'https://x.pf/t/abc' })),
    );
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('blocked'));
    // Simulates the execCommand fallback also failing (e.g. Firefox on a
    // plain-HTTP LAN origin), so copyTextToClipboard resolves to false.
    const originalExecCommand = document.execCommand;
    document.execCommand = vi.fn().mockReturnValue(false);

    render(<TrackingLinkControl project={project} />);
    await userEvent.click(screen.getByRole('button', { name: /copy tracking link/i }));

    expect(await screen.findByText(/error loading data/i)).toBeInTheDocument();
    expect(screen.queryByText(/copied/i)).not.toBeInTheDocument();

    document.execCommand = originalExecCommand;
  });

});

describe('TrackingLinkControl in-gesture ClipboardItem write (T-041)', () => {
  class FakeClipboardItem {
    constructor(public items: Record<string, Promise<Blob>>) {}
  }
  const link = () =>
    server.use(http.get('/api/v1/aito/7/tracking-link', () => HttpResponse.json({ tracking_url: 'https://x.pf/t/abc' })));

  beforeEach(() => {
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  });

  it('starts clipboard.write inside the click, before the fetch resolves, with the fetched URL', async () => {
    link();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { write, writeText: vi.fn() }, configurable: true });
    render(<TrackingLinkControl project={project} />);
    const btn = screen.getByRole('button', { name: /copy tracking link/i });
    btn.click();
    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0][0][0] as FakeClipboardItem;
    const blob = await item.items['text/plain'];
    const text = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.readAsText(blob);
    });
    expect(text).toBe('https://x.pf/t/abc');
    expect(await screen.findByTestId('tracking-copied')).toBeInTheDocument();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('falls back to writeText when the item write is refused', async () => {
    link();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: vi.fn().mockRejectedValue(new Error('no')), writeText },
      configurable: true,
    });
    render(<TrackingLinkControl project={project} />);
    await userEvent.click(screen.getByRole('button', { name: /copy tracking link/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://x.pf/t/abc'));
    expect(await screen.findByTestId('tracking-copied')).toBeInTheDocument();
  });

  it('shows the clipboard-specific message when both writes are refused', async () => {
    link();
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: vi.fn().mockRejectedValue(new Error('no')), writeText: vi.fn().mockRejectedValue(new Error('no')) },
      configurable: true,
    });
    const original = document.execCommand;
    document.execCommand = vi.fn().mockReturnValue(false);
    render(<TrackingLinkControl project={project} />);
    await userEvent.click(screen.getByRole('button', { name: /copy tracking link/i }));
    expect(await screen.findByText('Could not copy the tracking link')).toBeInTheDocument();
    document.execCommand = original;
  });

  it('refused write when write throws synchronously still falls back', async () => {
    link();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: vi.fn(() => { throw new Error('sync'); }), writeText },
      configurable: true,
    });
    render(<TrackingLinkControl project={project} />);
    await userEvent.click(screen.getByRole('button', { name: /copy tracking link/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://x.pf/t/abc'));
  });

  it('insecure context keeps the textarea fallback and the old message', async () => {
    link();
    vi.stubGlobal('isSecureContext', false);
    const write = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { write, writeText: vi.fn() }, configurable: true });
    const original = document.execCommand;
    document.execCommand = vi.fn().mockReturnValue(true);
    render(<TrackingLinkControl project={project} />);
    await userEvent.click(screen.getByRole('button', { name: /copy tracking link/i }));
    expect(await screen.findByTestId('tracking-copied')).toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    document.execCommand = original;
  });

  it('does not write an empty URL to the clipboard', async () => {
    server.use(http.get('/api/v1/aito/7/tracking-link', () => HttpResponse.json({ tracking_url: null })));
    const write = vi.fn((items: FakeClipboardItem[]) => items[0].items['text/plain'].then(() => undefined));
    Object.defineProperty(navigator, 'clipboard', { value: { write, writeText: vi.fn() }, configurable: true });
    render(<TrackingLinkControl project={project} />);
    await userEvent.click(screen.getByRole('button', { name: /copy tracking link/i }));
    expect(await screen.findByText(/error loading data/i)).toBeInTheDocument();
    expect(screen.queryByTestId('tracking-copied')).not.toBeInTheDocument();
  });
});

describe('TrackingLinkControl view count', () => {
  it('shows how often the client opened the page, with the last open as the tooltip', async () => {
    server.use(
      http.get('/api/v1/aito/7/tracking-views', () =>
        HttpResponse.json({ views: 3, last_viewed_at: new Date(Date.now() - 5 * 60_000).toISOString() }),
      ),
    );
    render(<TrackingLinkControl project={project} />);
    const views = await screen.findByTestId('tracking-views');
    expect(views).toHaveTextContent('3 views');
    expect(views).toHaveAttribute('title', expect.stringMatching(/last opened by the client 5m ago/i));
  });

  it('says nothing for a link nobody has opened', async () => {
    let asked = false;
    server.use(
      http.get('/api/v1/aito/7/tracking-views', () => {
        asked = true;
        return HttpResponse.json({ views: 0, last_viewed_at: null });
      }),
    );
    render(<TrackingLinkControl project={project} />);
    await waitFor(() => expect(asked).toBe(true));
    expect(screen.queryByTestId('tracking-views')).not.toBeInTheDocument();
  });
});
