import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { PdfPrintButton } from '../../components/aito/PdfPrintButton';

/** Covers the window.open fallback itself — checking the popup handle it
 *  returns and what happens when it comes back null — rather than
 *  duplicating the full blob/iframe/revoke matrix already pinned through
 *  `AitoQuotePrintButton.test.tsx`. Both tests reach the fallback the same
 *  way that component's real callers do: `contentWindow.print()` throwing
 *  inside the iframe's `onload`, escalating synchronously to `openInTab`
 *  without needing to wait out the 3s load-timeout timer. */
describe('PdfPrintButton — blocked popup fallback', () => {
  afterEach(() => vi.restoreAllMocks());

  const renderButton = () => {
    const fetchPdf = vi.fn().mockResolvedValue(new Blob(['%PDF-']));
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({
      focus: () => {},
      print: () => {
        throw new Error('not supported');
      },
    } as unknown as Window);
    render(<PdfPrintButton fetchPdf={fetchPdf} label="Print quote" failureMessage="Could not fetch the PDF" />);
    return fetchPdf;
  };

  const clickAndEscalate = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: /print quote/i }));
    let iframe: HTMLIFrameElement | null = null;
    await waitFor(() => {
      iframe = document.querySelector('iframe');
      expect(iframe).not.toBeNull();
    });
    fireEvent.load(iframe as HTMLIFrameElement);
  };

  it('opens the popup and reports success when window.open hands back a window', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    const user = userEvent.setup();
    renderButton();

    await clickAndEscalate(user);

    await waitFor(() => expect(open).toHaveBeenCalledWith('blob:fake', '_blank'));
    // Success path stays byte-identical: the existing "opened in a tab"
    // info toast, and no download fallback triggered.
    expect(await screen.findByText('Opened in a new tab — press Ctrl+P to print')).toBeInTheDocument();
    expect(screen.queryByText(/pop-up blocked/i)).not.toBeInTheDocument();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('reports a failure and hands the PDF over as a download when the popup is blocked', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    let clickedHref = '';
    let clickedDownload = '';
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedHref = this.href;
        clickedDownload = this.download;
      });
    const user = userEvent.setup();
    renderButton();

    await clickAndEscalate(user);

    await waitFor(() => expect(open).toHaveBeenCalledWith('blob:fake', '_blank'));
    // A blocked popup must report failure, never the false "opened in a new
    // tab" claim — this is the mutation this test kills: if the fix ignored
    // window.open's return value again, the info toast below would appear
    // instead and this assertion would fail.
    expect(await screen.findByText('Pop-up blocked — downloading the PDF instead')).toBeInTheDocument();
    expect(screen.queryByText('Opened in a new tab — press Ctrl+P to print')).not.toBeInTheDocument();
    // The blob is kept reachable via a programmatic download rather than
    // only being revoked out from under the operator.
    expect(clickSpy).toHaveBeenCalled();
    expect(clickedHref).toContain('blob:fake');
    expect(clickedDownload).toBe('quote.pdf');
  });

  it('derives the download filename from the label so an invoice download is never named "quote"', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    let clickedDownload = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedDownload = this.download;
    });
    const fetchPdf = vi.fn().mockResolvedValue(new Blob(['%PDF-']));
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({
      focus: () => {},
      print: () => {
        throw new Error('not supported');
      },
    } as unknown as Window);
    const user = userEvent.setup();
    render(<PdfPrintButton fetchPdf={fetchPdf} label="Print invoice" failureMessage="fetch failed" />);

    await user.click(screen.getByRole('button', { name: /print invoice/i }));
    let iframe: HTMLIFrameElement | null = null;
    await waitFor(() => {
      iframe = document.querySelector('iframe');
      expect(iframe).not.toBeNull();
    });
    fireEvent.load(iframe as HTMLIFrameElement);

    await waitFor(() => expect(clickedDownload).toBe('invoice.pdf'));
  });

  it('still schedules the 60s revoke backstop after a blocked popup, exactly once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(window, 'open').mockReturnValue(null);
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      const fetchPdf = vi.fn().mockResolvedValue(new Blob(['%PDF-']));
      globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
      const revoke = vi.fn();
      globalThis.URL.revokeObjectURL = revoke;
      vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({
        focus: () => {},
        print: () => {
          throw new Error('not supported');
        },
      } as unknown as Window);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<PdfPrintButton fetchPdf={fetchPdf} label="Print quote" failureMessage="fetch failed" />);

      await user.click(screen.getByRole('button', { name: /print quote/i }));
      let iframe: HTMLIFrameElement | null = null;
      await waitFor(() => {
        iframe = document.querySelector('iframe');
        expect(iframe).not.toBeNull();
      });
      fireEvent.load(iframe as HTMLIFrameElement);

      await waitFor(() => expect(screen.getByText('Pop-up blocked — downloading the PDF instead')).toBeInTheDocument());
      expect(revoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('blob:fake');
    } finally {
      vi.useRealTimers();
    }
  });
});
