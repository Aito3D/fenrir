import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateInvoiceButton } from '../../components/aito/CreateInvoiceButton';
import { canCreateInvoice } from '../../components/aito/canCreateInvoice';
import { ToastProvider } from '../../contexts/ToastContext';
import { api } from '../../api/client';
import type { AitoProject, AitoInvoicePreview } from '../../api/client';

function makeProject(overrides: Partial<AitoProject> = {}): AitoProject {
  return {
    id: 7,
    description: 'Bague entretoise',
    column: 'finish',
    position: 0,
    status: 'active',
    client_id: 'z1',
    client_name: 'ACME SARL',
    quote_id: 'EST-9',
    quote_number: 'DEV26-2493',
    quote_sync_state: 'idle',
    quote_invoiced: false,
    ...overrides,
  } as unknown as AitoProject;
}

const PREVIEW: AitoInvoicePreview = {
  quote_number: 'DEV26-2493',
  currency_code: 'XPF',
  total: 2500,
  line_count: 2,
  retainers: [{ id: 'ret-1', number: 'RET-00269', status: 'paid', total: 1000, applicable: 1000 }],
  projected_balance: 1500,
};

function renderButton(project: AitoProject) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  rtlRender(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <CreateInvoiceButton project={project} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return client;
}

describe('canCreateInvoice', () => {
  it('offers the button only on a finished, quoted, not-yet-billed project', () => {
    expect(canCreateInvoice(makeProject())).toBe(true);
  });

  it('stays away from every other column', () => {
    // Done included: a card only reaches Done once it has been settled, so
    // offering a FIRST invoice there would offer to bill a billed job.
    for (const column of ['devis', 'waiting', 'scan', 'model', 'print', 'done'] as const) {
      expect(canCreateInvoice(makeProject({ column }))).toBe(false);
    }
  });

  it('needs a quote to bill', () => {
    expect(canCreateInvoice(makeProject({ quote_id: null }))).toBe(false);
  });

  it('never offers to bill a project that already has an invoice', () => {
    expect(canCreateInvoice(makeProject({ quote_invoiced: true }))).toBe(false);
  });

  it('waits for a pending sync to land', () => {
    // Billing now would issue a document for the lines as they were BEFORE
    // the pending edit reaches Books, and no later sync corrects an issued
    // invoice.
    expect(canCreateInvoice(makeProject({ quote_sync_state: 'pending' }))).toBe(false);
  });
});

describe('CreateInvoiceButton', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders nothing at all outside Finish', () => {
    renderButton(makeProject({ column: 'print' }));

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('never creates anything on the click that opens the dialog', async () => {
    const preview = vi.spyOn(api, 'getAitoInvoicePreview').mockResolvedValue(PREVIEW);
    const create = vi.spyOn(api, 'createAitoInvoice');
    renderButton(makeProject());

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(preview).toHaveBeenCalledWith(7));
    expect(create).not.toHaveBeenCalled();
  });

  it('names the deposit and what will still be owed before anything happens', async () => {
    vi.spyOn(api, 'getAitoInvoicePreview').mockResolvedValue(PREVIEW);
    renderButton(makeProject());

    await userEvent.click(screen.getByRole('button'));

    // The deposit itself, not just an arithmetic result: a retainer the
    // dialog does not name reads as "there was no deposit".
    expect(await screen.findByText('RET-00269')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('1 500');
  });

  it('lists a deposit that cannot be applied rather than hiding it', async () => {
    vi.spyOn(api, 'getAitoInvoicePreview').mockResolvedValue({
      ...PREVIEW,
      retainers: [{ id: 'ret-1', number: 'RET-00269', status: 'sent', total: 1000, applicable: 0 }],
      projected_balance: 2500,
    });
    renderButton(makeProject());

    await userEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('RET-00269')).toBeInTheDocument();
  });

  it("shows the server's own refusal rather than a generic failure", async () => {
    // Every refusal is a specific, actionable state — still syncing, already
    // invoiced — and flattening them sends the operator to the wrong place.
    vi.spyOn(api, 'getAitoInvoicePreview').mockRejectedValue(
      new Error('This project already has an invoice in Zoho'),
    );
    renderButton(makeProject());

    await userEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('This project already has an invoice in Zoho')).toBeInTheDocument();
  });

  it('seeds the invoice card straight from the response it gets back', async () => {
    vi.spyOn(api, 'getAitoInvoicePreview').mockResolvedValue(PREVIEW);
    const created = {
      id: 'inv-1',
      number: 'FA-26-4100',
      date: '2026-09-12',
      due_date: '2026-09-12',
      total: 2500,
      balance: 1500,
      currency_code: 'XPF',
      status: 'draft',
      url: 'https://books.zoho.eu/app/org1#/invoices/inv-1',
      invoice_count: 1,
      retainers: [{ number: 'RET-00269', total: 1000, applied: 1000 }],
    };
    vi.spyOn(api, 'createAitoInvoice').mockResolvedValue(created);
    const client = renderButton(makeProject());

    await userEvent.click(screen.getByRole('button'));
    await screen.findByText('RET-00269');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    // The card must appear in the same frame the button leaves; a refetch
    // round trip would leave the panel showing neither.
    await waitFor(() => expect(client.getQueryData(['aito-invoice', 7])).toEqual(created));
  });
});
