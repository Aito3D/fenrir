import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { QuoteCombobox } from '../../components/aito/QuoteCombobox';

const quotes = [
  {
    id: 'e1',
    number: 'DEV26-2467',
    customer_name: 'Test Person',
    date: '2026-07-28',
    total: 0,
    currency_code: 'XPF',
    status: 'draft',
  },
  {
    id: 'e2',
    number: 'DEV26-2461',
    customer_name: 'SARL Exemple Import',
    date: '2026-07-27',
    total: 18000,
    currency_code: 'XPF',
    status: 'sent',
  },
];

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/estimates', ({ request }) => {
      const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase();
      if (!q) return HttpResponse.json(quotes);
      return HttpResponse.json(
        quotes.filter((e) => `${e.number} ${e.customer_name}`.toLowerCase().includes(q)),
      );
    }),
  );
});

describe('QuoteCombobox', () => {
  it('lists the most recent quotes as soon as it is focused', async () => {
    const user = userEvent.setup();
    render(<QuoteCombobox selected={null} onSelect={vi.fn()} />);
    await user.click(screen.getByRole('combobox'));
    expect(await screen.findByText('DEV26-2467')).toBeInTheDocument();
    expect(screen.getByText('DEV26-2461')).toBeInTheDocument();
  });

  it('narrows the list as the user types a number', async () => {
    const user = userEvent.setup();
    render(<QuoteCombobox selected={null} onSelect={vi.fn()} />);
    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), '2461');
    expect(await screen.findByText('DEV26-2461')).toBeInTheDocument();
    expect(screen.queryByText('DEV26-2467')).not.toBeInTheDocument();
  });

  it('reports the picked quote and shows it in the input', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<QuoteCombobox selected={null} onSelect={onSelect} />);
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByText('DEV26-2461'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'e2' }));

    rerender(<QuoteCombobox selected={quotes[1]} onSelect={onSelect} />);
    expect(screen.getByRole('combobox')).toHaveValue('DEV26-2461 · SARL Exemple Import');
  });

  it('reports an unreachable Zoho instead of an empty list', async () => {
    server.use(http.get('/api/v1/zoho/estimates', () => new HttpResponse(null, { status: 502 })));
    const user = userEvent.setup();
    render(<QuoteCombobox selected={null} onSelect={vi.fn()} />);
    await user.click(screen.getByRole('combobox'));
    expect(await screen.findByText(/could not reach|zoho/i)).toBeInTheDocument();
  });
});
