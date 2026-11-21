/** The action footer of an opened quote: email, refuse, reopen, accept, create order. Each writes to Zoho Books. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../../mocks/server';
import type { QuoteRow, QuoteState } from '../../../api/client';

const auth = { hasPermission: vi.fn((_p: string) => true) };
vi.mock('../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => ({ ...actual.useAuth(), hasPermission: auth.hasPermission }) };
});

import { render } from '../../utils';
import { QuotesView } from '../../../components/orders/QuotesView';

afterEach(() => {
  server.resetHandlers();
  auth.hasPermission.mockImplementation(() => true);
});

const quote = (o: Partial<QuoteRow> = {}): QuoteRow => ({
  id: 'e1', number: 'DEV-00412', customer: 'Nautic Service', customer_id: '', date: '2026-11-10', expiry_date: '2026-12-10',
  state: 'sent', total: 248900, currency: 'XPF', reference: '', age_days: 2, is_core: true, editable: true,
  has_draft_order: false, modified: '', lines: [], ...o,
});
const list = (state: QuoteState, more: QuoteRow[] = []) => ({ rows: [quote({ state }), ...more], loading: 0, ready: true });
const OTHER = quote({ id: 'e2', number: 'DEV-00414', customer: 'Marc Le Goff', state: 'draft' });
const BOARD = { rows: [], computed_at: null, stock_loaded_at: null, sync: { enabled: true, configured: true, running: false, pending: 0, last_error: null, last_error_at: null, last_success_at: null } };

const serve = (state: QuoteState) => {
  server.use(
    http.get('/api/v1/order-board/quotes', () => HttpResponse.json(list(state, [OTHER]))),
    http.get('/api/v1/order-board/quotes/:id/events', () => HttpResponse.json({ events: [], has_more: false })),
  );
};
const footer = async () => within(await screen.findByTestId('quote-actions'));
const show = (props: Partial<Parameters<typeof QuotesView>[0]> = {}) =>
  render(<QuotesView coreOnly={false} openId="e1" onToggle={vi.fn()} {...props} />);

describe('Quote actions', () => {
  it.each([
    ['draft', ['Send by email', 'Declined', 'Accepted']],
    ['sent', ['Send by email', 'Declined', 'Accepted']],
    ['expired', ['Send by email', 'Declined', 'Accepted']],
    ['accepted', ['Declined', 'Create order']],
    ['declined', ['Reopen']],
  ] as const)('a %s quote offers %j', async (state, names) => {
    serve(state);
    show();
    const f = await footer();
    expect(f.getAllByRole('button').map(b => b.textContent?.trim())).toEqual(names);
  });

  it('shows no action button without orders:update', async () => {
    auth.hasPermission.mockImplementation(p => p !== 'orders:update');
    serve('sent');
    show();
    expect(await screen.findByText('Nautic Service')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-actions')).not.toBeInTheDocument();
  });

  it('Declined then Reopen round-trip moves the quote between the chips, from the returned lists', async () => {
    const user = userEvent.setup();
    serve('sent');
    const posts: string[] = [];
    server.use(
      http.post('/api/v1/order-board/quotes/e1/decline', () => {
        posts.push('decline');
        return HttpResponse.json({ quotes: list('declined', [OTHER]), estimate_id: 'e1' });
      }),
      http.post('/api/v1/order-board/quotes/e1/reopen', () => {
        posts.push('reopen');
        return HttpResponse.json({ quotes: list('sent', [OTHER]), estimate_id: 'e1' });
      }),
    );
    show();
    expect(await screen.findByRole('button', { name: /^Current 2/ })).toBeInTheDocument();
    await user.click((await footer()).getByRole('button', { name: 'Declined' }));
    expect(await screen.findByRole('button', { name: /^Declined 1/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Current 1/ })).toBeInTheDocument();
    await user.click((await footer()).getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByRole('button', { name: /^Current 2/ })).toHaveAttribute('aria-pressed', 'true');
    expect(posts).toEqual(['decline', 'reopen']);
  });

  it('disables every button while an action runs, so a double click posts once', async () => {
    const user = userEvent.setup();
    serve('sent');
    let posts = 0;
    server.use(http.post('/api/v1/order-board/quotes/e1/decline', async () => {
      posts += 1;
      await delay(150);
      return HttpResponse.json({ quotes: list('declined', [OTHER]), estimate_id: 'e1' });
    }));
    show();
    const f = await footer();
    await user.dblClick(f.getByRole('button', { name: 'Declined' }));
    for (const b of f.getAllByRole('button')) expect(b).toBeDisabled();
    expect(await screen.findByRole('button', { name: /^Declined 1/ })).toBeInTheDocument();
    expect(posts).toBe(1);
  });

  it('Accepted hands the created order to the page', async () => {
    const user = userEvent.setup();
    serve('sent');
    server.use(http.post('/api/v1/order-board/quotes/e1/accept', () =>
      HttpResponse.json({ quotes: list('accepted', [OTHER]), board: BOARD, row: { id: 'so9', number: 'SO-00232' }, salesorder_id: 'so9' })));
    const onOrdered = vi.fn();
    show({ onOrdered });
    await user.click((await footer()).getByRole('button', { name: 'Accepted' }));
    await waitFor(() => expect(onOrdered).toHaveBeenCalledWith(expect.objectContaining({ salesorder_id: 'so9' }), 'e1'));
  });

  it('an accept that fails toasts the reason and shows the quote as the server now has it', async () => {
    const user = userEvent.setup();
    let gets = 0;
    server.use(
      http.get('/api/v1/order-board/quotes', () => HttpResponse.json(list(gets++ ? 'accepted' : 'sent', [OTHER]))),
      http.get('/api/v1/order-board/quotes/:id/events', () => HttpResponse.json({ events: [], has_more: false })),
      http.post('/api/v1/order-board/quotes/e1/accept', () => HttpResponse.json({ detail: 'create_failed' }, { status: 400 })),
    );
    const onOrdered = vi.fn();
    show({ onOrdered });
    await user.click((await footer()).getByRole('button', { name: 'Accepted' }));
    expect(await screen.findByText('Quote action failed: Zoho Books did not confirm the order, nothing was created')).toBeInTheDocument();
    expect(await (await footer()).findByRole('button', { name: 'Create order' })).toBeInTheDocument();
    expect(onOrdered).not.toHaveBeenCalled();
  });

  it('a 409 says another action on this quote is running', async () => {
    const user = userEvent.setup();
    serve('accepted');
    server.use(http.post('/api/v1/order-board/quotes/e1/order', () => HttpResponse.json({ detail: 'busy' }, { status: 409 })));
    show();
    await user.click((await footer()).getByRole('button', { name: 'Create order' }));
    expect(await screen.findByText('Quote action failed: another action on this quote is still running')).toBeInTheDocument();
  });

  it('Send by email sends through the quote endpoint and the pill becomes Sent from the returned list', async () => {
    const user = userEvent.setup();
    serve('draft');
    const posted: unknown[] = [];
    server.use(
      http.get('/api/v1/order-board/quotes/e1/email', () => HttpResponse.json({
        subject: 'Devis', body: '<p>Bonjour</p>', recipients: [{ email: 'yann@client.pf', name: 'Yann', contact_person_id: 'cp1' }],
        default_email: 'yann@client.pf', document_id: 'e1', document_number: 'DEV-00412',
      })),
      http.post('/api/v1/order-board/quotes/e1/email', async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ quotes: list('sent', [OTHER]), estimate_id: 'e1' });
      }),
    );
    show();
    const row = (await screen.findByText('Nautic Service')).closest('button')!;
    expect(row).toHaveTextContent('Draft');
    await user.click((await footer()).getByRole('button', { name: 'Send by email' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send quote by email' });
    await waitFor(() => expect(within(dialog).getByRole('combobox')).toHaveValue('yann@client.pf'));
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posted).toEqual([{ to: 'yann@client.pf' }]));
    await waitFor(() => expect(row).toHaveTextContent('Sent'));
  });
});
