/**
 * Integration coverage for the wiring between AitoPage's create mutation and
 * the Zoho contact sync — the part of this feature that NewProjectDrawer.test.tsx
 * cannot see, since the safety properties (create-before-sync ordering, the
 * default-walk-in-client guard, the touched-only PATCH body, clearing the
 * persisted drawer draft) all live in AitoPage.tsx, not in the drawer
 * component itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';

const DEFAULT_ID = '66407000001237340';
const SUMMARY_TEXT = 'Support de caméra';
const OTHER_CONTACT = {
  id: '66407000009999001',
  name: 'Jean DUPONT',
  company_name: '',
  customer_sub_type: 'individual',
  phone: '+33-179753070',
  mobile: '',
  email: 'jean@example.com',
};
const COMPANY_CONTACT = {
  id: '66407000009999002',
  name: 'ACME SARL',
  company_name: 'ACME SARL',
  customer_sub_type: 'business',
  phone: '+33-179753071',
  mobile: '',
  email: 'contact@acme.fr',
};

function createdProject(overrides: Record<string, unknown>) {
  return {
    id: 99,
    column: 'devis',
    position: 0,
    status: 'active',
    task_count: 0,
    tasks_total: 0,
    task_services: [],
    task_pending: [],
    steps_total: 0,
    steps_done: 0,
    task_steps: [],
    shipping_island: null,
    shipping_service: null,
    shipping_first_name: null,
    shipping_last_name: null,
    shipping_phone: null,
    shipping_price: null,
    shipping_service_name: null,
    created_at: '2026-07-26T00:00:00Z',
    updated_at: '2026-07-26T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(localStorage.getItem).mockReset();
  vi.mocked(localStorage.setItem).mockReset();
  vi.mocked(localStorage.removeItem).mockReset();
  vi.mocked(localStorage.getItem).mockReturnValue(null);
  Element.prototype.scrollIntoView = vi.fn();

  server.use(
    http.get('/api/v1/aito/', () => HttpResponse.json([])),
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({
        configured: true,
        reachable: true,
        default_contact_id: DEFAULT_ID,
        default_contact_name: 'Client de passage',
      }),
    ),
    http.get('/api/v1/zoho/contacts', () => HttpResponse.json([OTHER_CONTACT])),
    // The drawer's description now comes from the AI summary (or its
    // fallback), never a typed textarea — see AiSummaryPanel.tsx. Fixed here
    // so every test in this file can assert on a known description string
    // the same way the old modal's typed text let them.
    http.post('/api/v1/aito/summarize', () => HttpResponse.json({ summary: SUMMARY_TEXT, model: 'test' })),
  );
});

/** Opens the new-project drawer, prices the seeded task (a project needs at
 *  least one priced service to submit — see taskDraft.ts), and opens the
 *  Client section — which is what makes ClientSection's fields (phone,
 *  email, the contact combobox) render at all, and is also what fires the
 *  one summarize call every test below waits on. Mirrors
 *  NewProjectDrawer.test.tsx's own `renderDrawer` + section-opening steps,
 *  collapsed into one call for tests that always start from the same state. */
async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
  render(<AitoPage />);
  await user.click(await screen.findByRole('button', { name: 'Project' }));
  await screen.findByText(/Client account — Client de passage/);
  // The seeded task has no steps yet, so it is already showing its form, but
  // Scan is still a chip: enable it first to reach its cost field.
  await user.click(screen.getByRole('button', { name: 'Add Scan' }));
  fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '10' } });
  await user.click(screen.getByTestId('drawer-section-client'));
}

/** Every test submits once the summary has actually landed — clicking Create
 *  before it resolves would still work (`create()` falls back to
 *  `buildFallbackSummary` when `summaryText` is empty), but would make the
 *  description assertions below racy against the mocked summarize response. */
async function waitForSummary() {
  await waitFor(() => expect(screen.getByLabelText('Project summary')).toHaveValue(SUMMARY_TEXT));
}

