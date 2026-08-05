import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ImportQuoteDrawer } from '../../components/aito/ImportQuoteDrawer';
import type { ZohoQuotePreview } from '../../api/client';

// Fixtures ported verbatim from ImportQuoteModal.test.tsx (the modal this
// drawer replaces) — same quote, same tasks, same preview shape.
const summary = {
  id: 'e2',
  number: 'DEV26-2462',
  customer_name: 'Marie EXEMPLE',
  date: '2026-07-27',
  total: 5600,
  currency_code: 'XPF',
  status: 'draft',
};

const emptyTask = {
  title: '',
  scan_cost: null,
  modelisation_cost: null,
  usinage_cost: null,
  impression_printer_id: null,
  impression_filament_id: null,
  impression_weight_g: null,
  impression_time_min: null,
  impression_quantity: null,
  impression_color: null,
  impression_cost: null,
};

const preview: ZohoQuotePreview = {
  quote: {
    id: 'e2',
    number: 'DEV26-2462',
    date: '2026-07-27',
    status: 'draft',
    total: 5600,
    currency_code: 'XPF',
    url: 'https://books.zoho.eu/app/999#/estimates/e2',
    salesperson: null,
  },
  client: { id: 'c2', name: 'Marie EXEMPLE', phone: '87123456', email: null, is_company: false },
  suggested_description: 'Helice grise\nhelice',
  tasks: [
    { ...emptyTask, title: 'Helice grise', impression_description: 'PETG noir', modelisation_cost: 3000, impression_cost: 2400 },
    { ...emptyTask, title: 'helice', impression_cost: 200 },
  ],
  skipped_lines: [],
  shipping: null,
  existing_project_id: null,
};

const respondWith = (body: ZohoQuotePreview, board: unknown[] = []) => {
  server.use(
    http.get('/api/v1/zoho/estimates', () => HttpResponse.json([summary])),
    http.get('/api/v1/zoho/estimates/:id/preview', () => HttpResponse.json(body)),
    http.get('/api/v1/aito/', () => HttpResponse.json(board)),
  );
};

const pickTheQuote = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByText('DEV26-2462'));
};

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({ configured: true, reachable: true, default_contact_id: 'c1', default_contact_name: 'Client de passage' }),
    ),
  );
  respondWith(preview);
});

