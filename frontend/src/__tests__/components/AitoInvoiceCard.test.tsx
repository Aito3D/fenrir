import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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

  it('renders the number, total and status once Books answers', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);

    render(<InvoiceCard project={project} canUpdate />);

    expect(await screen.findByText('FA-26-0001')).toBeInTheDocument();
    expect(screen.getByText('2026-08-03')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });

  it('links the number to the invoice in Books', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);

    render(<InvoiceCard project={project} canUpdate />);

    const link = await screen.findByRole('link', { name: /FA-26-0001/ });
    expect(link).toHaveAttribute('href', INVOICE.url);
    // Both required together: `noopener` is what stops the opened tab from
    // reaching back through window.opener.
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders nothing when the project has no invoice', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(null);

    render(<InvoiceCard project={project} canUpdate />);

    await waitFor(() => expect(api.getAitoInvoice).toHaveBeenCalled());
    // Not `toBeEmptyDOMElement` on the container: the shared render wrapper
    // always mounts a toast viewport, so the container is never empty and the
    // assertion would pass for the wrong reason. The card's own heading is
    // the thing that must be absent.
    expect(screen.queryByTestId('panel-card-heading')).not.toBeInTheDocument();
  });

  it('renders nothing, rather than an error, when Zoho is unreachable', async () => {
    // The one card in this panel that needs Zoho live. A failure here must
    // not take the panel with it — every other card still has its data.
    vi.spyOn(api, 'getAitoInvoice').mockRejectedValue(new Error('HTTP 502'));

    render(<InvoiceCard project={project} canUpdate />);

    await waitFor(() => expect(api.getAitoInvoice).toHaveBeenCalled());
    expect(screen.queryByTestId('panel-card-heading')).not.toBeInTheDocument();
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

  it('shows the balance only while something is still owed', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue({ ...INVOICE, status: 'partially_paid', balance: 5000 });

    render(<InvoiceCard project={project} canUpdate />);

    expect(await screen.findByText('Balance due')).toBeInTheDocument();
    expect(screen.getByText('Partially paid')).toBeInTheDocument();
  });

  it('hides the balance row on a fully paid invoice', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);

    render(<InvoiceCard project={project} canUpdate />);

    await screen.findByText('FA-26-0001');
    expect(screen.queryByText('Balance due')).not.toBeInTheDocument();
  });

  it('says how many other invoices this quote has', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue({ ...INVOICE, invoice_count: 3 });

    render(<InvoiceCard project={project} canUpdate />);

    // 3 invoices total, 2 besides the one shown.
    expect(await screen.findByText('Other invoices: 2')).toBeInTheDocument();
  });

  it('renders a status Zoho invented rather than dropping it', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue({ ...INVOICE, status: 'disputed' });

    render(<InvoiceCard project={project} canUpdate />);

    expect(await screen.findByText('disputed')).toBeInTheDocument();
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

    // The link must carry readable text, not just an external-link icon.
    const link = await screen.findByRole('link', { name: /inv-1/ });
    expect(link).toHaveAttribute('href', INVOICE.url);
  });
});
