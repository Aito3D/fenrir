import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { InvoiceCard } from '../../components/aito/InvoiceCard';
import { api } from '../../api/client';
import type { AitoInvoice, AitoProject } from '../../api/client';

const INVOICE: AitoInvoice = {
  id: 'inv-1',
  number: 'FA-26-0001',
  date: '2026-08-03',
  due_date: '2026-08-17',
  total: 18350,
  balance: 0,
  currency_code: 'XPF',
  status: 'paid',
  url: 'https://books.zoho.eu/app/org1#/invoices/inv-1',
  invoice_count: 1,
};

/** An invoiced, sync-managed project — the case the card is built for. */
const project = {
  id: 12,
  quote_id: 'EST-9',
  quote_number: 'QT-00412',
  quote_invoiced: true,
  quote_sync_state: 'locked',
} as unknown as AitoProject;

describe('InvoiceCard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders one document row: number with its dates tooltip, status and total on line two', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);

    render(<InvoiceCard project={project} canUpdate />);

    const row = await screen.findByTestId('invoice-block');
    expect(within(row).getByText('Invoice')).toBeInTheDocument();
    expect(within(row).getByText('FA-26-0001')).toHaveAttribute('title', 'Issued 2026-08-03 · due 2026-08-17');
    expect(within(row).getByText('Paid')).toHaveClass('text-bambu-green-light');
    expect(within(row).getByText(/18.350/)).toBeInTheDocument();
    expect(within(row).queryByText('Total')).toBeNull();
    expect(within(row).queryByText('2026-08-03')).toBeNull();
  });

  it('reaches Books through the row icon, not the number', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);

    render(<InvoiceCard project={project} canUpdate />);

    const link = await screen.findByRole('link', { name: 'Open in Zoho Books' });
    expect(link).toHaveAttribute('href', INVOICE.url);
    // Both required together: `noopener` is what stops the opened tab from
    // reaching back through window.opener.
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('link', { name: /FA-26-0001/ })).toBeNull();
  });

  it('renders nothing when the project has no invoice', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(null);

    render(<InvoiceCard project={project} canUpdate />);

    await waitFor(() => expect(api.getAitoInvoice).toHaveBeenCalled());
    // Not `toBeEmptyDOMElement` on the container: the shared render wrapper
    // always mounts a toast viewport, so the container is never empty and the
    // assertion would pass for the wrong reason. The row itself is the thing
    // that must be absent.
    expect(screen.queryByTestId('invoice-block')).not.toBeInTheDocument();
  });

  it('renders nothing, rather than an error, when Zoho is unreachable', async () => {
    // The one card in this panel that needs Zoho live. A failure here must
    // not take the panel with it — every other card still has its data.
    vi.spyOn(api, 'getAitoInvoice').mockRejectedValue(new Error('HTTP 502'));

    render(<InvoiceCard project={project} canUpdate />);

    await waitFor(() => expect(api.getAitoInvoice).toHaveBeenCalled());
    expect(screen.queryByTestId('invoice-block')).not.toBeInTheDocument();
  });

  it('never asks Zoho about a project that has not been invoiced', async () => {
    const spy = vi.spyOn(api, 'getAitoInvoice');

    render(<InvoiceCard project={{ ...project, quote_invoiced: false } as AitoProject} canUpdate />);

    await waitFor(() => expect(spy).not.toHaveBeenCalled());
  });

  it('still asks about an unmanaged project despite the flag being false', async () => {
    // `quote_invoiced` is written only by the sync sweep, and an 'unmanaged'
    // project never enters it — so the flag is false forever on cards that
    // may well be invoiced. Gating on the flag alone would hide those.
    const spy = vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);

    render(
      <InvoiceCard project={{ ...project, quote_invoiced: false, quote_sync_state: 'unmanaged' } as AitoProject} canUpdate />,
    );

    await waitFor(() => expect(spy).toHaveBeenCalledWith(12));
  });

  it('never asks about a hand-made project with no quote at all', async () => {
    const spy = vi.spyOn(api, 'getAitoInvoice');

    render(<InvoiceCard project={{ ...project, quote_id: null } as unknown as AitoProject} canUpdate />);

    await waitFor(() => expect(spy).not.toHaveBeenCalled());
  });

  it('keeps print and download enabled while the quote sync is pending', async () => {
    // The endpoint pushes the card's pending edit to Zoho before it returns
    // the PDF, so the buttons no longer sit a pending sync out.
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);

    render(<InvoiceCard project={{ ...project, quote_sync_state: 'pending' } as AitoProject} canUpdate />);

    expect(await screen.findByRole('button', { name: /print invoice/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /download invoice/i })).toBeEnabled();
  });

  it('keeps print and download enabled on a locked (invoiced) sync state', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);

    render(<InvoiceCard project={project} canUpdate />);

    expect(await screen.findByRole('button', { name: /print invoice/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /download invoice/i })).toBeEnabled();
  });

  it('says how many other invoices this quote has', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue({ ...INVOICE, invoice_count: 3 });

    render(<InvoiceCard project={project} canUpdate />);

    // 3 invoices total, 2 besides the one shown.
    expect(await screen.findByText('Other invoices: 2')).toBeInTheDocument();
  });

  it('keeps the other-invoices note in the same divide-y child as its row', async () => {
    // BillingCard stacks the rows in a `divide-y` wrapper, which draws a
    // hairline between direct children. Row and note as two children would
    // paint a line between the row and its own note.
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue({ ...INVOICE, invoice_count: 2 });

    render(
      <div data-testid="rows">
        <InvoiceCard project={project} canUpdate />
      </div>,
    );

    const note = await screen.findByText('Other invoices: 1');
    const host = screen.getByTestId('rows');
    expect(host.children).toHaveLength(1);
    expect(host.firstElementChild).toContainElement(screen.getByTestId('invoice-block'));
    expect(host.firstElementChild).toContainElement(note);
  });

  it('renders a status Zoho invented rather than dropping it', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue({ ...INVOICE, status: 'disputed' });

    render(<InvoiceCard project={project} canUpdate />);

    expect(await screen.findByText('disputed')).toBeInTheDocument();
  });

  // `status` is typed as a plain `string` on AitoInvoice — there is no
  // runtime validation against Books' actual vocabulary — so a status that
  // happens to collide with an inherited Object.prototype member must not
  // resolve to that member. invoiceStatusLabelKey and invoiceStatusTone both
  // guard their map lookups with Object.hasOwn for exactly this reason (see
  // invoiceStatus.test.ts for the direct unit-level pin); 'disputed' above
  // never exercises that guard, since it is unmapped either way. Without it,
  // `statusKey` would resolve to the inherited `Object.prototype.toString`
  // function, and `statusKey ? t(statusKey) : invoice.status` would pass that
  // function into i18next's `t`, which throws (`Cannot read properties of
  // undefined (reading 'join')`) rather than rendering anything at all.
  it('falls back to the raw string and neutral tone, rather than crashing, when status collides with an Object.prototype member', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue({ ...INVOICE, status: 'toString' });

    render(<InvoiceCard project={project} canUpdate={false} />);

    const statusValue = await screen.findByText('toString');
    expect(statusValue.className).toContain('text-bambu-gray-light');
    expect(statusValue.className).not.toContain('bambu-green');
  });

  it('offers a print button', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);

    render(<InvoiceCard project={project} canUpdate />);

    expect(await screen.findByRole('button', { name: /print invoice/i })).toBeInTheDocument();
  });

  it('prints the invoice it is displaying, not whatever is newest', async () => {
    // The card is served from a 5-minute cache while the endpoint resolves
    // live, and Books can invoice one estimate in parts. Without passing the
    // id, Print could emit a document whose number the operator never saw.
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);
    const pdf = vi.spyOn(api, 'getAitoInvoicePdf').mockResolvedValue(new Blob(['%PDF-']));
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
    const user = userEvent.setup();

    render(<InvoiceCard project={project} canUpdate />);
    await user.click(await screen.findByRole('button', { name: /print invoice/i }));

    await waitFor(() => expect(pdf).toHaveBeenCalledWith(12, 'inv-1'));
  });

  it('falls back to the id when Books gives the invoice no number', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue({ ...INVOICE, number: '' });

    render(<InvoiceCard project={project} canUpdate />);

    // The row must carry a readable number, not an empty cell.
    expect(await screen.findByText('inv-1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Zoho Books' })).toHaveAttribute('href', INVOICE.url);
  });
});
