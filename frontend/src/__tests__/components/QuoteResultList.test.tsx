import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { QuoteResultList } from '../../components/aito/QuoteResultList';
import type { ZohoEstimateSummary } from '../../api/client';

const quotes: ZohoEstimateSummary[] = [
  { id: 'e1', number: 'DEV26-2461', customer_name: 'ACME SARL', date: '2026-07-30', total: 45000, currency_code: 'XPF', status: 'accepted' },
  { id: 'e2', number: 'DEV26-2462', customer_name: 'Marie EXEMPLE', date: '2026-07-27', total: 5600, currency_code: 'XPF', status: 'draft' },
];

let searchCalls: string[];

beforeEach(() => {
  searchCalls = [];
  server.use(
    http.get('/api/v1/zoho/estimates', ({ request }) => {
      const q = new URL(request.url).searchParams.get('q') ?? '';
      searchCalls.push(q);
      return HttpResponse.json(q ? quotes.filter((x) => x.number.includes(q)) : quotes);
    }),
    http.get('/api/v1/zoho/estimates/:id/preview', () => HttpResponse.json({})),
    http.get('/api/v1/aito/', () => HttpResponse.json([])),
  );
});

describe('QuoteResultList', () => {
  it('lists recent quotes before anything is typed', async () => {
    render(<QuoteResultList selected={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    expect(await screen.findByText('DEV26-2461')).toBeInTheDocument();
    expect(screen.getByText('DEV26-2462')).toBeInTheDocument();
    expect(screen.getByText(/recent quotes/i)).toBeInTheDocument();
  });

  it('debounces typing into a single filtered search', async () => {
    const user = userEvent.setup();
    render(<QuoteResultList selected={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    await screen.findByText('DEV26-2461');

    await user.type(screen.getByRole('searchbox'), '2462');
    await waitFor(() => expect(screen.queryByText('DEV26-2461')).not.toBeInTheDocument());
    expect(screen.getByText('DEV26-2462')).toBeInTheDocument();
    // One empty-q fetch on mount plus one for the settled term — not one per keystroke.
    expect(searchCalls).toEqual(['', '2462']);
  });

  it('selects with arrow keys + Enter from the search input', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<QuoteResultList selected={null} onSelect={onSelect} onClear={vi.fn()} />);
    await screen.findByText('DEV26-2461');

    await user.click(screen.getByRole('searchbox'));
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'e2' }));
  });

  it('marks a quote the board already imported, but still allows selecting it', async () => {
    server.use(
      http.get('/api/v1/aito/', () =>
        HttpResponse.json([{ id: 87, quote_id: 'e1', status: 'active' }]),
      ),
    );
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<QuoteResultList selected={null} onSelect={onSelect} onClear={vi.fn()} />);

    expect(await screen.findByText(/imported → #87/i)).toBeInTheDocument();
    await user.click(screen.getByText('DEV26-2461'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }));
  });

  it('collapses to the selected card and Change hands control back', async () => {
    const onClear = vi.fn();
    render(<QuoteResultList selected={quotes[0]} onSelect={vi.fn()} onClear={onClear} />);

    expect(screen.getByText(/DEV26-2461/)).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /change/i }));
    expect(onClear).toHaveBeenCalled();
  });

  it('prefetches the preview when a row is hovered', async () => {
    let prefetched = 0;
    server.use(
      http.get('/api/v1/zoho/estimates/:id/preview', () => {
        prefetched += 1;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    render(<QuoteResultList selected={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    await user.hover(await screen.findByText('DEV26-2461'));
    await waitFor(() => expect(prefetched).toBe(1));
  });
});
