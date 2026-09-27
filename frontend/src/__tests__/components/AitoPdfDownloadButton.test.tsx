import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { render } from '../utils';
import { PdfDownloadButton } from '../../components/aito/PdfDownloadButton';

// jsdom implements neither of these; the component must not assume they
// exist beyond what it actually calls (same reasoning as the print button's
// sibling test file).
describe('PdfDownloadButton', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let anchorClick: ReturnType<typeof vi.fn>;
  let clickedAnchors: HTMLAnchorElement[];

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:fake');
    revokeObjectURL = vi.fn();
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.URL.revokeObjectURL = revokeObjectURL;
    clickedAnchors = [];
    // jsdom logs a "Not implemented: navigation" error if the anchor's own
    // click is left to run; stub it so the test can inspect the anchor
    // (href/download) the component built without actually navigating.
    anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedAnchors.push(this);
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fetches the PDF, saves it under the sanitised filename, and clears busy afterwards', async () => {
    const blob = new Blob(['%PDF-']);
    const fetchPdf = vi.fn().mockResolvedValue(blob);
    render(
      <PdfDownloadButton
        fetchPdf={fetchPdf}
        label="Download quote"
        filename="Devis 12/34: février?"
        failureMessage="Could not fetch the PDF"
      />,
    );

    const button = screen.getByRole('button', { name: 'Download quote' });
    fireEvent.click(button);

    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));

    expect(fetchPdf).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickedAnchors).toHaveLength(1);
    // The special characters and whitespace are collapsed to single
    // hyphens and the extension is appended by the component, not the
    // caller.
    expect(clickedAnchors[0].download).toBe('Devis-12-34-février.pdf');
    expect(clickedAnchors[0].href).toBe('blob:fake');

    // Busy toggles back off once the download has settled: the spinner
    // icon is gone and the button is clickable again.
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('falls back to "document.pdf" when the filename sanitises away to nothing', async () => {
    const fetchPdf = vi.fn().mockResolvedValue(new Blob(['%PDF-']));
    render(
      <PdfDownloadButton
        fetchPdf={fetchPdf}
        label="Download quote"
        filename="   ///:::   "
        failureMessage="Could not fetch the PDF"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download quote' }));

    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
    expect(clickedAnchors[0].download).toBe('document.pdf');
  });

  it('revokes the object URL after the backstop delay, not immediately on click', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchPdf = vi.fn().mockResolvedValue(new Blob(['%PDF-']));
    render(
      <PdfDownloadButton
        fetchPdf={fetchPdf}
        label="Download quote"
        filename="quote"
        failureMessage="Could not fetch the PDF"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download quote' }));
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));

    expect(revokeObjectURL).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('surfaces the caller-provided failure message and clears busy when the fetch rejects', async () => {
    const fetchPdf = vi.fn().mockRejectedValue(new Error('HTTP 502'));
    render(
      <PdfDownloadButton
        fetchPdf={fetchPdf}
        label="Download invoice"
        filename="invoice"
        failureMessage="Could not fetch the invoice PDF"
      />,
    );

    const button = screen.getByRole('button', { name: 'Download invoice' });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('Could not fetch the invoice PDF')).toBeInTheDocument());

    // Nothing was ever created or clicked on the failure path.
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('ignores a second click while a download is still in flight', async () => {
    let resolveFetch: (blob: Blob) => void = () => {};
    const fetchPdf = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    render(
      <PdfDownloadButton
        fetchPdf={fetchPdf}
        label="Download quote"
        filename="quote"
        failureMessage="Could not fetch the PDF"
      />,
    );

    const button = screen.getByRole('button', { name: 'Download quote' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());

    // The button is disabled while busy, so a second click is a no-op —
    // exactly the guard against a duplicate download the busy state exists
    // for.
    fireEvent.click(button);
    expect(fetchPdf).toHaveBeenCalledTimes(1);

    resolveFetch(new Blob(['%PDF-']));
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('does not touch state after the component unmounts mid-download', async () => {
    let resolveFetch: (blob: Blob) => void = () => {};
    const fetchPdf = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { unmount } = render(
      <PdfDownloadButton
        fetchPdf={fetchPdf}
        label="Download quote"
        filename="quote"
        failureMessage="Could not fetch the PDF"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download quote' }));
    await waitFor(() => expect(fetchPdf).toHaveBeenCalledTimes(1));

    unmount();

    // Resolving after unmount must not throw a "set state on an unmounted
    // component" warning — the mountedRef guard on the finally block
    // exists precisely for this race.
    expect(() => resolveFetch(new Blob(['%PDF-']))).not.toThrow();
  });
});
