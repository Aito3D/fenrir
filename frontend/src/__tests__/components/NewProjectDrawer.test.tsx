import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { NewProjectDrawer } from '../../components/aito/NewProjectDrawer';
import { api } from '../../api/client';
import type { AitoShippingService } from '../../api/client';
import { defaultClientDraft } from '../../utils/clientDraft';
import { emptyTaskDraft } from '../../utils/taskDraft';
import { tasksSignature } from '../../utils/aitoSummary';

const DEFAULT_ID = '66407000001237340';

// Same fixture as AitoShippingFields.test.tsx / AitoIslandCombobox.test.tsx:
// two services so a shipment can pick a real island and get a real rate.
const SHIPPING_SERVICES: AitoShippingService[] = [
  {
    key: 'tuamotu',
    name: 'Livraison Avion Tuamotu',
    rate: 3200,
    islands: [{ key: 'rangiroa', label: 'Rangiroa' }],
  },
  {
    key: 'australes',
    name: 'Livraison Avion Australes',
    rate: 4100,
    islands: [{ key: 'rurutu', label: 'Rurutu' }],
  },
];

// A real person, distinct from the default walk-in contact, so shipping's
// name pre-fill (which only ever happens for a non-company client) has
// something to split — and their directory phone doubles as the client
// reachability every shipping test that clicks Create depends on.
const JEAN_PIERRE = {
  id: 'zJeanPierre',
  name: 'Jean-Pierre DUPONT',
  company_name: '',
  customer_sub_type: 'individual',
  phone: '',
  mobile: '87123456',
  email: 'jp@example.pf',
};

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
    http.get('/api/v1/aito/shipping/services', () =>
      HttpResponse.json({ services: SHIPPING_SERVICES, catalogue_resolved: true }),
    ),
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

/** Opens the Client section and picks Jean-Pierre DUPONT — a real, reachable
 *  person distinct from the default walk-in contact — rather than typing a
 *  phone onto the default. Two things depend on this: shipping's name
 *  pre-fill (only ever populated for a non-company client) needs a name to
 *  split, and Jean-Pierre's directory mobile makes the client reachable
 *  without a separate typing step, so tests that go on to click Create are
 *  blocked by shipping alone, not by an incidental missing phone. */
async function openClientSection() {
  server.use(http.get('/api/v1/zoho/contacts', () => HttpResponse.json([JEAN_PIERRE])));
  await userEvent.click(clientHeader());
  const combobox = await screen.findByRole('combobox', { name: /client/i });
  await userEvent.clear(combobox);
  await userEvent.type(combobox, 'Jean');
  await userEvent.click(await screen.findByText('Jean-Pierre DUPONT'));
}

/** Prices the seeded task at 10 000 — the round number the receipt/total
 *  tests build their arithmetic on. */
async function fillOneTask() {
  await userEvent.click(screen.getByRole('button', { name: 'Add Scan' }));
  fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '10000' } });
}

/** Opens the island combobox and picks the given label. Uses `findByRole` for
 *  the option, not `getByRole`: the island table is its own query
 *  (`aito-shipping-services`) and may not have resolved the instant the
 *  dropdown opens. */