describe('AitoPage: create-project → Zoho sync wiring', () => {
  it('saves an edited phone number on the card for the default walk-in client, but never PATCHes Zoho', async () => {
    // Deliberately edits the default client's phone rather than leaving it
    // untouched: `syncClientToZoho` has two independent early returns —
    // `isDefault` and "nothing touched" — and a draft that is both default
    // AND untouched would pass this test even if the `isDefault` guard were
    // deleted, because the "nothing touched" guard alone would already block
    // the PATCH. Touching the field forces the `isDefault` guard to be the
    // one actually doing the work, which is the property this test exists
    // to pin: `Client de passage` is a shared record with live transaction
    // history and must never be written to, no matter what the card holds.
    const user = userEvent.setup();
    const createSpy = vi.fn();
    const patchSpy = vi.fn();
    server.use(
      http.post('/api/v1/aito/', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        createSpy(body);
        return HttpResponse.json(createdProject(body), { status: 201 });
      }),
      http.patch('/api/v1/zoho/contacts/:id', async ({ request }) => {
        patchSpy(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await openDrawer(user);

    const phoneInput = screen.getByLabelText(/^phone$/i);
    await user.clear(phoneInput);
    await user.type(phoneInput, '612345678');
    await user.tab();
    await waitForSummary();

    await user.click(screen.getByRole('button', { name: /create project/i }));

    // The card keeps the number...
    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          client_id: DEFAULT_ID,
          description: SUMMARY_TEXT,
          client_phone: expect.stringContaining('612345678'),
          client_is_company: false,
        }),
      ),
    );
    // The drawer closes as soon as the card exists — no waiting on Zoho.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /create project/i })).not.toBeInTheDocument(),
    );

    // ...but Zoho never sees it. No extra wait needed: `syncClientToZoho`'s
    // guards run synchronously (before its first `await`) as part of the same
    // `onSuccess` that clears the placeholder and closes the drawer, so by
    // the time the drawer-closed `waitFor` above has resolved, the guard has
    // already either bailed out or dispatched the PATCH.
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('sends the social network and handle in the create payload', async () => {
    // The last unpinned hop of the value's journey: `client_social_network`/
    // `client_social_handle` are optional in `api.createAitoProject`'s
    // parameter type, so a call site that forgot to pass them through would
    // still compile — nothing but a test catches that silent drop.
    const user = userEvent.setup();
    const createSpy = vi.fn();
    server.use(
      http.post('/api/v1/aito/', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        createSpy(body);
        return HttpResponse.json(createdProject(body), { status: 201 });
      }),
    );

    await openDrawer(user);
    await user.click(screen.getByRole('radio', { name: 'Instagram' }));
    await user.type(screen.getByLabelText(/username/i), 'moana.raiatea');
    await waitForSummary();

    await user.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          client_social_network: 'instagram',
          client_social_handle: 'moana.raiatea',
        }),
      ),
    );
  });

  it('does not PATCH the walk-in default contact after create', async () => {
    // Same guard as the test above, but through the EMAIL branch rather than
    // phone — the two are independent `touched` flags on the draft, and the
    // `isDefault` bail-out must hold for both, not just the one the test
    // above happens to exercise. `draft.id === defaultContactId` here
    // because this test never picks another contact.
    const user = userEvent.setup();
    const patchSpy = vi.fn();
    server.use(
      http.post('/api/v1/aito/', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(createdProject(body), { status: 201 });
      }),
      http.patch('/api/v1/zoho/contacts/:id', async ({ request }) => {
        patchSpy(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await openDrawer(user);
    await user.type(screen.getByLabelText(/^email/i), 'client@example.pf');
    await user.tab();
    await waitForSummary();

    await user.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /create project/i })).not.toBeInTheDocument(),
    );
    // No extra wait needed here either — see the sibling phone-branch test
    // above for why the drawer-closed signal already suffices.
    expect(patchSpy).not.toHaveBeenCalled();
    // Skipped silently — never the "created but Zoho failed" warning, which
    // would be a lie: nothing was even attempted.
    expect(
      screen.queryByText('Project created — could not update the client in Zoho.'),
    ).not.toBeInTheDocument();
  });

  it('clears the persisted drawer draft on create success', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/v1/aito/', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(createdProject(body), { status: 201 });
      }),
      http.patch('/api/v1/zoho/contacts/:id', async ({ request }) => {
        await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await openDrawer(user);
    await user.type(screen.getByLabelText(/^phone$/i), '87123456');
    await waitForSummary();

    await user.click(screen.getByRole('button', { name: /create project/i }));

    // `clearNewProjectDraft` (../../hooks/useNewProjectDraft) wipes the
    // localStorage key the drawer persists to — this file's beforeEach mocks
    // every localStorage method as a spy (see setup.ts), so the removeItem
    // CALL is the assertable signal, not a real read-back.
    await waitFor(() => expect(localStorage.removeItem).toHaveBeenCalledWith('aito.newProjectDraft.v1'));
  });

  it('PATCHes only the touched phone field for a non-default client, and omits email entirely when untouched', async () => {
    const user = userEvent.setup();
    const patchSpy = vi.fn();
    server.use(
      http.post('/api/v1/aito/', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(createdProject(body), { status: 201 });
      }),
      http.patch('/api/v1/zoho/contacts/:id', async ({ request, params }) => {
        patchSpy(params.id, await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await openDrawer(user);

    const combobox = screen.getByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'Jean');
    await user.click(await screen.findByRole('option', { name: /Jean DUPONT/i }, { timeout: 3000 }));

    const phoneInput = screen.getByLabelText(/^phone$/i);
    await user.clear(phoneInput);
    await user.type(phoneInput, '612345678');
    await user.tab();
    await waitForSummary();

    await user.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => expect(patchSpy).toHaveBeenCalled());
    const [id, body] = patchSpy.mock.calls[0];
    expect(id).toBe(OTHER_CONTACT.id);
    expect(body).toMatchObject({ phone: '+33-612345678', phone_field: 'phone' });
    // Email was never edited — must not be sent at all (sending '' would clear
    // the stored value in Zoho, sending the unedited value would be a no-op at
    // best and a stale overwrite at worst).
    expect(body).not.toHaveProperty('email');
  });

  it('sends client_is_company: true when the selected contact is a business', async () => {
    // The true branch is the one that actually matters: it is what the panel
    // reads to decide between "Client name:" and "Company name:". The other
    // tests in this file only ever select the individual OTHER_CONTACT, so
    // without this test the false-branch assertion above could pass even if
    // `draft.isCompany` were never wired to `client_is_company` at all.
    const user = userEvent.setup();
    const createSpy = vi.fn();
    server.use(
      http.get('/api/v1/zoho/contacts', () => HttpResponse.json([COMPANY_CONTACT])),
      http.post('/api/v1/aito/', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        createSpy(body);
        return HttpResponse.json(createdProject(body), { status: 201 });
      }),
      http.patch('/api/v1/zoho/contacts/:id', async ({ request }) => {
        await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await openDrawer(user);

    const combobox = screen.getByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'ACME');
    await user.click(await screen.findByRole('option', { name: /ACME SARL/i }, { timeout: 3000 }));
    // COMPANY_CONTACT already carries a phone/email from the directory, so
    // the client is reachable as soon as it is selected — nothing left to
    // touch before the summary is ready.
    await waitForSummary();

    await user.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ client_id: COMPANY_CONTACT.id, client_is_company: true }),
      ),
    );
  });

  it('still creates the card and closes the modal when the Zoho sync fails, showing a warning toast instead of an error', async () => {
    const user = userEvent.setup();
    const createSpy = vi.fn();
    server.use(
      http.post('/api/v1/aito/', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        createSpy(body);
        return HttpResponse.json(createdProject(body), { status: 201 });
      }),
      http.patch('/api/v1/zoho/contacts/:id', () => HttpResponse.json({ detail: 'boom' }, { status: 502 })),
    );

    await openDrawer(user);

    const combobox = screen.getByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'Jean');
    await user.click(await screen.findByRole('option', { name: /Jean DUPONT/i }, { timeout: 3000 }));

    const phoneInput = screen.getByLabelText(/^phone$/i);
    await user.clear(phoneInput);
    await user.type(phoneInput, '612345678');
    await user.tab();
    await waitForSummary();

    await user.click(screen.getByRole('button', { name: /create project/i }));

    // Card creation and the modal closing both happen before the failed sync
    // is even known about.
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /create project/i })).not.toBeInTheDocument(),
    );

    expect(
      await screen.findByText('Project created — could not update the client in Zoho.'),
    ).toBeInTheDocument();
    // Never the generic create-failure error — the card exists, this is a
    // separate, lower-severity warning about the Zoho side only.
    expect(screen.queryByText('Could not create the project. Please try again.')).not.toBeInTheDocument();
  });

  it('maps a task to the POST body through the real create flow, keeping a 0 cost distinct from a disabled service', async () => {
    // NewProjectDrawer.test.tsx only pins the handoff at the drawer boundary
    // (onCreate's TaskDraft argument) — it never sees the .trim() || null and
    // snake_case mapping that lives in AitoPage.tsx's mutationFn. This test
    // goes through the real AitoPage flow and inspects the captured POST
    // body, which is the only place that mapping is exercised at all. It
    // pins both halves of the null-vs-zero contract in the same assertion:
    // a filled-in 0 cost must survive as `0` (a free service), while every
    // untouched field — including the title — must arrive as `null`, not ''
    // or an accidentally-dropped key. Losing either direction (e.g. `t.scanCost
    // || null`, or `t.title.trim()` without the `|| null`) would silently
    // turn a real quote wrong and nothing else in this suite would catch it.
    const user = userEvent.setup();
    const createSpy = vi.fn();
    server.use(
      http.post('/api/v1/aito/', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        createSpy(body);
        return HttpResponse.json(createdProject(body), { status: 201 });
      }),
    );

    await openDrawer(user);
    // The default walk-in client needs a phone or an email before Create
    // will fire at all (the drawer's own reachability rule) — untouched
    // otherwise, since this test only cares about the tasks mapping.
    await user.type(screen.getByLabelText(/^phone$/i), '87123456');
    // openDrawer already primed the seeded task's Scan field; overwrite it to
    // 0 (a free service) and leave the title and every other service
    // untouched (disabled) — the two states the mapping must never conflate.
    fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '0' } });

    await user.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const body = createSpy.mock.calls[0][0] as { tasks: unknown[] };
    expect(body.tasks).toEqual([
      {
        title: null,
        scan_description: null,
        modelisation_description: null,
        impression_description: null,
        usinage_description: null,
        scan_cost: 0,
        modelisation_cost: null,
        usinage_cost: null,
        impression_printer_id: null,
        impression_filament_id: null,
        impression_weight_g: null,
        impression_time_min: null,
        impression_quantity: 1,
        impression_color: null,
        impression_cost: null,
        impression_discount_pct: null,
        scan_done: false,
        modelisation_done: false,
        impression_done: false,
        usinage_done: false,
      },
    ]);
  });
});
