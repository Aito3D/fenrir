import type { FormEvent } from 'react';
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

  it('marks a quote that already has a project and refuses to pick it', async () => {
    // The board's own query key, seeded via the same HTTP endpoint the
    // combobox's ['aito-projects'] query fetches — no default handler exists
    // for it, so this test supplies one (mirrors ProjectDetailPanel.test.tsx's
    // BoardHost, which primes the same query key the same way).
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json([{ id: 1, quote_id: 'e1' }])));

    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<QuoteCombobox selected={null} onSelect={onSelect} />);
    const combobox = screen.getByRole('combobox');
    await user.click(combobox);

    const imported = await screen.findByRole('option', { name: /DEV26-2467/ });
    expect(imported).toHaveTextContent(/already imported/i);
    // aria-disabled, not the native `disabled` attribute (jest-dom's
    // toBeDisabled only looks at the native attribute) — a native disabled
    // button never dispatches mousedown, which would let a click blur past
    // the listbox's onMouseDown preventDefault and close the dropdown (B-1).
    expect(imported).toHaveAttribute('aria-disabled', 'true');
    await user.click(imported);
    expect(onSelect).not.toHaveBeenCalled();
    // Regression guard for B-1: clicking the disabled option must not steal
    // focus from the input. If it did, the dropdown would become stuck open
    // with nothing left able to close it (blur only fires from the input).
    expect(combobox).toHaveFocus();
    expect(combobox).toHaveAttribute('aria-expanded', 'true');

    await user.click(await screen.findByRole('option', { name: /DEV26-2461/ }));
    expect(onSelect).toHaveBeenCalled();
  });

  it('does not select or submit an enclosing form when Enter is pressed on an already-imported option (B-2)', async () => {
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json([{ id: 1, quote_id: 'e1' }])));

    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <QuoteCombobox selected={null} onSelect={onSelect} />
        <button type="submit">Import</button>
      </form>,
    );
    const combobox = screen.getByRole('combobox');
    await user.click(combobox);
    await screen.findByRole('option', { name: /DEV26-2467/ });

    // Arrow onto the already-imported option (DEV26-2467 is listed first).
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(onSelect).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    // The dropdown must still be open — Enter on a blocked option should be
    // a no-op, not an implicit close either.
    expect(combobox).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the quote date in the shop\'s own timezone, not shifted a day early by UTC parsing', async () => {
    // French Polynesia is UTC-10. `new Date('2026-07-27')` parses as UTC
    // midnight, which is still July 26 locally — the bug. Parsing as local
    // midnight (`new Date('2026-07-27T00:00:00')`) is the fix under test.
    vi.stubEnv('TZ', 'Pacific/Tahiti');
    try {
      const buggyRendering = new Date('2026-07-27').toLocaleDateString('en');
      const fixedRendering = new Date('2026-07-27T00:00:00').toLocaleDateString('en');
      expect(fixedRendering).not.toBe(buggyRendering); // sanity: the two must actually differ here

      const user = userEvent.setup();
      render(<QuoteCombobox selected={null} onSelect={vi.fn()} />);
      await user.click(screen.getByRole('combobox'));
      const row = (await screen.findByText('DEV26-2461')).closest('button')!;
      expect(row).toHaveTextContent(fixedRendering);
      expect(row).not.toHaveTextContent(buggyRendering);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
