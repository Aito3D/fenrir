import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { NewProjectModal } from '../../components/aito/NewProjectModal';

const DEFAULT_ID = '66407000001237340';

// The modal now renders TaskEditor unconditionally under the description
// field, and every TaskRow renders ImpressionFields, which always queries
// these three endpoints regardless of whether a test touches Impression3D.
// Mocked globally (mirrors TaskEditor.test.tsx) so every test in this file
// gets deterministic, non-empty option lists instead of racing an unhandled
// request.
const mockFilaments = [
  {
    id: 1,
    name: 'Sunlu PA6-CF',
    brand: 'Sunlu',
    material: 'PA6-CF',
    cost_per_kg: 3731,
    sale_price_per_kg: 5597,
    difficulty_pct: 150,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const mockPrinters = [
  {
    id: 1,
    name: 'H2S',
    purchase_price: 347000,
    lifetime_years: 2,
    daily_usage_hours: 5,
    power_watts: 400,
    repair_rate_pct: 30,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const mockDefaults = {
  id: 1,
  electricity_tariff: 120,
  labor_rate_per_hour: 3000,
  consumables_packaging_flat: 30,
  failure_rate_pct: 30,
  prototype_rate_pct: 30,
  ads_rate_pct: 5,
  filament_markup_pct: 5,
  global_markup_pct: 50,
  tax_pct: 13,
  default_difficulty_pct: 100,
  default_margin_over_cost_pct: 50,
  stuff_markup_pct: 20,
  updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({
        configured: true, reachable: true,
        default_contact_id: DEFAULT_ID, default_contact_name: 'Client de passage',
      }),
    ),
    http.get('/api/v1/zoho/contacts', () => HttpResponse.json([])),
    http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(mockFilaments)),
    http.get('/api/v1/calculator/printers/', () => HttpResponse.json(mockPrinters)),
    http.get('/api/v1/calculator/defaults', () => HttpResponse.json(mockDefaults)),
  );
});