describe('ImportQuoteDrawer', () => {
  it('focuses the search input on mount, not the panel', async () => {
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={vi.fn()} />);
    expect(await screen.findByRole('searchbox')).toHaveFocus();
  });

  it('shows the parsed tasks and pre-fills the description', async () => {
    const user = userEvent.setup();
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={vi.fn()} />);
    await pickTheQuote(user);

    expect(await screen.findByText('Helice grise')).toBeInTheDocument();
    expect(screen.getByText('helice')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /description/i })).toHaveValue('Helice grise\nhelice');
    expect(screen.getByText(/PETG noir/)).toBeInTheDocument();
  });

  it('submits the edited description together with the preview', async () => {
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={onImport} />);
    await pickTheQuote(user);

    const description = await screen.findByRole('textbox', { name: /description/i });
    await user.clear(description);
    await user.type(description, 'Hélices de rechange');
    await user.click(screen.getByRole('button', { name: /^import\b/i }));

    expect(onImport).toHaveBeenCalledWith({
      description: 'Hélices de rechange',
      preview: expect.objectContaining({ quote: expect.objectContaining({ number: 'DEV26-2462' }) }),
    });
  });

  it('blocks import when the quote has no service lines, and the click reveals why', async () => {
    respondWith({ ...preview, tasks: [] });
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={onImport} />);
    await pickTheQuote(user);

    const cta = await screen.findByRole('button', { name: /^import\b/i });
    expect(cta).toHaveAttribute('aria-disabled', 'true');
    await user.click(cta);
    expect(onImport).not.toHaveBeenCalled();
    expect(screen.getAllByText(/no aito 3d service lines/i).length).toBeGreaterThan(0);
  });

  it('an empty description blocks import and the click reveals the checklist miss', async () => {
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={onImport} />);
    await pickTheQuote(user);

    const description = await screen.findByRole('textbox', { name: /description/i });
    await user.clear(description);
    const cta = screen.getByRole('button', { name: /^import\b/i });
    expect(cta).toHaveAttribute('aria-disabled', 'true');
    await user.click(cta);
    expect(onImport).not.toHaveBeenCalled();
    expect(screen.getByText(/description filled in/i).closest('[data-state]')).toHaveAttribute('data-state', 'miss');
  });

  it('a quote already on the board cannot even be selected — the row is blocked', async () => {
    // The backend enforces this with a 409 (_reject_duplicate_quote); the
    // picker blocks it up front so the user is not led through the whole
    // preview flow toward a submit that can only fail.
    respondWith({ ...preview, existing_project_id: 42 }, [{ id: 42, quote_id: 'e2', status: 'active' }]);
    const user = userEvent.setup();
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={vi.fn()} />);

    // The chip marks the row before anything is clicked...
    expect(await screen.findByText(/imported → #42/i)).toBeInTheDocument();
    const row = screen.getByRole('option', { name: /DEV26-2462/i });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    // ...and clicking it selects nothing: the picker stays in list mode (no
    // "Change" card) and no preview tasks ever load.
    await user.click(row);
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Helice grise')).not.toBeInTheDocument();
  });

  it('blocks import when the preview reports the quote is already on the board', async () => {
    // The board list can be stale (the row not yet marked), so the drawer's
    // own gate must hold on the preview's existing_project_id alone.
    respondWith({ ...preview, existing_project_id: 42 }, []);
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={onImport} />);
    await pickTheQuote(user);

    const cta = await screen.findByRole('button', { name: /^import\b/i });
    expect(cta).toHaveAttribute('aria-disabled', 'true');
    await user.click(cta);
    expect(onImport).not.toHaveBeenCalled();
    expect(screen.getAllByText(/already imported as project #42/i).length).toBeGreaterThan(0);
  });

  it('lists skipped lines inside the receipt with the totals row', async () => {
    respondWith({
      ...preview,
      skipped_lines: [{ sku: 'SHIP', name: 'Livraison', amount: 500 }],
    });
    const user = userEvent.setup();
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={vi.fn()} />);
    await pickTheQuote(user);

    expect(await screen.findByText(/livraison/i)).toBeInTheDocument();
    expect(screen.getByTestId('import-receipt-totals')).toBeInTheDocument();
  });

  it('discounts the impression line in the receipt total', async () => {
    // impression_cost arrives PRE-discount (aito_quote_import._build_task
    // adopts the percent separately), so a 10 %-discounted 2 400 line is
    // quoted at 2 160 — 3 000 + 2 160 + 200 = 5 360, not 5 600.
    respondWith({
      ...preview,
      quote: { ...preview.quote, total: 5360 },
      tasks: [
        { ...preview.tasks[0], impression_discount_pct: 10 },
        preview.tasks[1],
      ],
    });
    const user = userEvent.setup();
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={vi.fn()} />);
    await pickTheQuote(user);

    const totals = await screen.findByTestId('import-receipt-totals');
    await waitFor(() => expect(totals.textContent?.replace(/\s/g, ' ')).toContain('5 360'));
  });

  it('counts the shipping line toward the project total, as the quote does', async () => {
    // build_line_items puts the freight on the estimate, so quote.total
    // includes it. Without it the receipt reported a project total that
    // disagreed with the quote on every shipped import.
    respondWith({
      ...preview,
      quote: { ...preview.quote, total: 8600 },
      shipping: { island: 'raiatea', service: 'group_a', first_name: 'Marie', last_name: 'EXEMPLE', phone: '+689-87123456', price: 3000 },
    });
    const user = userEvent.setup();
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={vi.fn()} />);
    await pickTheQuote(user);

    const totals = await screen.findByTestId('import-receipt-totals');
    await waitFor(() => expect(totals.textContent?.replace(/\s/g, ' ')).toContain('8 600'));
  });

  it('stays quiet about totals when the project matches the quote', async () => {
    // The mismatch caption used to fire on every discounted or shipped quote,
    // reporting a disagreement the import had not actually introduced.
    respondWith({
      ...preview,
      quote: { ...preview.quote, total: 8600 },
      shipping: { island: 'raiatea', service: 'group_a', first_name: 'Marie', last_name: 'EXEMPLE', phone: '+689-87123456', price: 3000 },
    });
    const user = userEvent.setup();
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={vi.fn()} />);
    await pickTheQuote(user);

    await screen.findByTestId('import-receipt-totals');
    expect(screen.queryByTestId('import-total-mismatch')).not.toBeInTheDocument();
  });

  it('reports a preview that could not be loaded', async () => {
    server.use(http.get('/api/v1/zoho/estimates/:id/preview', () => HttpResponse.json({ detail: 'x' }, { status: 502 })));
    const user = userEvent.setup();
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={vi.fn()} />);
    await pickTheQuote(user);
    expect(await screen.findByText(/could not load this quote/i)).toBeInTheDocument();
  });

  it('Change returns to the list with the search text intact', async () => {
    const user = userEvent.setup();
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={vi.fn()} />);
    await user.type(await screen.findByRole('searchbox'), '2462');
    await pickTheQuote(user);
    await screen.findByRole('textbox', { name: /description/i });

    await user.click(screen.getByRole('button', { name: /change/i }));
    expect(await screen.findByRole('searchbox')).toHaveValue('2462');
  });

  it('✕ plays the drawer exit, then calls onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ImportQuoteDrawer onClose={onClose} onImport={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveClass('animate-drawer-out');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows the not-configured state instead of the list when Zoho is not set up', async () => {
    server.use(
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({ configured: false, reachable: false, default_contact_id: '', default_contact_name: '' }),
      ),
    );
    render(<ImportQuoteDrawer onClose={vi.fn()} onImport={vi.fn()} />);
    expect(await screen.findByText(/isn’t connected yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /connect zoho books/i })).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });
});
