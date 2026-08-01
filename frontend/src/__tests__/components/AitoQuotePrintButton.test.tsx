import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
});
