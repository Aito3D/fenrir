import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ImportQuoteModal } from '../../components/aito/ImportQuoteModal';
import type { ZohoQuotePreview } from '../../api/client';

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
  description: '',
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
  },
  client: { id: 'c2', name: 'Marie EXEMPLE', phone: '87123456', email: null, is_company: false },
  suggested_description: 'Helice grise\nhelice',
  tasks: [
    { ...emptyTask, title: 'Helice grise', description: 'Matériau: PETG', modelisation_cost: 3000, impression_cost: 2400 },
    { ...emptyTask, title: 'helice', impression_cost: 200 },
  ],
  skipped_lines: [],
  existing_project_id: null,
};

const respondWith = (body: ZohoQuotePreview) => {
  server.use(
    http.get('/api/v1/zoho/estimates', () => HttpResponse.json([summary])),
    http.get('/api/v1/zoho/estimates/:id/preview', () => HttpResponse.json(body)),
  );
};

const pickTheQuote = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByText('DEV26-2462'));
};

beforeEach(() => respondWith(preview));

describe('ImportQuoteModal', () => {
  it('shows the parsed tasks and pre-fills the description', async () => {
    const user = userEvent.setup();
    render(<ImportQuoteModal onClose={vi.fn()} onImport={vi.fn()} />);
    await pickTheQuote(user);

    expect(await screen.findByText('Helice grise')).toBeInTheDocument();
    expect(screen.getByText('helice')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /description/i })).toHaveValue('Helice grise\nhelice');
  });

  it('submits the edited description together with the preview', async () => {
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<ImportQuoteModal onClose={vi.fn()} onImport={onImport} />);
    await pickTheQuote(user);

    const description = await screen.findByRole('textbox', { name: /description/i });
    await user.clear(description);
    await user.type(description, 'Hélices de rechange');
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    expect(onImport).toHaveBeenCalledWith({
      description: 'Hélices de rechange',
      preview: expect.objectContaining({ quote: expect.objectContaining({ number: 'DEV26-2462' }) }),
    });
  });

  it('blocks import when the quote has no service lines', async () => {
    respondWith({ ...preview, tasks: [], suggested_description: 'DEV26-2462' });
    const user = userEvent.setup();
    render(<ImportQuoteModal onClose={vi.fn()} onImport={vi.fn()} />);
    await pickTheQuote(user);

    expect(await screen.findByText(/no AITO 3D service lines/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^import$/i })).toBeDisabled();
  });

  it('warns about a quote that was already imported but still allows it', async () => {
    respondWith({ ...preview, existing_project_id: 42 });
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<ImportQuoteModal onClose={vi.fn()} onImport={onImport} />);
    await pickTheQuote(user);

    expect(await screen.findByText(/already imported as project #42/i)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /import again/i });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it('lists lines that will not be imported', async () => {
    respondWith({
      ...preview,
      skipped_lines: [{ sku: 'L3DIMP', name: 'Découpe et Gravure Laser', amount: 8000 }],
    });
    const user = userEvent.setup();
    render(<ImportQuoteModal onClose={vi.fn()} onImport={vi.fn()} />);
    await pickTheQuote(user);

    expect(await screen.findByText(/Découpe et Gravure Laser/)).toBeInTheDocument();
  });

  it('reports a preview that could not be loaded', async () => {
    server.use(
      http.get('/api/v1/zoho/estimates', () => HttpResponse.json([summary])),
      http.get('/api/v1/zoho/estimates/:id/preview', () => new HttpResponse(null, { status: 502 })),
    );
    const user = userEvent.setup();
    render(<ImportQuoteModal onClose={vi.fn()} onImport={vi.fn()} />);
    await pickTheQuote(user);

    expect(await screen.findByText(/could not load this quote/i)).toBeInTheDocument();
  });

  it('does not show the spinner over the error message when a preview fails to load', async () => {
    // TanStack Query v5 keeps isError true while a query is settled in error state.
    // The spinner's condition must exclude isError so it does not render on top of
    // the error message, which would be confusing to the user.
    server.use(
      http.get('/api/v1/zoho/estimates', () => HttpResponse.json([summary])),
      http.get('/api/v1/zoho/estimates/:id/preview', () => new HttpResponse(null, { status: 502 })),
    );
    const user = userEvent.setup();
    render(<ImportQuoteModal onClose={vi.fn()} onImport={vi.fn()} />);
    await pickTheQuote(user);

    await screen.findByText(/could not load this quote/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the not-configured state instead of the combobox when Zoho is not set up', async () => {
    server.use(
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({
          configured: false,
          reachable: false,
          default_contact_id: '',
          default_contact_name: '',
        }),
      ),
    );
    render(<ImportQuoteModal onClose={vi.fn()} onImport={vi.fn()} />);

    expect(await screen.findByRole('link')).toHaveAttribute('href', '/settings?tab=zoho');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^import$/i })).toBeDisabled();
  });

  it('shows nothing before a quote is picked and a spinner while the preview loads', async () => {
    // The dialog holds its full height either way (the quote dropdown needs
    // room to open below the input), so the empty area is genuinely empty
    // until there is something real to put in it.
    let releasePreview: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    server.use(
      http.get('/api/v1/zoho/estimates', () => HttpResponse.json([summary])),
      http.get('/api/v1/zoho/estimates/:id/preview', async () => {
        await held;
        return HttpResponse.json(preview);
      }),
    );

    const user = userEvent.setup();
    render(<ImportQuoteModal onClose={vi.fn()} onImport={vi.fn()} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await pickTheQuote(user);
    expect(await screen.findByRole('status')).toBeInTheDocument();

    releasePreview();
    expect(await screen.findByText('Helice grise')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
