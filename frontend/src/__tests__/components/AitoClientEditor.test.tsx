import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ClientEditor } from '../../components/aito/ClientEditor';
import type { AitoProject } from '../../api/client';
import i18n from '../../i18n';

const WALK_IN = '66407000001237340';

const project: AitoProject = {
  id: 12,
  description: 'Support de caméra',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'Jean DUPONT',
  client_phone: '+689-87000001',
  client_email: 'jean@example.pf',
  client_is_company: false,
  client_social_network: null,
  client_social_handle: null,
  quote_id: null,
  quote_number: null,
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
  quote_accepted_at: null,
  quote_sent_at: null,
  invoice_status: null,
  invoice_balance: null,
  invoice_due_date: null,
  invoice_checked_at: null,
  quote_sync_state: 'idle',
  quote_invoiced: false,
  flag: null,
  client_contacted_at: null,
  due_date: null,
  quote_sync_error: null,
  quote_status_block: null,
  quote_status_remote: null,
  created_by: null,
  task_count: 0,
  tasks_total: 0,
  task_services: [],
  task_pending: [],
  steps_total: 0,
  steps_done: 0,
  print_minutes_pending: 0,
  task_steps: [],
  move_lock: null,
  shipping_island: null,
  shipping_service: null,
  shipping_first_name: null,
  shipping_last_name: null,
  shipping_phone: null,
  shipping_price: null,
  shipping_lta: null,
  shipping_service_name: null,
  tracking_configured: false,
  quote_expiry_date: null,
  retainer_paid_total: null,
  customer_credit_total: null,
  payment_link: null,
  version: 3,
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

const zohoContact = {
  id: 'z1',
  name: 'Jean DUPONT',
  company_name: '',
  customer_sub_type: 'individual',
  phone: '',
  mobile: '+689-87000009',
  email: 'zoho@example.pf',
  first_name: 'Jean',
  last_name: 'DUPONT',
};

function mockZoho({ contactGets }: { contactGets?: { n: number } } = {}) {
  server.use(
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({
        configured: true,
        reachable: null,
        default_contact_id: WALK_IN,
        default_contact_name: 'Client de passage',
      }),
    ),
    http.get('/api/v1/zoho/contacts/:id', () => {
      if (contactGets) contactGets.n += 1;
      return HttpResponse.json(zohoContact);
    }),
  );
}

const show = (overrides: Partial<AitoProject> = {}, handlers: { onSaved?: () => void; onCancel?: () => void } = {}) => {
  const onSaved = handlers.onSaved ?? vi.fn();
  const onCancel = handlers.onCancel ?? vi.fn();
  render(<ClientEditor project={{ ...project, ...overrides }} onSaved={onSaved} onCancel={onCancel} />);
  return { onSaved, onCancel };
};

