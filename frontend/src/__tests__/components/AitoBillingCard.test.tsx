import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { BillingCard } from '../../components/aito/BillingCard';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

vi.mock('../../utils/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }));

function project(overrides: Partial<AitoProject> = {}): AitoProject {
  return { id: 12, description: 'x', column: 'devis', position: 0, status: 'active', client_id: 'z1', client_name: 'ACME',
    client_phone: null, client_email: null, client_is_company: null, client_social_network: null, client_social_handle: null,
    client_contact_person_id: null, client_contact_name: null,
    quote_id: 'E1', quote_number: 'DEV-2026-1234', quote_date: '2026-09-12', quote_total: 110100, quote_url: null, quote_salesperson: null,
    quote_status: 'accepted', quote_accepted_at: null, quote_sent_at: null, invoice_status: null, invoice_balance: null,
    invoice_due_date: null, invoice_checked_at: null, quote_expiry_date: '2026-09-27', retainer_paid_total: null, payment_link: null,
    invoice_payment_link: null, terminal_payment: null,
    quote_sync_state: 'idle', quote_invoiced: false, flag: null, client_contacted_at: null, due_date: null, quote_sync_error: null,
    quote_status_block: null, quote_status_remote: null, created_by: null, task_count: 0, tasks_total: 0, task_services: [],
    task_pending: [], steps_total: 0, steps_done: 0, print_minutes_pending: 0, task_steps: [], move_lock: null, shipping_island: null,
    shipping_service: null, shipping_first_name: null, shipping_last_name: null, shipping_phone: null, shipping_price: null,
    shipping_lta: null, shipping_service_name: null, tracking_configured: false, version: 1,
    created_at: '2026-09-12T00:00:00', updated_at: '2026-09-12T00:00:00', ...overrides };
}

function renderCard(p: AitoProject, overrides: Partial<Parameters<typeof BillingCard>[0]> = {}) {
  return render(
    <BillingCard
      project={p}
      canUpdate
      onRetrySync={() => {}}
      retryPending={false}
      onForceSync={() => {}}
      forcePending={false}
      depositPct={0}
      currency="XPF"
      heimdallConfigured
      {...overrides}
    />,
  );
}

describe('BillingCard deposit row', () => {
  // The row is the CUSTOMER's unspent deposits (`customer_credit_total`),
  // not the estimate's own paid retainers (`retainer_paid_total`): a
  // retainer raised by hand in Books references no quote and only shows up
  // in the former, and a deposit spent on another invoice drops out of it.
  it('shows what the customer still has on account across every deposit', () => {
    renderCard(project({ customer_credit_total: 36700, retainer_paid_total: 10000 }));
    expect(screen.getByText('Deposit available')).toBeInTheDocument();
    // formatMoney renders XPF as "36 700 FCFP" (thin space + NBSP); match the digits.
    expect(screen.getByText(/36.700/)).toBeInTheDocument();
    expect(screen.queryByText(/10.000/)).not.toBeInTheDocument();
  });

  it('has no deposit row before the sweep has read the customer', () => {
    renderCard(project({ customer_credit_total: null, retainer_paid_total: 10000 }));
    expect(screen.queryByText('Deposit available')).not.toBeInTheDocument();
    expect(screen.queryByText('Deposit paid')).not.toBeInTheDocument();
  });

  it('has no deposit row once every deposit has been spent', () => {
    renderCard(project({ customer_credit_total: 0, retainer_paid_total: 10000 }));
    expect(screen.queryByText('Deposit available')).not.toBeInTheDocument();
  });
});

/** The Force sync control, and the label it sits under.
 *
 *  A card can be 'locked' for two unrelated reasons (see quoteSync.ts's
 *  `canForceSync`): it has been invoiced, which is final, or the worker
 *  REFUSED to push — today that means a tax-exclusive estimate, which Aito's
 *  tax-inclusive costs cannot be written onto without inflating the total by
 *  the tax rate. A lock leaves the 300s sweep for good, so the refusal kind
 *  needs a way to ask the app to look at the estimate again once it has been
 *  fixed in Books; the invoiced kind must not offer one. */
const TAX_EXCLUSIVE =
  'This quote is tax-exclusive; Aito costs are tax-inclusive and cannot be pushed without inflating the total';

describe('BillingCard force sync', () => {
  it('offers a force control, and names the lock a block, on a refused push', () => {
    renderCard(project({ quote_sync_state: 'locked', quote_invoiced: false, quote_sync_error: TAX_EXCLUSIVE }));
    expect(screen.getByText('Sync blocked')).toBeInTheDocument();
    expect(screen.getByText(TAX_EXCLUSIVE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Force sync' })).toBeInTheDocument();
    // "Quote invoiced" is simply untrue of a quote that was never billed.
    expect(screen.queryByText('Quote invoiced')).not.toBeInTheDocument();
  });

  it('calls back once when it is pressed', async () => {
    const onForceSync = vi.fn();
    renderCard(
      project({ quote_sync_state: 'locked', quote_invoiced: false, quote_sync_error: TAX_EXCLUSIVE }),
      { onForceSync },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Force sync' }));
    expect(onForceSync).toHaveBeenCalledTimes(1);
  });

  it('disables it while the queue request is in flight', () => {
    renderCard(project({ quote_sync_state: 'locked', quote_invoiced: false, quote_sync_error: TAX_EXCLUSIVE }), {
      forcePending: true,
    });
    expect(screen.getByRole('button', { name: 'Force sync' })).toBeDisabled();
  });

  it('offers nothing on an invoiced lock, which no re-attempt can clear', () => {
    renderCard(project({ quote_sync_state: 'locked', quote_invoiced: true }));
    expect(screen.getByText('Quote invoiced')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Force sync' })).not.toBeInTheDocument();
  });

  it('hides it from a reader, since the route it calls enforces AITO_UPDATE', () => {
    renderCard(project({ quote_sync_state: 'locked', quote_invoiced: false, quote_sync_error: TAX_EXCLUSIVE }), {
      canUpdate: false,
    });
    expect(screen.getByText(TAX_EXCLUSIVE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Force sync' })).not.toBeInTheDocument();
  });
});

const RETAINER = {
  id: 'RET-B', number: 'AC-26-0031', date: '2026-09-03', total: 17500, balance: 0, currency_code: 'XPF',
  status: 'paid', url: 'https://books.zoho.eu/app/org1#/retainerinvoices/RET-B',
};
const INVOICE = {
  id: 'inv-1', number: 'FA-26-4100', date: '2026-09-27', due_date: '2026-10-12', total: 35000, balance: 17500,
  currency_code: 'XPF', status: 'unpaid', url: 'https://books.zoho.eu/app/org1#/invoices/inv-1', invoice_count: 1,
};

describe('BillingCard document rows', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists quote, retainers, invoice in that order, then the collect block, then sync facts', async () => {
    vi.spyOn(api, 'getAitoRetainers').mockResolvedValue([RETAINER]);
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);
    renderCard(
      project({
        quote_invoiced: true, quote_sync_state: 'locked', retainer_paid_total: 17500, quote_url: 'https://books/q',
      }),
    );

    expect(await screen.findByTestId('doc-retainer-RET-B')).toBeInTheDocument();
    await screen.findByTestId('invoice-block');
    const labels = screen.getAllByTestId(/^doc-|^invoice-block$/).map((n) => n.textContent ?? '');
    expect(labels[0]).toContain('DEV-2026-1234');
    expect(labels[1]).toContain('AC-26-0031');
    expect(labels[2]).toContain('FA-26-4100');
    // The collect block sits under the rows and names the invoice's balance.
    const card = screen.getByTestId('doc-quote').parentElement!.parentElement!;
    const blocks = within(card).getAllByTestId('payment-block');
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(within(card).getByText('Balance due')).toBeInTheDocument();
    const syncFacts = within(card).getByText('Quote invoiced');
    const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(screen.getByTestId('invoice-block'), blocks[0])).toBe(true);
    expect(follows(blocks[blocks.length - 1], syncFacts)).toBe(true);
  });

  it('gives the retainer row all four actions', async () => {
    vi.spyOn(api, 'getAitoRetainers').mockResolvedValue([RETAINER]);
    renderCard(project({ retainer_paid_total: 17500 }));

    const row = await screen.findByTestId('doc-retainer-RET-B');
    expect(within(row).getByText('Retainer invoice')).toBeInTheDocument();
    expect(within(row).getByText('Paid')).toBeInTheDocument();
    expect(within(row).getByText(/17.500/)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Print retainer invoice' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Download retainer invoice' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Send retainer invoice' })).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Open in Zoho Books' })).toHaveAttribute('href', RETAINER.url);
  });

  it('states a retainer with no currency of its own in the shop currency', async () => {
    vi.spyOn(api, 'getAitoRetainers').mockResolvedValue([{ ...RETAINER, currency_code: '' }]);
    renderCard(project({ retainer_paid_total: 17500 }));

    const row = await screen.findByTestId('doc-retainer-RET-B');
    expect(within(row).getByText(/17.500 FCFP/)).toBeInTheDocument();
  });

  it('never asks for retainers on a quoted, unpaid card, and renders no retainer row', async () => {
    const spy = vi.spyOn(api, 'getAitoRetainers');
    renderCard(project());
    await waitFor(() => expect(screen.getByTestId('doc-quote')).toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByTestId(/^doc-retainer-/)).toBeNull();
  });

  it('hides every send button from a reader', async () => {
    vi.spyOn(api, 'getAitoRetainers').mockResolvedValue([RETAINER]);
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);
    renderCard(project({ quote_invoiced: true, retainer_paid_total: 17500 }), { canUpdate: false });
    await screen.findByTestId('doc-retainer-RET-B');
    await screen.findByTestId('invoice-block');
    expect(screen.queryByRole('button', { name: /^Send/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Print/ })).toHaveLength(3);
  });

  it('has no segmented action bar any more — only the collect block uses it', async () => {
    renderCard(project({ quote_total: 100000 }), { depositPct: 30 });
    // The quote row's cluster: four 24px buttons/links; the collect block's cells are the only `flex-1` buttons.
    const cells = screen.getAllByRole('button').filter((b) => b.className.includes('flex-1'));
    expect(cells.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Payment link',
      'Pay by card on the terminal',
      'Manual — record a payment',
    ]);
    expect(screen.getByRole('button', { name: 'Print quote' }).className).toContain('p-1 ');
  });

  it('keeps print and download enabled on every row while the quote sync is pending', async () => {
    // The endpoints push the card first; nothing stale can come back.
    vi.spyOn(api, 'getAitoRetainers').mockResolvedValue([RETAINER]);
    renderCard(project({ quote_sync_state: 'pending', retainer_paid_total: 17500 }));
    await screen.findByTestId('doc-retainer-RET-B');
    for (const name of ['Print quote', 'Download quote', 'Print retainer invoice', 'Download retainer invoice']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
  });
});
describe('BillingCard sync line', () => {
  it('reads "Syncing with Zoho…" while a push is pending', () => {
    renderCard(project({ quote_sync_state: 'pending' }));
    expect(screen.getByText('Syncing with Zoho…')).toBeInTheDocument();
  });

  it('says nothing about sync on a card that was idle all along', () => {
    renderCard(project({ quote_sync_state: 'idle' }));
    expect(screen.queryByText('Up to date in Zoho')).not.toBeInTheDocument();
    expect(screen.queryByText('Syncing with Zoho…')).not.toBeInTheDocument();
  });

  it('confirms "Up to date in Zoho" once a pending push it showed has landed', () => {
    const view = renderCard(project({ quote_sync_state: 'pending' }));
    view.rerender(
      <BillingCard
        project={project({ quote_sync_state: 'idle' })}
        canUpdate
        onRetrySync={() => {}}
        retryPending={false}
        onForceSync={() => {}}
        forcePending={false}
        depositPct={0}
        currency="XPF"
        heimdallConfigured
      />,
    );
    expect(screen.getByText('Up to date in Zoho')).toBeInTheDocument();
  });

  it('does not carry the confirmation over to another card', () => {
    const view = renderCard(project({ id: 12, quote_sync_state: 'pending' }));
    view.rerender(
      <BillingCard
        project={project({ id: 13, quote_sync_state: 'idle' })}
        canUpdate
        onRetrySync={() => {}}
        retryPending={false}
        onForceSync={() => {}}
        forcePending={false}
        depositPct={0}
        currency="XPF"
        heimdallConfigured
      />,
    );
    expect(screen.queryByText('Up to date in Zoho')).not.toBeInTheDocument();
  });
});

