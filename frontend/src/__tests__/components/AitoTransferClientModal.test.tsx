import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, render as rtlRender } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { AuthProvider } from '../../contexts/AuthContext';
import { ToastProvider } from '../../contexts/ToastContext';
import type { AitoProject, ZohoContact } from '../../api/client';
import { server } from '../mocks/server';
import { render, createTestQueryClient } from '../utils';
import { TransferClientModal } from '../../components/aito/TransferClientModal';
import { makeProject } from '../fixtures/aitoProject';

const project = makeProject({ id: 41, client_id: 'z1', client_name: 'ACME SARL' });

const contact = (overrides: Partial<ZohoContact>): ZohoContact => ({
  id: 'z0',
  name: '',
  company_name: '',
  customer_sub_type: 'individual',
  phone: '',
  mobile: '',
  email: '',
  ...overrides,
});

const pacific = contact({ id: 'z9', name: 'PACIFIC MARINE', mobile: '+689-87001122', email: 'ops@pacmarine.pf' });
const tahitiBoats = contact({
  id: 'z7',
  name: 'TAHITI BOATS',
  company_name: 'TAHITI BOATS',
  customer_sub_type: 'business',
});

function mockZoho() {
  const puts: { url: string; body: unknown }[] = [];
  server.use(
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({
        configured: true,
        reachable: null,
        default_contact_id: 'walkin',
        default_contact_name: 'Client comptoir',
      }),
    ),
    http.get('/api/v1/zoho/contacts', () => HttpResponse.json([pacific, tahitiBoats])),
    http.get('/api/v1/zoho/contacts/z7/persons', () =>
      HttpResponse.json([
        {
          contact_person_id: 'p2',
          first_name: 'Hina',
          last_name: 'TEMARU',
          name: 'Hina TEMARU',
          email: 'hina@tahitiboats.pf',
          phone: '',
          mobile: '+689-87334455',
          is_primary: true,
        },
      ]),
    ),
    http.put('/api/v1/aito/:id/transfer-client', async ({ request }) => {
      const body = (await request.json()) as { client_id: string; client_name: string };
      puts.push({ url: new URL(request.url).pathname, body });
      return HttpResponse.json({ ...project, client_id: body.client_id, client_name: body.client_name });
    }),
  );
  return puts;
}

async function pick(user: ReturnType<typeof userEvent.setup>, query: string, name: string) {
  await user.type(screen.getByRole('combobox'), query);
  await user.click(await screen.findByRole('option', { name: new RegExp(name) }));
}

describe('TransferClientModal', () => {
  it('shows the from/to line once a contact is picked and only then enables Transfer', async () => {
    mockZoho();
    const user = userEvent.setup();
    render(<TransferClientModal project={project} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Transfer to another client' })).toBeInTheDocument();
    const transfer = screen.getByRole('button', { name: 'Transfer' });
    expect(transfer).toBeDisabled();
    expect(screen.queryByText(/^From /)).not.toBeInTheDocument();
    await pick(user, 'pac', 'PACIFIC MARINE');
    expect(screen.getByText('From ACME SARL to PACIFIC MARINE')).toBeInTheDocument();
    expect(transfer).toBeEnabled();
  });

  it('never offers to create a new client from the search', async () => {
    mockZoho();
    const user = userEvent.setup();
    render(<TransferClientModal project={project} onClose={vi.fn()} />);
    await user.type(screen.getByRole('combobox'), 'pac');
    await screen.findByRole('option', { name: /PACIFIC MARINE/ });
    expect(screen.queryByText('Create new client')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new client/i })).not.toBeInTheDocument();
  });

  it('PUTs the mapped contact, toasts, hands the card to onDone and closes', async () => {
    const puts = mockZoho();
    const user = userEvent.setup();
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<TransferClientModal project={project} onClose={onClose} onDone={onDone} />);
    await pick(user, 'pac', 'PACIFIC MARINE');
    await user.click(screen.getByRole('button', { name: 'Transfer' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(puts).toEqual([
      {
        url: '/api/v1/aito/41/transfer-client',
        body: {
          client_id: 'z9',
          client_name: 'PACIFIC MARINE',
          client_phone: '+689-87001122',
          client_email: 'ops@pacmarine.pf',
          client_is_company: false,
          client_contact_person_id: null,
        },
      },
    ]);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: 41, client_id: 'z9' }));
    expect(await screen.findByText('Card transferred to PACIFIC MARINE')).toBeInTheDocument();
  });

  it('sends the chosen contact person and their coordinates for a company', async () => {
    const puts = mockZoho();
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<TransferClientModal project={project} onClose={onClose} />);
    await pick(user, 'tah', 'TAHITI BOATS');
    // The picker auto-selects Books' primary person once the list lands.
    expect(await screen.findByRole('radio', { name: /Hina TEMARU/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Transfer' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(puts[0].body).toEqual({
      client_id: 'z7',
      client_name: 'TAHITI BOATS',
      client_phone: '+689-87334455',
      client_email: 'hina@tahitiboats.pf',
      client_is_company: true,
      client_contact_person_id: 'p2',
    });
  });

  it('offers the walk-in client and sends it with no coordinates', async () => {
    const puts = mockZoho();
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<TransferClientModal project={project} onClose={onClose} />);
    await user.click(await screen.findByRole('button', { name: 'Reset to the default client' }));
    expect(screen.getByText('From ACME SARL to Client comptoir')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Transfer' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(puts[0].body).toEqual({
      client_id: 'walkin',
      client_name: 'Client comptoir',
      client_phone: null,
      client_email: null,
      client_is_company: false,
      client_contact_person_id: null,
    });
  });

  it('writes the answer into the board cache so the panel header changes at once', async () => {
    mockZoho();
    const queryClient = createTestQueryClient();
    queryClient.setQueryDefaults(['aito-projects'], { gcTime: Infinity });
    queryClient.setQueryData<AitoProject[]>(['aito-projects'], [project, makeProject({ id: 7 })]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    let seen: AitoProject[] | undefined;
    const onDone = vi.fn(() => {
      seen = queryClient.getQueryData<AitoProject[]>(['aito-projects']);
    });
    const user = userEvent.setup();
    rtlRender(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <ToastProvider>
              <TransferClientModal project={project} onClose={vi.fn()} onDone={onDone} />
            </ToastProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await pick(user, 'pac', 'PACIFIC MARINE');
    await user.click(screen.getByRole('button', { name: 'Transfer' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(seen?.find((p) => p.id === 41)?.client_name).toBe('PACIFIC MARINE');
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['aito-projects'],
        ['aito-events', 41],
        ['aito-client-history', 'z1'],
        ['aito-client-history', 'z9'],
      ]),
    );
  });

  it('keeps the dialog open with the refusal when the card is invoiced', async () => {
    mockZoho();
    server.use(
      http.put('/api/v1/aito/:id/transfer-client', () =>
        HttpResponse.json({ detail: 'This card is invoiced' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<TransferClientModal project={project} onClose={onClose} onDone={onDone} />);
    await pick(user, 'pac', 'PACIFIC MARINE');
    await user.click(screen.getByRole('button', { name: 'Transfer' }));
    expect(await screen.findByText('This card is invoiced')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