const firstName = () => screen.getByLabelText(i18n.t('aito.firstName')) as HTMLInputElement;
const lastName = () => screen.getByLabelText(i18n.t('aito.lastName')) as HTMLInputElement;
const email = () => screen.getByLabelText(i18n.t('aito.clientEmail')) as HTMLInputElement;
const phone = () => screen.getByLabelText(i18n.t('aito.clientPhone')) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClientEditor', () => {
  it('prefills a person card from the live Zoho contact, not the card snapshot', async () => {
    mockZoho();
    show();
    await waitFor(() => expect(firstName().value).toBe('Jean'));
    expect(lastName().value).toBe('DUPONT');
    // Zoho's values win over the snapshot's stale ones.
    expect(email().value).toBe('zoho@example.pf');
    expect(phone().value).toBe('87000009');
    expect(screen.queryByLabelText(i18n.t('aito.companyName'))).toBeNull();
  });

  it('saves through the client route with house-format values and the version it opened on', async () => {
    mockZoho();
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/v1/aito/12/client', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...project, client_name: 'Jean-Pierre DUPONT', version: 4 });
      }),
    );
    const { onSaved } = show();
    await waitFor(() => expect(firstName().value).toBe('Jean'));
    const user = userEvent.setup();
    await user.clear(firstName());
    await user.type(firstName(), 'jean-pierre');
    await user.clear(phone());
    await user.type(phone(), '87 00 00 02');
    await user.click(screen.getByRole('button', { name: i18n.t('common.save') }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(sent).toEqual({
      first_name: 'Jean-Pierre',
      last_name: 'DUPONT',
      email: 'zoho@example.pf',
      phone: '+689-87000002',
      phone_field: 'mobile',
      client_social_network: null,
      client_social_handle: null,
      expected_version: 3,
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ client_name: 'Jean-Pierre DUPONT', version: 4 }));
  });

  it('keeps the editor open and shows the error when Zoho refuses the change', async () => {
    mockZoho();
    server.use(
      http.put('/api/v1/aito/12/client', () =>
        HttpResponse.json({ detail: 'Contact name already exists' }, { status: 409 }),
      ),
    );
    const { onSaved } = show();
    await waitFor(() => expect(firstName().value).toBe('Jean'));
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }));
    expect(await screen.findByText('Contact name already exists')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(firstName()).toBeInTheDocument();
  });

  it('carries the card-only social channel in the same save', async () => {
    mockZoho();
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/v1/aito/12/client', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...project, client_social_network: 'instagram', client_social_handle: 'jean.3d' });
      }),
    );
    const { onSaved } = show();
    await waitFor(() => expect(firstName().value).toBe('Jean'));
    const user = userEvent.setup();
    // Disabled until a network is picked: a handle with no network is not a
    // channel, and the placeholder says what to do first.
    const handle = screen.getByLabelText(i18n.t('aito.socialHandleLabel')) as HTMLInputElement;
    expect(handle).toBeDisabled();
    expect(handle.placeholder).toBe(i18n.t('aito.socialPickFirst'));
    await user.click(screen.getByRole('radio', { name: 'Instagram' }));
    await user.type(handle, 'jean.3d');
    await user.click(screen.getByRole('button', { name: i18n.t('common.save') }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(sent).toEqual(expect.objectContaining({ client_social_network: 'instagram', client_social_handle: 'jean.3d' }));
  });

  it('prefills the social channel from the card, not from Zoho, and clears the pair on a blank handle', async () => {
    mockZoho();
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/v1/aito/12/client', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...project, client_social_network: null, client_social_handle: null });
      }),
    );
    show({ client_social_network: 'tiktok', client_social_handle: 'jean.tt' });
    await waitFor(() => expect(firstName().value).toBe('Jean'));
    expect(screen.getByRole('radio', { name: 'TikTok' })).toHaveAttribute('aria-checked', 'true');
    const handle = screen.getByLabelText(i18n.t('aito.socialHandleLabel')) as HTMLInputElement;
    expect(handle.value).toBe('jean.tt');
    const user = userEvent.setup();
    await user.clear(handle);
    await user.click(screen.getByRole('button', { name: i18n.t('common.save') }));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toEqual(expect.objectContaining({ client_social_network: null, client_social_handle: null }));
  });

  it('counts the handle typed here as a channel, and a cleared one as gone', async () => {
    mockZoho();
    show({ client_social_network: 'messenger', client_social_handle: 'jean' });
    await waitFor(() => expect(firstName().value).toBe('Jean'));
    const user = userEvent.setup();
    await user.clear(phone());
    await user.clear(email());
    expect(screen.getByRole('button', { name: i18n.t('common.save') })).not.toBeDisabled();
    await user.clear(screen.getByLabelText(i18n.t('aito.socialHandleLabel')));
    expect(screen.getByRole('button', { name: i18n.t('common.save') })).toBeDisabled();
    expect(screen.getByText(i18n.t('aito.ruleClientContact'))).toBeInTheDocument();
  });

  it('closes on Escape without letting the key reach the window, and on an outside press', async () => {
    mockZoho();
    const windowEscape = vi.fn();
    window.addEventListener('keydown', windowEscape);
    const { onCancel } = show();
    await waitFor(() => expect(firstName().value).toBe('Jean'));
    fireEvent.keyDown(firstName(), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(windowEscape).not.toHaveBeenCalled();
    window.removeEventListener('keydown', windowEscape);
    fireEvent.pointerDown(document.body);
    expect(onCancel).toHaveBeenCalledTimes(2);
    // A press inside the sheet is not an outside press.
    fireEvent.pointerDown(email());
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('names Zoho Books as the destination on a Books contact and this card only on a walk-in', async () => {
    mockZoho();
    show();
    await waitFor(() => expect(firstName().value).toBe('Jean'));
    expect(screen.getByTestId('client-edit-source')).toHaveTextContent(i18n.t('aito.clientEditSourceZoho'));
    expect(screen.getByText(i18n.t('aito.clientEditFanOut'))).toBeInTheDocument();
  });

  it('edits a walk-in card from its own snapshot, without reading Zoho, and says so', async () => {
    const contactGets = { n: 0 };
    mockZoho({ contactGets });
    show({ client_id: WALK_IN, client_name: 'Jean-Pierre LE ROUX' });
    await waitFor(() => expect(firstName().value).toBe('Jean-Pierre'));
    expect(lastName().value).toBe('LE ROUX');
    expect(email().value).toBe('jean@example.pf');
    expect(screen.getByText(i18n.t('aito.clientEditWalkIn'))).toBeInTheDocument();
    expect(screen.getByTestId('client-edit-source')).toHaveTextContent(i18n.t('aito.clientEditSourceCard'));
    expect(screen.queryByText(i18n.t('aito.clientEditFanOut'))).not.toBeInTheDocument();
    expect(contactGets.n).toBe(0);
  });

  it('falls back to the card snapshot with a notice when the Zoho read fails', async () => {
    server.use(
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({ configured: true, reachable: null, default_contact_id: WALK_IN, default_contact_name: 'x' }),
      ),
      http.get('/api/v1/zoho/contacts/:id', () => HttpResponse.json({ detail: 'boom' }, { status: 502 })),
    );
    show();
    await waitFor(() => expect(firstName().value).toBe('Jean'));
    expect(lastName().value).toBe('DUPONT');
    expect(phone().value).toBe('87000001');
    expect(screen.getByText(i18n.t('aito.clientEditZohoReadFailed'))).toBeInTheDocument();
  });

  it('falls back to the card snapshot when even the Zoho status cannot be read', async () => {
    server.use(
      http.get('/api/v1/zoho/status', () => HttpResponse.json({ detail: 'down' }, { status: 502 })),
    );
    show();
    await waitFor(() => expect(firstName().value).toBe('Jean'));
    expect(screen.getByText(i18n.t('aito.clientEditZohoReadFailed'))).toBeInTheDocument();
  });

  it('offers a single company name field on a company card', async () => {
    server.use(
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({ configured: true, reachable: null, default_contact_id: WALK_IN, default_contact_name: 'x' }),
      ),
      http.get('/api/v1/zoho/contacts/:id', () =>
        HttpResponse.json({ ...zohoContact, name: 'ACME SARL', company_name: 'ACME SARL', customer_sub_type: 'business' }),
      ),
    );
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/v1/aito/12/client', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...project, client_name: 'ACME Pacific', version: 4 });
      }),
    );
    const { onSaved } = show({ client_name: 'ACME', client_is_company: true });
    const company = (await screen.findByLabelText(i18n.t('aito.companyName'))) as HTMLInputElement;
    await waitFor(() => expect(company.value).toBe('ACME SARL'));
    expect(screen.queryByLabelText(i18n.t('aito.firstName'))).toBeNull();
    const user = userEvent.setup();
    await user.clear(company);
    await user.type(company, 'ACME Pacific');
    await user.click(screen.getByRole('button', { name: i18n.t('common.save') }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(sent).toMatchObject({ company_name: 'ACME Pacific', email: 'zoho@example.pf', phone: '+689-87000009' });
    expect(sent).not.toHaveProperty('first_name');
  });

  it('refuses to save a card left with no phone, email or social handle', async () => {
    mockZoho();
    const { onSaved } = show();
    await waitFor(() => expect(firstName().value).toBe('Jean'));
    const user = userEvent.setup();
    await user.clear(email());
    await user.clear(phone());
    const save = screen.getByRole('button', { name: i18n.t('common.save') });
    expect(save).toBeDisabled();
    expect(screen.getByText(i18n.t('aito.ruleClientContact'))).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('cancels without saving', async () => {
    mockZoho();
    const { onCancel, onSaved } = show();
    await waitFor(() => expect(firstName().value).toBe('Jean'));
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.cancel') }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