async function pickIsland(label: string) {
  await userEvent.click(screen.getByRole('combobox', { name: /destination island/i }));
  await userEvent.click(await screen.findByRole('option', { name: label }));
}

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

  it('persists the freshly opened signature immediately, not the one from before Client opened', async () => {
    // Regression for a stale-ref bug: opening Client updates
    // `summarySignatureRef` synchronously, but the save effect used to key
    // only off tasks/draft/summaryText/summaryEdited/shipping, so a save
    // triggered by an earlier change (here, pricing the task) could persist
    // the OLD signature and never get a chance to re-save the new one.
    // Never resolving the summarize call isolates that: if summaryText later
    // changed on its own, it would re-trigger the save effect anyway and
    // mask the bug.
    vi.mocked(api.summarizeAitoProject).mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    await renderDrawer();
    await fillOneTask();

    const expectedSignature = tasksSignature([{ ...emptyTaskDraft(), scanCost: 10000 }]);
    await user.click(clientHeader());

    await waitFor(() => {
      const raw = localStorage.getItem('aito.newProjectDraft.v1');
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string).summarySignature).toBe(expectedSignature);
    });
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
    expect(checklistLine('Client needs a phone, an email or a social network')).toHaveAttribute('data-state', 'wait');

    await user.click(createButton());

    expect(onCreate).not.toHaveBeenCalled();
    expect(checklistLine('"Task 1" needs at least one priced sub-task')).toHaveAttribute('data-state', 'miss');
    expect(checklistLine('Client needs a phone, an email or a social network')).toHaveAttribute('data-state', 'miss');
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

  it('hold-to-reset wipes the draft and leaves the summary generatable again', async () => {
    const user = userEvent.setup();
    await renderDrawer();

    await user.click(screen.getByRole('button', { name: 'Add Scan' }));
    fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '10' } });
    await user.click(clientHeader());
    await waitFor(() => expect(api.summarizeAitoProject).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'aito.newProjectDraft.v1',
        expect.stringContaining('"scanCost":10'),
      ),
    );

    // Drive HoldButton through its own contract: pointerdown starts the 500ms
    // timer that fires onHold. Real timers (MSW and React Query are live in
    // this test), so the assertion waits the hold out.
    fireEvent.pointerDown(screen.getByRole('button', { name: /reset draft/i }));
    await waitFor(() => expect(screen.queryByLabelText('Scan Cost')).not.toBeInTheDocument(), { timeout: 2000 });
    expect(localStorage.removeItem).toHaveBeenCalledWith('aito.newProjectDraft.v1');
    expect(screen.getByLabelText('Project summary')).toHaveValue('');

    // The reset must not cost the user the AI for the rest of the session:
    // the panel never unmounted, so a rewound nonce would be swallowed by its
    // own high-water mark and this second generation would never happen.
    await user.click(screen.getByRole('button', { name: 'Add Scan' }));
    fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '42' } });
    await user.click(clientHeader());
    await user.click(clientHeader());
    await waitFor(() => expect(api.summarizeAitoProject).toHaveBeenCalledTimes(2));
  });

  it('a stored phone that was never blurred still blocks the create it would poison', async () => {
    // Ported from NewProjectModal.test.tsx: real directory data carries
    // "other"-shaped numbers. Such a contact must not disable Create the
    // moment it is picked (no message, nothing to revert) — but neither may it
    // submit silently. Asking to create is what makes the error visible.
    const badContact = {
      id: 'bad1', name: 'Bad Contact', company_name: '',
      customer_sub_type: 'individual',
      phone: '', mobile: '+689-876543210987654', email: 'ok@example.pf',
    };
    server.use(http.get('/api/v1/zoho/contacts', () => HttpResponse.json([badContact])));
    const user = userEvent.setup();
    const { onCreate } = await renderDrawer();

    await user.click(screen.getByRole('button', { name: 'Add Scan' }));
    fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '10' } });
    await user.click(clientHeader());
    const combobox = await screen.findByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'Bad');
    await user.click(await screen.findByText('Bad Contact'));

    // Reachable and error-free as far as the user can see, so Create is live.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(createButton()).toHaveAttribute('aria-disabled', 'false'));

    await user.click(createButton());

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/4 and 14 digits/i);
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

  it('surfaces a failed Zoho status query, distinct from "not configured" and the happy path', async () => {
    // 1. The status GET itself fails: `statusQuery.data` stays undefined, so
    //    (unlike `configured: false`, which still ships a fallback contact)
    //    the default-contact effect never seeds `draft` — without the fix,
    //    the Client section body renders nothing at all and Create sits
    //    silently disabled.
    server.use(http.get('/api/v1/zoho/status', () => HttpResponse.error()));
    const { unmount: unmountError } = render(<NewProjectDrawer onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(await screen.findByText(/could not reach zoho/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /connect zoho/i })).not.toBeInTheDocument();
    expect(createButton()).toHaveAttribute('aria-disabled', 'true');
    unmountError();

    // 2. The request succeeds but reports `configured: false`: the existing
    //    "not configured" settings-link panel shows — never the unreachable
    //    message, which is reserved for a request that actually failed.
    server.use(
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({
          configured: false, reachable: false,
          default_contact_id: DEFAULT_ID, default_contact_name: 'Client de passage',
        }),
      ),
    );
    const { unmount: unmountNotConfigured } = render(<NewProjectDrawer onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(await screen.findByRole('link', { name: /connect zoho/i })).toBeInTheDocument();
    expect(screen.queryByText(/could not reach zoho/i)).not.toBeInTheDocument();
    unmountNotConfigured();

    // 3. The happy path (shared `beforeEach` mock, `configured: true`):
    //    neither failure message renders.
    await renderDrawer();
    expect(screen.queryByText(/could not reach zoho/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /connect zoho/i })).not.toBeInTheDocument();
  });

  it('✕ plays the drawer exit, then calls onClose', async () => {
    const user = userEvent.setup();
    const { onClose } = await renderDrawer();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    // The exit animation owns the next beat; unmounting is deferred to its end.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveClass('animate-drawer-out');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Escape defers close through the same exit', async () => {
    const user = userEvent.setup();
    const { onClose } = await renderDrawer();

    await user.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('collapsed sections keep their fields mounted but inert', async () => {
    const user = userEvent.setup();
    await renderDrawer();

    // The client section starts closed: its content stays in the DOM so the
    // collapse can animate height, but it must be unreachable by focus.
    expect(screen.getByLabelText(/^phone$/i)).toBeInTheDocument();
    const body = clientHeader().nextElementSibling as HTMLElement;
    expect(body).toHaveAttribute('inert');

    await user.click(clientHeader());
    await waitFor(() => expect(clientHeader().nextElementSibling).not.toHaveAttribute('inert'));
  });

  it('the create-client form rises in, and stepping back rises the client section', async () => {
    const user = userEvent.setup();
    await renderDrawer();

    await user.click(clientHeader());
    const combobox = await screen.findByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'zzz');
    await user.click(await screen.findByRole('button', { name: /create new client/i }));

    expect(screen.getByLabelText(/company name/i).closest('form')).toHaveClass('animate-rise');

    await user.keyboard('{Escape}');
    const restored = await screen.findByRole('combobox', { name: /client/i });
    expect(restored.closest('.animate-rise')).not.toBeNull();
  });

  it('acknowledges a completed section with a tick-in on its badge', async () => {
    const user = userEvent.setup();
    await renderDrawer();
    expect(workHeader().querySelector('.animate-tick-in')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add Scan' }));
    fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '10' } });

    await waitFor(() => expect(workHeader().querySelector('.animate-tick-in')).not.toBeNull());
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
      null,
    );
  });

  it('has no shipping block until the button is pressed', async () => {
    await renderDrawer();
    await openClientSection();
    expect(screen.queryByLabelText(/destination island/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add shipping/i })).toBeInTheDocument();
  });

  it('reveals the fields, pre-filled from the client', async () => {
    await renderDrawer();
    await openClientSection();
    await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));
    expect(screen.getByLabelText(/recipient first name/i)).toHaveValue('Jean-Pierre');
    expect(screen.getByLabelText(/recipient last name/i)).toHaveValue('DUPONT');
  });

  it('adds no checklist line while there is no shipment', async () => {
    await renderDrawer();
    expect(within(screen.getByTestId('drawer-checklist')).queryByText(/shipping/i)).not.toBeInTheDocument();
  });

  it('shows the shipping checklist line once a block exists, and completes it', async () => {
    await renderDrawer();
    await openClientSection();
    await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));
    const checklist = within(screen.getByTestId('drawer-checklist'));
    expect(checklist.getByText(/shipping being filled in/i)).toBeInTheDocument();
    await pickIsland('Rangiroa');
    expect(await checklist.findByText(/shipping to rangiroa/i)).toBeInTheDocument();
  });

  it('blocks Create on an incomplete shipment and reveals why on the click', async () => {
    const onCreate = vi.fn();
    await renderDrawer({ onCreate });
    await fillOneTask();
    await openClientSection();
    await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));
    await userEvent.click(createButton());
    expect(onCreate).not.toHaveBeenCalled();
    expect(within(screen.getByTestId('drawer-checklist')).getByText(/island missing/i)).toBeInTheDocument();
  });

  it('reveals the shipping checklist error too when Create is blocked by an unpriced task, not by the shipment', async () => {
    // The sibling test above ('blocks Create on an incomplete shipment...')
    // routes through create()'s OWN post-canCreate shipping check (`canCreate`
    // is already true there, since the task is priced and the client is
    // reachable) — it never exercises `revealEverything`'s shipping branch
    // (NewProjectDrawer.tsx, inside `revealEverything`), which only runs when
    // `!canCreate` for a reason having nothing to do with shipping. Here the
    // seeded task is deliberately left unpriced (no `fillOneTask`), so
    // `canCreate` is false before shipping is even considered, and clicking
    // Create takes the `revealEverything` branch instead.
    const onCreate = vi.fn();
    await renderDrawer({ onCreate });
    await openClientSection();
    await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));

    await userEvent.click(createButton());

    expect(onCreate).not.toHaveBeenCalled();
    const checklist = within(screen.getByTestId('drawer-checklist'));
    // The unblocking-unrelated failure: the seeded task, never priced.
    expect(checklist.getByText('"Task 1" needs at least one priced sub-task')).toBeInTheDocument();
    // The shipment's OWN error — revealed as a side effect of the click, even
    // though the shipment is not what disabled Create.
    expect(checklist.getByText(/island missing/i)).toBeInTheDocument();
  });

  it('puts the shipping cost in the rail receipt and the project total', async () => {
    await renderDrawer();
    await fillOneTask(); // 10 000
    await openClientSection();
    await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));
    await pickIsland('Rangiroa'); // 3 200
    expect(screen.getByTestId('rail-shipping-row')).toHaveTextContent('Rangiroa');
    expect(screen.getByTestId('rail-project-total')).toHaveTextContent('13 200');
  });

  it('hands the shipment to onCreate', async () => {
    const onCreate = vi.fn();
    await renderDrawer({ onCreate });
    await fillOneTask();
    await openClientSection();
    await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));
    await pickIsland('Rangiroa');
    await userEvent.click(createButton());
    expect(onCreate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(Array),
      expect.objectContaining({ island: 'rangiroa', service: 'tuamotu', price: 3200 }),
    );
  });

  it('removing the shipment restores the button and clears the checklist line', async () => {
    await renderDrawer();
    await openClientSection();
    await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));
    await userEvent.click(screen.getByRole('button', { name: /remove shipping/i }));
    expect(screen.getByRole('button', { name: /add shipping/i })).toBeInTheDocument();
    expect(within(screen.getByTestId('drawer-checklist')).queryByText(/shipping/i)).not.toBeInTheDocument();
  });

  it('round-trips a shipment through localStorage across unmount/remount', async () => {
    const { unmount } = await renderDrawer();
    await openClientSection();
    await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));
    await pickIsland('Rangiroa');
    await waitFor(() =>
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'aito.newProjectDraft.v1',
        expect.stringContaining('"island":"rangiroa"'),
      ),
    );
    unmount();

    render(<NewProjectDrawer onClose={vi.fn()} onCreate={vi.fn()} />);
    await userEvent.click(clientHeader());
    expect(await screen.findByLabelText(/recipient first name/i)).toHaveValue('Jean-Pierre');
    expect(screen.getByLabelText(/destination island/i)).toHaveValue('Rangiroa');
  });

  it('hold-to-reset also clears the shipment', async () => {
    await renderDrawer();
    await openClientSection();
    await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));
    await pickIsland('Rangiroa');
    await waitFor(() => expect(screen.getByLabelText(/destination island/i)).toHaveValue('Rangiroa'));

    // Same real-timer HoldButton drive as the plain "hold-to-reset" test above.
    fireEvent.pointerDown(screen.getByRole('button', { name: /reset draft/i }));
    await waitFor(() => expect(screen.queryByLabelText(/destination island/i)).not.toBeInTheDocument(), {
      timeout: 2000,
    });
    // `resetDraft` sets `draft` to null synchronously; the default-contact
    // effect that reseeds it (and remounts `ClientSection`, which is what the
    // Add-shipping button lives inside) runs a beat later.
    await waitFor(() => expect(screen.getByRole('button', { name: /add shipping/i })).toBeInTheDocument());
    expect(within(screen.getByTestId('drawer-checklist')).queryByText(/shipping/i)).not.toBeInTheDocument();
  });

  it('a legacy persisted draft with no shipping key reads as null, not a crash', async () => {
    localStorage.setItem(
      'aito.newProjectDraft.v1',
      JSON.stringify({
        tasks: [emptyTaskDraft()],
        client: null,
        summaryText: '',
        summaryEdited: false,
        summarySignature: '',
        // No `shipping` key at all — the pre-feature shape.
      }),
    );
    await renderDrawer();
    await openClientSection();
    expect(screen.getByRole('button', { name: /add shipping/i })).toBeInTheDocument();
    expect(within(screen.getByTestId('drawer-checklist')).queryByText(/shipping/i)).not.toBeInTheDocument();
  });

  it('enables Create for a client reachable only on a social network', async () => {
    const user = userEvent.setup();
    await renderDrawer();
    await fillOneTask();
    // The default walk-in client has no phone or email — clicking straight
    // into the section (not `openClientSection`, which swaps in Jean-Pierre's
    // already-reachable directory number) is what leaves the social pill as
    // the only way left to satisfy reachability.
    await user.click(clientHeader());

    expect(createButton()).toHaveAttribute('aria-disabled', 'true');

    await user.click(screen.getByRole('radio', { name: 'Instagram' }));
    await user.type(screen.getByLabelText(/username/i), 'moana.3d');

    await waitFor(() => expect(createButton()).toHaveAttribute('aria-disabled', 'false'));
  });

  it('shows the handle, not a blank contact, on the checklist for a social-only client', async () => {
    // Regression for the checklist reading "Client reachable — " with nothing
    // after the dash: `clientContact` must fall through to the social handle
    // exactly like the section header's own hint does, for the one client
    // this feature exists to serve — reachable on Instagram alone.
    const user = userEvent.setup();
    await renderDrawer();
    await fillOneTask();
    await user.click(clientHeader());
    await user.click(screen.getByRole('radio', { name: 'Instagram' }));
    await user.type(screen.getByLabelText(/username/i), 'moana.3d');

    await waitFor(() =>
      expect(within(screen.getByTestId('drawer-checklist')).getByText('Client reachable — moana.3d')).toBeInTheDocument(),
    );
  });

  it('sends the social pair on create', async () => {
    const user = userEvent.setup();
    const { onCreate } = await renderDrawer();
    await fillOneTask();
    await user.click(clientHeader());
    await user.click(screen.getByRole('radio', { name: 'Instagram' }));
    await user.type(screen.getByLabelText(/username/i), 'moana.3d');
    await waitFor(() => expect(createButton()).toHaveAttribute('aria-disabled', 'false'));

    await user.click(createButton());

    // The drawer hands the whole ClientDraft to its caller; the two fields
    // are what useAitoPageMutations turns into client_social_* on the wire.
    expect(onCreate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ socialNetwork: 'instagram', socialHandle: 'moana.3d' }),
      expect.any(Array),
      null,
    );
  });

  it('carries a handle typed into the create-client sub-form back into the draft', async () => {
    // Regression for a silent-failure trap: TypeScript's parameter variance
    // lets a one-argument `onClientCreated` satisfy the two-argument
    // `onCreated` prop `NewContactForm` now offers, so nothing fails to
    // compile if the seeding is missed — the handle just vanishes at runtime,
    // on exactly the path where it is most likely the client's only contact
    // detail (a brand-new walk-in client with no phone and no email).
    const createdContact = {
      id: 'newSocial1', name: 'Moana TAHITI', company_name: '',
      customer_sub_type: 'individual',
      phone: '', mobile: '', email: '',
    };
    server.use(http.post('/api/v1/zoho/contacts', () => HttpResponse.json(createdContact, { status: 201 })));
    const user = userEvent.setup();
    await renderDrawer();

    await user.click(clientHeader());
    const combobox = await screen.findByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'zzz');
    await user.click(await screen.findByRole('button', { name: /create new client/i }));

    await user.type(screen.getByLabelText(/company name/i), 'Moana Tahiti');
    await user.click(screen.getByRole('radio', { name: 'Instagram' }));
    await user.type(screen.getByLabelText(/username/i), 'moana.3d');
    await user.click(screen.getByRole('button', { name: /create client/i }));

    // Back on the client section (the sub-form closed): the header hint is
    // built from the live draft, so seeing the handle there — with Zoho
    // never having stored it — proves the drawer seeded it from the form's
    // own callback argument, not from `contact`.
    await waitFor(() => expect(clientHeader()).toHaveTextContent('moana.3d'));
  });
});
