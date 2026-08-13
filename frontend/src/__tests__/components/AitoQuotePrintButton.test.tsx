import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { QuotePrintButton } from '../../components/aito/QuotePrintButton';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

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

  it('is icon-only by default', () => {
    render(<QuotePrintButton project={project} />);
    const button = screen.getByRole('button', { name: /print quote/i });
    // The accessible name still comes from aria-label; the visible label is
    // what withLabel adds.
    expect(button).not.toHaveTextContent('Print quote');
  });

  it('shows a visible "Print quote" label next to the icon when withLabel is set', () => {
    // Visual-parity fix: the panel footer used to be icon-only while sitting
    // beside "Open in Zoho", which has a visible label.
    render(<QuotePrintButton project={project} withLabel />);
    const button = screen.getByRole('button', { name: /print quote/i });
    expect(button).toHaveTextContent('Print quote');
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

  it('cancels the pending 60s revoke timer on unmount and still revokes the URL exactly once', async () => {
    // The revoke backstop scheduled after a successful print used to be a
    // bare window.setTimeout with nothing tracking it: unmounting within 60s
    // left it dangling, touching an already-removed iframe and revoking the
    // URL well after the component was gone instead of right away.
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
      // Unmounting must revoke immediately rather than leaving the URL held
      // until the original 60s deadline.
      expect(revoke).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      // The cancelled timer must not also fire and revoke a second time.
      expect(revoke).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not revoke a URL handed to window.open on unmount, but still revokes it exactly once when its own 60s backstop elapses', async () => {
    // The unmount cleanup above force-revokes immediately, which is correct
    // for the iframe path (nothing else can still be reading that URL once
    // this document's iframe is gone). It is NOT correct for the
    // window.open fallback: the operator may have kept that spawned tab
    // open — or reloaded it — after closing this panel, and revoking the
    // URL out from under it breaks a reload that would otherwise have kept
    // working for the rest of the original 60s window.
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
    // covers both the plain "second overwrites the first" leak and the
    // interaction with the window.open carve-out above: the first print
    // succeeds via the iframe (force-revoked on unmount), the second is
    // escalated to window.open (left for its own timer) — every URL must
    // still end up revoked exactly once.
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
      // The first (iframe-path) URL is force-revoked; the second
      // (window.open path) URL is left alone for its own timer.
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('blob:fake-1');

      await vi.advanceTimersByTimeAsync(60_000);
      // The second URL's own backstop has now elapsed: both URLs end up
      // revoked, each exactly once — no leak, no double revoke.
      expect(revoke).toHaveBeenCalledTimes(2);
      expect(revoke.mock.calls.filter((c) => c[0] === 'blob:fake-1')).toHaveLength(1);
      expect(revoke.mock.calls.filter((c) => c[0] === 'blob:fake-2')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
