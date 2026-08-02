import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { NewProjectDrawer } from '../../components/aito/NewProjectDrawer';
import { api } from '../../api/client';
import { defaultClientDraft } from '../../utils/clientDraft';
import { emptyTaskDraft } from '../../utils/taskDraft';

const DEFAULT_ID = '66407000001237340';

// Ported from NewProjectModal.test.tsx: the drawer renders TaskEditor
// unconditionally, and every TaskRow's edit form mounts ImpressionFields,
// which queries these three endpoints regardless of whether a test touches
// Impression3D. Mocked here (mirrors TaskEditor.test.tsx) so every test gets
// deterministic option lists instead of racing an unhandled request.
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

// Same module mock AiSummaryPanel.test.tsx uses: everything else on `api`
// stays real (and goes through MSW), only the OpenRouter round trip is a spy
// so call COUNTS are assertable.
vi.mock('../../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../api/client')>();
  return { ...mod, api: { ...mod.api, summarizeAitoProject: vi.fn() } };
});

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
  vi.mocked(api.summarizeAitoProject).mockResolvedValue({
    summary: 'Résumé IA.',
    model: 'mistralai/mistral-small',
  });
});

// Reset on the trailing edge, not before a render — see AiSummaryPanel.test.tsx
// for the Vitest false "unhandled rejection" this ordering avoids.
afterEach(() => vi.mocked(api.summarizeAitoProject).mockReset());

/** Mounts the drawer and waits for the Zoho default contact to seed the draft
 *  (the rail's client line is the first place it shows — the Client section
 *  starts collapsed). */
async function renderDrawer(overrides: { onClose?: () => void; onCreate?: () => void } = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const onCreate = overrides.onCreate ?? vi.fn();
  const view = render(<NewProjectDrawer onClose={onClose} onCreate={onCreate} />);
  await screen.findByText(/Client account — Client de passage/);
  return { ...view, onClose, onCreate };
}

const workHeader = () => screen.getByTestId('drawer-section-work');
const clientHeader = () => screen.getByTestId('drawer-section-client');
const createButton = () => screen.getByRole('button', { name: /Create Project/i });
// Scoped to the rail's checklist: the Client section header carries the same
// "needs a phone or an email" hint, so an unscoped query matches twice.
const checklistLine = (text: string | RegExp) =>
  within(screen.getByTestId('drawer-checklist')).getByText(text).closest('[data-state]') as HTMLElement;

