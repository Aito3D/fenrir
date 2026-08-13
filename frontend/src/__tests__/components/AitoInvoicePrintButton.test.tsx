import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { InvoicePrintButton } from '../../components/aito/InvoicePrintButton';
import { api } from '../../api/client';

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

  it('always shows a visible "Print invoice" label next to the icon, unlike QuotePrintButton\'s opt-in withLabel', () => {
    render(<InvoicePrintButton projectId={12} invoiceId="inv-1" />);
    const button = screen.getByRole('button', { name: /print invoice/i });
    expect(button).toHaveTextContent('Print invoice');
  });

  it('surfaces a failed fetch with the invoice-specific message, not the quote one', async () => {
    vi.spyOn(api, 'getAitoInvoicePdf').mockRejectedValue(new Error('HTTP 502'));
    const user = userEvent.setup();

    render(<InvoicePrintButton projectId={12} invoiceId="inv-1" />);
    await user.click(screen.getByRole('button', { name: /print invoice/i }));

    await waitFor(() => expect(screen.getByText(/could not fetch the invoice pdf/i)).toBeInTheDocument());
  });
});
