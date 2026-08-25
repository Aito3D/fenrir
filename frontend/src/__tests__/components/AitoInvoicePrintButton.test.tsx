import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { InvoicePrintButton } from '../../components/aito/InvoicePrintButton';
import { api } from '../../api/client';
import { ACTION_CELL } from '../../components/aito/quoteActionGroup';

/** Covers what is specific to this wrapper — its own gating, its endpoint,
 *  its label and its failure message. The shared blob/iframe/window.open/
 *  revoke machinery is `PdfPrintButton`'s and is already pinned through
 *  `AitoQuotePrintButton.test.tsx`; duplicating that matrix here would only
 *  double the maintenance cost of every future change to it. */
describe('InvoicePrintButton', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders unconditionally once mounted — unlike QuotePrintButton, this wrapper has no gate of its own; InvoiceCard only mounts it once an invoice exists', () => {
    render(<InvoicePrintButton projectId={12} invoiceId="inv-1" />);
    expect(screen.getByRole('button', { name: /print invoice/i })).toBeInTheDocument();
  });

  it('fetches the specific invoice PDF for the project when clicked', async () => {
    const spy = vi.spyOn(api, 'getAitoInvoicePdf').mockResolvedValue(new Blob(['%PDF-']));
    // jsdom implements neither of these; the component must not assume they
    // exist beyond what it actually calls.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
    const user = userEvent.setup();

    render(<InvoicePrintButton projectId={12} invoiceId="inv-1" />);
    await user.click(screen.getByRole('button', { name: /print invoice/i }));

    // The id pins the print to the invoice the card is actually showing —
    // not whatever the server would resolve as newest.
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, 'inv-1'));
  });

  it('renders as a cell of the shared action group, with "Print invoice" carried by aria-label rather than visible text', () => {
    // This card shares the Quote card's 230.4px column and its row mirrors it
    // exactly, so it wrapped for the same reason and takes the same fix. The
    // accessible name still disambiguates invoice from quote — that is the half
    // that matters once the visible text is gone, so it is pinned here.
    render(<InvoicePrintButton projectId={12} invoiceId="inv-1" />);
    const button = screen.getByRole('button', { name: /print invoice/i });
    expect(button).toHaveTextContent('');
    expect(button).toHaveAttribute('aria-label', 'Print invoice');
    expect(button).toHaveAttribute('title', 'Print invoice');
    // Same constant as the Quote card's cells: the two rows are meant to be
    // one family, and this is what stops them drifting apart.
    expect(button).toHaveAttribute('class', ACTION_CELL);
  });

  it('surfaces a failed fetch with the invoice-specific message, not the quote one', async () => {
    vi.spyOn(api, 'getAitoInvoicePdf').mockRejectedValue(new Error('HTTP 502'));
    const user = userEvent.setup();

    render(<InvoicePrintButton projectId={12} invoiceId="inv-1" />);
    await user.click(screen.getByRole('button', { name: /print invoice/i }));

    await waitFor(() => expect(screen.getByText(/could not fetch the invoice pdf/i)).toBeInTheDocument());
  });
});
