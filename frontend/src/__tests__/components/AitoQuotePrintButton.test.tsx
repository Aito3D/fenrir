import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { QuotePrintButton } from '../../components/aito/QuotePrintButton';
import { QuoteDownloadButton } from '../../components/aito/QuoteDownloadButton';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';
import { ACTION_CELL } from '../../components/aito/quoteActionGroup';

const project = { id: 12, quote_id: 'EST-9', quote_number: 'QT-00412' } as unknown as AitoProject;

describe('QuotePrintButton', () => {
  beforeEach(() => {
    // jsdom implements neither of these; the component must not assume they
    // exist beyond what it actually calls.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('fetches the PDF for the project when clicked', async () => {
    const spy = vi.spyOn(api, 'getAitoQuotePdf').mockResolvedValue(new Blob(['%PDF-']));
    const user = userEvent.setup();
    render(<QuotePrintButton project={project} />);

    await user.click(screen.getByRole('button', { name: /print quote/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12));
  });

  it('falls back to a new tab when the iframe refuses to print', async () => {
    // Safari has historically refused contentWindow.print() on a PDF blob.
    // Silently doing nothing is the one outcome this button must never have.
    vi.spyOn(api, 'getAitoQuotePdf').mockResolvedValue(new Blob(['%PDF-']));
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({
      focus: () => {},
      print: () => {
        throw new Error('not supported');
      },
    } as unknown as Window);

    const user = userEvent.setup();
    render(<QuotePrintButton project={project} />);
    await user.click(screen.getByRole('button', { name: /print quote/i }));

    // jsdom never actually navigates the iframe (no `resources: 'usable'`),
    // so `onload` never fires here regardless of the mocked `contentWindow` —
    // this assertion is only satisfied via the component's own
    // IFRAME_LOAD_TIMEOUT_MS (3s) escalation. Default waitFor polling (1s)
    // is shorter than that, so it needs a longer window; the assertion
    // itself is unchanged.
    await waitFor(() => expect(open).toHaveBeenCalledWith('blob:fake', '_blank'), { timeout: 4000 });
  });

  it('surfaces a failed fetch instead of doing nothing', async () => {
    vi.spyOn(api, 'getAitoQuotePdf').mockRejectedValue(new Error('HTTP 502'));
    const user = userEvent.setup();
    render(<QuotePrintButton project={project} />);

    await user.click(screen.getByRole('button', { name: /print quote/i }));
    await waitFor(() => expect(screen.getByText(/could not fetch the quote pdf/i)).toBeInTheDocument());
  });

  it('renders nothing for a project with no quote', () => {
    render(<QuotePrintButton project={{ ...project, quote_id: null } as unknown as AitoProject} />);
    expect(screen.queryByRole('button', { name: /print quote/i })).not.toBeInTheDocument();
  });

  it('is disabled, with the tooltip explaining why, while the quote sync is pending', () => {
    // 'pending' means the worker has not pushed the latest edit to Zoho yet,
    // so the PDF Books would return is the PRE-edit quote. Handing that to
    // the operator is exactly the outdated-document mistake this gate stops.
    render(<QuotePrintButton project={{ ...project, quote_sync_state: 'pending' } as unknown as AitoProject} />);
    const button = screen.getByRole('button', { name: /print quote/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringMatching(/sync in progress/i));
  });

  it.each(['idle', 'error', 'locked', 'unmanaged'] as const)(
    'stays enabled when the sync state is %s',
    (state) => {
      // 'error' deliberately stays enabled: the Zoho copy is stale there too,
      // but the panel already surfaces the failure with a retry button, and
      // the old PDF may still be what the operator wants while it is sorted.
      render(<QuotePrintButton project={{ ...project, quote_sync_state: state } as unknown as AitoProject} />);
      expect(screen.getByRole('button', { name: /print quote/i })).toBeEnabled();
    },
  );

  it('is icon-only', () => {
    render(<QuotePrintButton project={project} />);
    const button = screen.getByRole('button', { name: /print quote/i });
    // The accessible name comes from aria-label. There is no longer an opt-in
    // labelled form — see the action-group test below for why.
    expect(button).not.toHaveTextContent('Print quote');
  });

  it('renders as a cell of the shared action group: no visible text at all, name carried by aria-label and title', () => {
    // The Quote card's row is 230.4px and three labelled pills wanted 253.6px
    // (measured, not computed — root rem here is 14.4px), so "Print quote"
    // wrapped mid-phrase. Shortening the label fixed the wrap but left Russian
    // clearing the row by 1.3px; dropping the visible text entirely removes the
    // constraint for every locale. Nothing is lost for screen readers, which is
    // exactly what this pins: no rendered text, full phrase still announced.
    render(<QuotePrintButton project={project} />);
    const button = screen.getByRole('button', { name: /print quote/i });
    expect(button).toHaveTextContent('');
    expect(button).toHaveAttribute('aria-label', 'Print quote');
    expect(button).toHaveAttribute('title', 'Print quote');
    // Pinned against the shared constant rather than a copied class string, so
    // this tracks quoteActionGroup.ts instead of going stale beside it. Without
    // it a cell could drift back to standalone pill styling and quietly break
    // the segmented row on both cards.
    expect(button).toHaveAttribute('class', ACTION_CELL);
  });

  it('does not fall back to a new tab once the component has unmounted', async () => {
    // The 3s fallback timer used to be a bare window.setTimeout with no
    // cleanup tied to the component's lifetime: closing the detail panel
    // within 3s of clicking print still popped a stray tab (and, in tests,
    // hit jsdom's "Not implemented: window.open" after RTL had already torn
    // the tree down).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, 'getAitoQuotePdf').mockResolvedValue(new Blob(['%PDF-']));
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      const { unmount } = render(<QuotePrintButton project={project} />);
      await user.click(screen.getByRole('button', { name: /print quote/i }));

      // Let the resolved fetch's continuation run: the iframe is created and
      // appended, and the 3s fallback timer is scheduled, all synchronously
      // once the awaited promise settles.
      await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());

      unmount();
      await vi.advanceTimersByTimeAsync(3100);

      expect(open).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the pending 60s revoke timer running on unmount and still revokes the URL exactly once', async () => {
    // The revoke backstop scheduled after a successful print is a bare
    // window.setTimeout with no lifecycle tie to the component: unmounting
    // within 60s must not touch it, because the print dialog reads the URL
    // lazily (see REVOKE_DELAY_MS) and may still be open after the detail
    // panel is closed. This matches BASE, where cleanup() was exactly this
    // — an untracked setTimeout — for every print path.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, 'getAitoQuotePdf').mockResolvedValue(new Blob(['%PDF-']));
      vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({
        focus: () => {},
        print: () => {},
      } as unknown as Window);
      const revoke = globalThis.URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>;
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      const { unmount } = render(<QuotePrintButton project={project} />);
      await user.click(screen.getByRole('button', { name: /print quote/i }));

      let iframe: HTMLIFrameElement | null = null;
      await waitFor(() => {
        iframe = document.querySelector('iframe');
        expect(iframe).not.toBeNull();
      });
      // jsdom never fires `load` on its own; simulate the browser having
      // rendered the PDF so the component schedules the 60s revoke backstop.
      fireEvent.load(iframe as HTMLIFrameElement);
      expect(revoke).not.toHaveBeenCalled();

      unmount();
      // Unmounting must NOT force-revoke: the dialog may still be reading
      // the URL after the panel is closed.
      expect(revoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      // The backstop still runs to completion on its own and revokes the
      // URL exactly once.
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('blob:fake');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not revoke a URL handed to window.open on unmount, but still revokes it exactly once when its own 60s backstop elapses', async () => {
    // The window.open fallback must not be force-revoked on unmount: the
    // operator may have kept that spawned tab open — or reloaded it — after
    // closing this panel, and revoking the URL out from under it breaks a
    // reload that would otherwise have kept working for the rest of the
    // original 60s window. (See the sibling test above: the iframe path
    // gets the same treatment, for the same reason.)
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, 'getAitoQuotePdf').mockResolvedValue(new Blob(['%PDF-']));
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      // print() throwing escalates to window.open synchronously from
      // inside `onload`, without needing to wait out the 3s fallback timer.
      vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({
        focus: () => {},
        print: () => {
          throw new Error('not supported');
        },
      } as unknown as Window);
      const revoke = globalThis.URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>;
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      const { unmount } = render(<QuotePrintButton project={project} />);
      await user.click(screen.getByRole('button', { name: /print quote/i }));

      let iframe: HTMLIFrameElement | null = null;
      await waitFor(() => {
        iframe = document.querySelector('iframe');
        expect(iframe).not.toBeNull();
      });
      fireEvent.load(iframe as HTMLIFrameElement);
      await waitFor(() => expect(open).toHaveBeenCalledWith('blob:fake', '_blank'));
      expect(revoke).not.toHaveBeenCalled();

      unmount();
      // Unlike the iframe path, unmounting must NOT force-revoke this URL.
      expect(revoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      // The 60s backstop still runs to completion on its own and revokes
      // the URL exactly once.
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('blob:fake');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaks no URL when a second print starts inside the first print\'s pending 60s window', async () => {
    // Two prints in flight at once means two pending revoke entries. This
    // covers the "second overwrites the first" leak: neither entry is
    // touched by unmount (the first went through the iframe path, the
    // second through window.open), both are left for their own timer, and
    // every URL must still end up revoked exactly once.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let call = 0;
      globalThis.URL.createObjectURL = vi.fn(() => `blob:fake-${++call}`);
      const revoke = globalThis.URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>;
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      const contentWindowSpy = vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get');
      vi.spyOn(api, 'getAitoQuotePdf').mockResolvedValue(new Blob(['%PDF-']));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      const { unmount } = render(<QuotePrintButton project={project} />);
      const button = screen.getByRole('button', { name: /print quote/i });

      // First print: succeeds through the iframe.
      contentWindowSpy.mockReturnValue({ focus: () => {}, print: () => {} } as unknown as Window);
      await user.click(button);
      let firstFrame: HTMLIFrameElement | null = null;
      await waitFor(() => {
        firstFrame = document.querySelector('iframe');
        expect(firstFrame).not.toBeNull();
      });
      fireEvent.load(firstFrame as HTMLIFrameElement);
      await waitFor(() => expect(button).not.toBeDisabled());
      expect(revoke).not.toHaveBeenCalled();

      // Second print, started while the first's 60s backstop is still
      // pending: this time contentWindow.print() throws, escalating to
      // window.open.
      contentWindowSpy.mockReturnValue({
        focus: () => {},
        print: () => {
          throw new Error('not supported');
        },
      } as unknown as Window);
      await user.click(button);
      let secondFrame: HTMLIFrameElement | null = null;
      await waitFor(() => {
        const frames = document.querySelectorAll('iframe');
        expect(frames.length).toBeGreaterThan(1);
        secondFrame = frames[frames.length - 1] as HTMLIFrameElement;
      });
      fireEvent.load(secondFrame as HTMLIFrameElement);
      await waitFor(() => expect(open).toHaveBeenCalledWith('blob:fake-2', '_blank'));
      expect(revoke).not.toHaveBeenCalled();

      unmount();
      // Neither the iframe-path nor the window.open-path URL is
      // force-revoked on unmount; both are left alone for their own timer.
      expect(revoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      // Both URLs' own backstops have now elapsed: both end up revoked,
      // each exactly once — no leak, no double revoke.
      expect(revoke).toHaveBeenCalledTimes(2);
      expect(revoke.mock.calls.filter((c) => c[0] === 'blob:fake-1')).toHaveLength(1);
      expect(revoke.mock.calls.filter((c) => c[0] === 'blob:fake-2')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('QuoteDownloadButton', () => {
  beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('is disabled, with the tooltip explaining why, while the quote sync is pending', () => {
    // Same gate, same reason as the print twin above: a download taken now
    // would save the pre-edit PDF under the current quote number.
    render(<QuoteDownloadButton project={{ ...project, quote_sync_state: 'pending' } as unknown as AitoProject} />);
    const button = screen.getByRole('button', { name: /download quote/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringMatching(/sync in progress/i));
  });

  it('stays enabled when the sync is idle', () => {
    render(<QuoteDownloadButton project={{ ...project, quote_sync_state: 'idle' } as unknown as AitoProject} />);
    expect(screen.getByRole('button', { name: /download quote/i })).toBeEnabled();
  });
});