describe('BillingCard on a card whose quote is being created', () => {
  const creating = () =>
    project({ quote_id: null, quote_number: null, quote_status: null, quote_total: null, quote_sync_state: 'pending' });

  it('shows the quote row with a placeholder number and working print and download', async () => {
    const fetchPdf = vi.spyOn(api, 'getAitoQuotePdf').mockResolvedValue(new Blob(['%PDF']));
    renderCard(creating());
    const row = screen.getByTestId('doc-quote');
    expect(within(row).getByText('Creating quote…')).toBeInTheDocument();
    const print = within(row).getByRole('button', { name: /print quote/i });
    expect(print).toBeEnabled();
    expect(within(row).getByRole('button', { name: /download quote/i })).toBeEnabled();
    await userEvent.click(print);
    await waitFor(() => expect(fetchPdf).toHaveBeenCalledWith(12));
  });

  it('offers no send action before the quote exists', () => {
    renderCard(creating());
    expect(within(screen.getByTestId('doc-quote')).queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
  });

  it('still shows no quote row on a hand-made card with no quote at all', () => {
    renderCard(project({ quote_id: null, quote_number: null, quote_sync_state: 'unmanaged' }));
    expect(screen.queryByTestId('doc-quote')).not.toBeInTheDocument();
  });
});
