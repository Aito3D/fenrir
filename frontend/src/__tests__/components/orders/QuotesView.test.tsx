/** The Devis side of the Order Board: chips, search, loading line and rows. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import type { QuoteLine, QuoteRow, QuotesResponse } from '../../../api/client';
import { render } from '../../utils';
import { QuotesView } from '../../../components/orders/QuotesView';

afterEach(() => server.resetHandlers());

const qline = (o: Partial<QuoteLine> = {}): QuoteLine => ({
  id: 'ql1', item_id: 'A', name: 'PLA Basic Noir', sku: 'PLA-BK', quantity: 4, rate: 2500, discount: null, total: 10000, available: 14, ...o,
});
const quote = (o: Partial<QuoteRow> = {}): QuoteRow => ({
  id: 'e1', number: 'DEV-00412', customer: 'Nautic Service', customer_id: 'c1', date: '2026-11-10', expiry_date: '2026-12-10',
  state: 'sent', total: 248900, currency: 'XPF', reference: '', age_days: 2, is_core: true, editable: true,
  has_draft_order: false, modified: '', lines: [qline()], ...o,
});
const ROWS = [
  quote(),
  quote({ id: 'e2', number: 'DEV-00414', customer: 'Marc Le Goff', state: 'draft', lines: [qline({ name: 'AMS 2 Pro', quantity: 1 })] }),
  quote({ id: 'e3', number: 'DEV-00398', customer: 'Lycée Vauban', state: 'expired' }),
  quote({ id: 'e4', number: 'DEV-00390', customer: 'Voilerie Iroise', state: 'declined' }),
];
const serve = (o: Partial<QuotesResponse> = {}) =>
  server.use(http.get('/api/v1/order-board/quotes', () => HttpResponse.json({ rows: ROWS, loading: 0, ready: true, ...o })));

const show = (props: Partial<Parameters<typeof QuotesView>[0]> = {}) =>
  render(<QuotesView coreOnly={false} openId={null} onToggle={vi.fn()} {...props} />);

describe('QuotesView', () => {
  it('lists only draft, sent and accepted quotes by default, with the chip counts', async () => {
    serve();
    show();
    expect(await screen.findByText('Nautic Service')).toBeInTheDocument();
    expect(screen.getByText('Marc Le Goff')).toBeInTheDocument();
    expect(screen.queryByText('Lycée Vauban')).not.toBeInTheDocument();
    expect(screen.queryByText('Voilerie Iroise')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Current 2/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Expired 1/ })).toBeInTheDocument();
  });

  it('lists the expired quotes under their chip', async () => {
    const user = userEvent.setup();
    serve();
    show();
    await user.click(await screen.findByRole('button', { name: /^Expired 1/ }));
    expect(screen.getByText('Lycée Vauban')).toBeInTheDocument();
    expect(screen.queryByText('Nautic Service')).not.toBeInTheDocument();
  });

  it('narrows the list with the search', async () => {
    const user = userEvent.setup();
    serve();
    show();
    await user.type(await screen.findByRole('searchbox'), 'ams');
    expect(screen.getByText('Marc Le Goff')).toBeInTheDocument();
    expect(screen.queryByText('Nautic Service')).not.toBeInTheDocument();
  });

  it('says how many quotes are still loading', async () => {
    serve({ loading: 7 });
    show();
    expect(await screen.findByText('Loading quotes… 7 remaining')).toBeInTheDocument();
  });

  it('the loading line folds away, then goes, once the quotes are all read', async () => {
    serve({ loading: 7 });
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><QuotesView coreOnly={false} openId={null} onToggle={vi.fn()} /></QueryClientProvider>);
    const line = await screen.findByText('Loading quotes… 7 remaining');
    serve();
    void client.invalidateQueries();
    await waitFor(() => expect(line.parentElement).toHaveAttribute('data-leaving'));
    await waitFor(() => expect(line).not.toBeInTheDocument());
  });

  it('renders a row whose lines are not read yet without a summary', async () => {
    serve({ rows: [quote({ lines: null })] });
    show();
    const row = (await screen.findByText('Nautic Service')).closest('button')!;
    expect(row).toHaveTextContent('DEV-00412');
    expect(row).not.toHaveTextContent('PLA Basic Noir');
  });

  it('summarises the first line and counts the rest', async () => {
    serve({ rows: [quote({ lines: [qline(), qline({ id: 'b', name: 'Buse 0,6', quantity: 2 }), qline({ id: 'c', name: 'Plateau PEI' })] })] });
    show();
    const row = (await screen.findByText('Nautic Service')).closest('button')!;
    expect(within(row).getByText('4× PLA Basic Noir · +2')).toBeInTheDocument();
  });

  it('shows the per-chip empty state', async () => {
    const user = userEvent.setup();
    serve({ rows: [quote()] });
    show();
    await user.click(await screen.findByRole('button', { name: /^Declined 0/ }));
    expect(screen.getByText('No declined quotes.')).toBeInTheDocument();
  });

  it('switches to the chip of a quote opened by a link', async () => {
    serve();
    show({ openId: 'e3' });
    expect(await screen.findByText('Lycée Vauban')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Expired 1/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