describe('NewProjectModal', () => {
  it('opens with the default client preselected and submits it', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectModal onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /client/i })).toHaveValue('Client de passage'),
    );
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');
    await user.click(screen.getByRole('button', { name: /create project/i }));
    expect(onCreate).toHaveBeenCalledWith(
      'Support de caméra',
      expect.objectContaining({ id: DEFAULT_ID, isDefault: true }),
      [],
    );
  });

  it('adds a task and includes its Scan3D cost in the tasks array passed to onCreate', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectModal onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /client/i })).toHaveValue('Client de passage'),
    );
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');

    await user.click(screen.getByRole('button', { name: /add task/i }));
    fireEvent.change(screen.getByLabelText('Scan3D'), { target: { value: '42' } });

    await user.click(screen.getByRole('button', { name: /create project/i }));

    expect(onCreate).toHaveBeenCalledWith(
      'Support de caméra',
      expect.objectContaining({ id: DEFAULT_ID, isDefault: true }),
      [expect.objectContaining({ scanCost: 42 })],
    );
  });

  it('blocks submit on a malformed email and reveals the error', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectModal onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /client/i })).toHaveValue('Client de passage'),
    );
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');
    await user.type(screen.getByLabelText(/^email/i), 'nope');
    // Never blurred, so no message yet — and submit is not blocked by a hidden
    // error either: the spec ties blocking to a *visible* error ("showing an
    // error and then letting the submit through would make the message
    // decorative"), which cuts both ways — a hidden error must not silently
    // block submit before the field has even been left once.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create project/i })).not.toBeDisabled();

    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/valid email/i);
    expect(screen.getByRole('button', { name: /create project/i })).toBeDisabled();
    expect(onCreate).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText(/^email/i));
    await user.click(screen.getByRole('button', { name: /create project/i }));
    expect(onCreate).toHaveBeenCalled();
  });

  it('Escape from the country-code picker closes the dropdown, not the modal', async () => {
    // Regression test: PhoneInput's country-code picker is a SearchableSelect
    // that used to leave Escape propagating up to the modal's own window-level
    // handler, closing the whole modal (and discarding the typed description)
    // instead of just the dropdown.
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectModal onClose={onClose} onCreate={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /client/i })).toHaveValue('Client de passage'),
    );
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');

    const countryInput = screen.getByRole('combobox', { name: /country code/i });
    await user.click(countryInput);
    await user.type(countryInput, 'Fra');
    await user.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/product description/i)).toHaveValue('Support de caméra');
  });

  it('lets a contact with an already-malformed stored phone reach a visible error instead of a silently disabled submit', async () => {
    // Regression test for the finding that NewProjectModal computed
    // submit-ability from a synthetic fully-blurred draft: selecting a directory
    // contact whose *stored* phone was already malformed (real org data has six
    // such "other"-shaped values) disabled "Create project" the instant it was
    // selected, with no message on screen and nothing to revert, because the
    // field had never actually been blurred by the user.
    const badContact = {
      id: 'bad1', name: 'Bad Contact', company_name: '',
      customer_sub_type: 'individual',
      phone: '', mobile: '+689-876543210987654', email: 'ok@example.pf',
    };
    server.use(http.get('/api/v1/zoho/contacts', () => HttpResponse.json([badContact])));
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectModal onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /client/i })).toHaveValue('Client de passage'),
    );
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');

    const combobox = screen.getByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'Bad');
    await user.click(await screen.findByText('Bad Contact'));

    // Selecting the contact alone must never silently disable submit.
    expect(screen.getByRole('button', { name: /create project/i })).not.toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create project/i }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/4 and 14 digits/i);
  });

  it('blocks project creation while Zoho is not configured', async () => {
    // Regression test: GET /zoho/status always returns the fallback default
    // contact, even when configured is false, so the draft still seeds. Submit
    // must consult `configured` directly rather than inferring it from having a
    // default contact id.
    server.use(
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({
          configured: false, reachable: false,
          default_contact_id: DEFAULT_ID, default_contact_name: 'Client de passage',
        }),
      ),
    );
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectModal onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() => expect(screen.getByText(/isn.t connected yet/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');

    const submitButton = screen.getByRole('button', { name: /create project/i });
    expect(submitButton).toBeDisabled();
    // The Ctrl+Enter shortcut bypasses the disabled button entirely, so it must
    // be guarded independently.
    screen.getByLabelText(/product description/i).focus();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('switches to the create-client sub-step and back', async () => {
    const user = userEvent.setup();
    render(<NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />);
    const combobox = await screen.findByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'zzz');
    await user.click(await screen.findByRole('button', { name: /create new client/i }));
    expect(screen.getByLabelText(/company name/i)).toHaveValue('');
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByLabelText(/product description/i)).toBeInTheDocument();
  });

  it('Escape from the create-client sub-step steps back instead of closing the modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectModal onClose={onClose} onCreate={vi.fn()} />);
    const combobox = await screen.findByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'zzz');
    await user.click(await screen.findByRole('button', { name: /create new client/i }));
    await user.type(screen.getByLabelText(/company name/i), 'ACME Corp');
    expect(screen.getByLabelText(/company name/i)).toHaveValue('ACME Corp');

    await user.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/product description/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/company name/i)).not.toBeInTheDocument();
  });

  it('a backdrop click from the create-client sub-step steps back instead of closing the modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<NewProjectModal onClose={onClose} onCreate={vi.fn()} />);
    const combobox = await screen.findByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'zzz');
    await user.click(await screen.findByRole('button', { name: /create new client/i }));
    await user.type(screen.getByLabelText(/company name/i), 'ACME Corp');
    expect(screen.getByLabelText(/company name/i)).toHaveValue('ACME Corp');

    const backdrop = container.querySelector('.fixed.inset-0');
    if (!backdrop) throw new Error('Backdrop not found');
    fireEvent.mouseDown(backdrop);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/product description/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/company name/i)).not.toBeInTheDocument();
  });
});
