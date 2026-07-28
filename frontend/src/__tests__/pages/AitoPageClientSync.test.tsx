/**
 * Integration coverage for the wiring between AitoPage's create mutation and
 * the Zoho contact sync — the part of this feature that NewProjectModal.test.tsx
 * cannot see, since the safety properties (create-before-sync ordering, the
 * default-walk-in-client guard, the touched-only PATCH body) all live in
 * AitoPage.tsx, not in the modal component itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';

const DEFAULT_ID = '66407000001237340';
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
  );
});

async function openModal(user: ReturnType<typeof userEvent.setup>) {
  render(<AitoPage />);
  await user.click(await screen.findByRole('button', { name: 'Project' }));
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: /client/i })).toHaveValue('Client de passage'),
  );
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

    await openModal(user);
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');

    const phoneInput = screen.getByLabelText(/^phone$/i);
    await user.clear(phoneInput);
    await user.type(phoneInput, '612345678');
    await user.tab();

    await user.click(screen.getByRole('button', { name: /create project/i }));

    // The card keeps the number...
    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          client_id: DEFAULT_ID,
          description: 'Support de caméra',
          client_phone: expect.stringContaining('612345678'),
          client_is_company: false,
        }),
      ),
    );
    // The modal closes as soon as the card exists — no waiting on Zoho.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /create project/i })).not.toBeInTheDocument(),
    );

    // ...but Zoho never sees it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(patchSpy).not.toHaveBeenCalled();
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

    await openModal(user);
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');

    const combobox = screen.getByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'Jean');
    await user.click(await screen.findByRole('option', { name: /Jean DUPONT/i }, { timeout: 3000 }));

    const phoneInput = screen.getByLabelText(/^phone$/i);
    await user.clear(phoneInput);
    await user.type(phoneInput, '612345678');
    await user.tab();

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

    await openModal(user);
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');

    const combobox = screen.getByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'ACME');
    await user.click(await screen.findByRole('option', { name: /ACME SARL/i }, { timeout: 3000 }));

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

    await openModal(user);
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');

    const combobox = screen.getByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'Jean');
    await user.click(await screen.findByRole('option', { name: /Jean DUPONT/i }, { timeout: 3000 }));

    const phoneInput = screen.getByLabelText(/^phone$/i);
    await user.clear(phoneInput);
    await user.type(phoneInput, '612345678');
    await user.tab();

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
});