describe('NewProjectDrawer', () => {
  it('renders work-first sections and no Cancel button', async () => {
    await renderDrawer();

    const work = workHeader();
    const client = clientHeader();
    expect(work).toHaveTextContent('The work');
    expect(client).toHaveTextContent('Client');
    // The work comes first in the DOM, and starts open; the client is closed.
    expect(work.compareDocumentPosition(client) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(work).toHaveAttribute('aria-expanded', 'true');
    expect(client).toHaveAttribute('aria-expanded', 'false');

    // The draft persists, so there is nothing to cancel — only ✕, reset and create.
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset draft/i })).toBeInTheDocument();
  });

  it('create disabled until priced task AND reachable client', async () => {
    const user = userEvent.setup();
    await renderDrawer();

    expect(createButton()).toHaveAttribute('aria-disabled', 'true');

    // Pricing the seeded task satisfies the sub-task rule but not reachability.
    await user.click(screen.getByRole('button', { name: 'Add Scan' }));
    fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '10' } });
    expect(createButton()).toHaveAttribute('aria-disabled', 'true');

    await user.click(clientHeader());
    await user.type(screen.getByLabelText(/^phone$/i), '87123456');
    await waitFor(() => expect(createButton()).toHaveAttribute('aria-disabled', 'false'));
  });

  it('checklist names an unpriced task only after leaving its card', async () => {
    const user = userEvent.setup();
    await renderDrawer();

    await user.type(screen.getByLabelText('Optional title'), 'Support antenne');
    // Still inside the card — the rule is pending, never accusatory mid-typing.
    expect(checklistLine('Each task needs at least one priced sub-task')).toHaveAttribute('data-state', 'wait');

    // Clicking the (non-focusable) drawer title takes focus out of the card.
    await user.click(screen.getByRole('heading', { name: 'New Project' }));

    expect(checklistLine('"Support antenne" needs at least one priced sub-task')).toHaveAttribute(
      'data-state',
      'miss',
    );
  });

  it('opening Client triggers exactly one summarize call per signature', async () => {
    const user = userEvent.setup();
    await renderDrawer();

    await user.click(clientHeader());
    await waitFor(() => expect(api.summarizeAitoProject).toHaveBeenCalledTimes(1));

    // Closing and reopening with the same tasks must not spend another call.
    await user.click(clientHeader());
    await user.click(clientHeader());
    expect(api.summarizeAitoProject).toHaveBeenCalledTimes(1);

    // Changing what the summary describes makes the signature stale. Enabling
    // the chip alone does not: `tasksSignature` reads the cost fields, and a
    // chip only reveals the input (the cost stays null until it is typed).
    await user.click(screen.getByRole('button', { name: 'Add Scan' }));
    fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '10' } });
    await user.click(clientHeader());
    await user.click(clientHeader());
    await waitFor(() => expect(api.summarizeAitoProject).toHaveBeenCalledTimes(2));
  });

  it('hand-edited summary survives reopening Client', async () => {
    const user = userEvent.setup();
    await renderDrawer();

    await user.click(clientHeader());
    await waitFor(() => expect(screen.getByLabelText('Project summary')).toHaveValue('Résumé IA.'));

    const textarea = screen.getByLabelText('Project summary');
    await user.clear(textarea);
    await user.type(textarea, 'Écrit à la main.');

    // A real signature change (a priced service), so only the edited latch can
    // be what holds the regeneration back.
    await user.click(screen.getByRole('button', { name: 'Add Scan' }));
    fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '10' } });
    await user.click(clientHeader());
    await user.click(clientHeader());

    expect(api.summarizeAitoProject).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Project summary')).toHaveValue('Écrit à la main.');
  });

  it('phone-only shows the missing-email warning', async () => {
    const user = userEvent.setup();
    await renderDrawer();

    await user.click(clientHeader());
    expect(screen.queryByText(/No email/)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/^phone$/i), '87123456');
    expect(screen.getByText(/No email/)).toBeInTheDocument();
    expect(screen.queryByText(/No phone/)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/^email/i), 'client@example.pf');
    expect(screen.queryByText(/No email/)).not.toBeInTheDocument();
  });

  it('clicking disabled Create reveals all pending errors', async () => {
    const user = userEvent.setup();
    const { onCreate } = await renderDrawer();

    expect(checklistLine('Each task needs at least one priced sub-task')).toHaveAttribute('data-state', 'wait');
    expect(checklistLine('Client needs a phone or an email')).toHaveAttribute('data-state', 'wait');

    await user.click(createButton());

    expect(onCreate).not.toHaveBeenCalled();
    expect(checklistLine('"Task 1" needs at least one priced sub-task')).toHaveAttribute('data-state', 'miss');
    expect(checklistLine('Client needs a phone or an email')).toHaveAttribute('data-state', 'miss');
  });

  it('draft round-trips through localStorage across unmount/remount', async () => {
    const user = userEvent.setup();
    const { unmount } = await renderDrawer();

    await user.type(screen.getByLabelText('Optional title'), 'Capot moteur');
    await waitFor(() =>
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'aito.newProjectDraft.v1',
        expect.stringContaining('Capot moteur'),
      ),
    );
    unmount();

    render(<NewProjectDrawer onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(await screen.findByDisplayValue('Capot moteur')).toBeInTheDocument();
  });

  it('opens the create-client form inline, and Escape steps back instead of closing', async () => {
    const user = userEvent.setup();
    const { onClose } = await renderDrawer();

    await user.click(clientHeader());
    const combobox = await screen.findByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'zzz');
    await user.click(await screen.findByRole('button', { name: /create new client/i }));

    // In place of ClientSection, inside the client section — not a whole-drawer swap.
    expect(screen.getByLabelText(/company name/i)).toHaveValue('');
    expect(screen.queryByRole('combobox', { name: /client/i })).not.toBeInTheDocument();
    expect(clientHeader()).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByRole('combobox', { name: /client/i })).toBeInTheDocument();
  });

  it('keeps Create disabled while Zoho is not configured, and enables it once it is', async () => {
    // Every other gate is satisfied by a restored draft (priced task, phone on
    // the client, hand-edited summary so no summarize call fires), so
    // `configured` is the only thing left that can hold Create back.
    localStorage.setItem(
      'aito.newProjectDraft.v1',
      JSON.stringify({
        tasks: [{ ...emptyTaskDraft(), title: 'Capot moteur', scanCost: 10 }],
        client: { ...defaultClientDraft(DEFAULT_ID, 'Client de passage'), nationalNumber: '87123456' },
        summaryText: 'Résumé restauré.',
        summaryEdited: true,
        summarySignature: '',
      }),
    );
    server.use(
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({
          configured: false, reachable: false,
          default_contact_id: DEFAULT_ID, default_contact_name: 'Client de passage',
        }),
      ),
    );

    const { unmount } = render(<NewProjectDrawer onClose={vi.fn()} onCreate={vi.fn()} />);
    await screen.findByText(/Client reachable/);
    await waitFor(() => expect(createButton()).toHaveAttribute('aria-disabled', 'true'));
    unmount();

    server.use(
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({
          configured: true, reachable: true,
          default_contact_id: DEFAULT_ID, default_contact_name: 'Client de passage',
        }),
      ),
    );
    render(<NewProjectDrawer onClose={vi.fn()} onCreate={vi.fn()} />);
    await waitFor(() => expect(createButton()).toHaveAttribute('aria-disabled', 'false'));
  });

  it('submits the summary text as the description', async () => {
    const user = userEvent.setup();
    const { onCreate } = await renderDrawer();

    await user.click(screen.getByRole('button', { name: 'Add Scan' }));
    fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '10' } });
    await user.click(clientHeader());
    await user.type(screen.getByLabelText(/^phone$/i), '87123456');
    await waitFor(() => expect(screen.getByLabelText('Project summary')).toHaveValue('Résumé IA.'));

    await user.click(createButton());

    expect(onCreate).toHaveBeenCalledWith(
      'Résumé IA.',
      expect.objectContaining({ id: DEFAULT_ID, isDefault: true }),
      [expect.objectContaining({ scanCost: 10 })],
    );
  });
});
