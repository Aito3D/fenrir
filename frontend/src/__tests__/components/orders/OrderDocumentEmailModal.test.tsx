/** The quote / deposit-invoice email dialog of an opened order. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import type { OrderDocumentKind } from '../../../api/client';
import { render } from '../../utils';
import { OrderDocumentEmailModal } from '../../../components/orders/OrderDocumentEmailModal';

const content = {
  subject: 'Document subject',
  body: '<p>Bonjour</p>',
  recipients: [{ email: 'moana@client.pf', name: 'Moana', contact_person_id: 'cp2' }],
  default_email: 'moana@client.pf',
  document_id: 'd1',
  document_number: 'N-1',
};
const url = (kind: string) => `/api/v1/order-board/orders/so1/documents/${kind}/d1/email`;
const open = (kind: OrderDocumentKind, onClose = vi.fn()) =>
  render(<OrderDocumentEmailModal orderId="so1" kind={kind} docId="d1" onClose={onClose} />);

describe('OrderDocumentEmailModal', () => {
  afterEach(() => server.resetHandlers());

  it.each([
    ['quote', 'Send quote by email', 'Quote sent to moana@client.pf'],
    ['retainer', 'Send retainer invoice by email', 'Retainer invoice sent to moana@client.pf'],
  ] as const)('posts {to} for a %s, toasts the address and closes', async (kind, title, toast) => {
    const posted: unknown[] = [];
    let gets = 0;
    server.use(
      http.get(url(kind), () => {
        gets += 1;
        return HttpResponse.json(content);
      }),
      http.post(url(kind), async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ board: { rows: [], sync: {} } });
      }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    open(kind, onClose);
    expect(await screen.findByRole('dialog', { name: title })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('moana@client.pf'));
    expect(gets).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posted).toEqual([{ to: 'moana@client.pf' }]));
    expect(await screen.findByText(toast)).toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it.each([
    ['quote', 'Could not send the quote'],
    ['retainer', 'Could not send the retainer invoice'],
  ] as const)('toasts the %s failure and keeps the dialog open', async (kind, toast) => {
    server.use(
      http.get(url(kind), () => HttpResponse.json(content)),
      http.post(url(kind), () => HttpResponse.json({ detail: 'Books says no' }, { status: 502 })),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    open(kind, onClose);
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('moana@client.pf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(toast)).toBeInTheDocument();
    expect(screen.queryByText(/sent to/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says the address was just edited when the server refuses it for that', async () => {
    server.use(
      http.get(url('quote'), () => HttpResponse.json(content)),
      http.post(url('quote'), () =>
        HttpResponse.json({ detail: { code: 'recipient_recently_edited', message: 'edited' } }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    open('quote');
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('moana@client.pf'));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/just edited/)).toBeInTheDocument();
    expect(screen.queryByText('Could not send the quote')).not.toBeInTheDocument();
  });

  it('a quote send refused with a 409 shows the server\'s own words, in violet', async () => {
    server.use(
      http.get('/api/v1/order-board/quotes/e1/email', () => HttpResponse.json(content)),
      http.post('/api/v1/order-board/quotes/e1/email', () =>
        HttpResponse.json({ detail: 'Too many email sends. Please wait a moment and try again.' }, { status: 409 })),
    );
    const user = userEvent.setup();
    render(<OrderDocumentEmailModal quoteId="e1" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('moana@client.pf'));
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.closest('[data-testid="quote-email-accent"]')).not.toBeNull();
    await user.click(send);
    expect(await screen.findByText(/Too many email sends/)).toBeInTheDocument();
    expect(screen.queryByText(/another action/i)).not.toBeInTheDocument();
  });

  it('an order\'s document email keeps the order colour', async () => {
    server.use(http.get(url('quote'), () => HttpResponse.json(content)));
    open('quote');
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('moana@client.pf'));
    expect(screen.queryByTestId('quote-email-accent')).not.toBeInTheDocument();
  });

  it.each([
    ['quote', 'Could not load the email details'],
    ['retainer', 'Could not load the retainer email details'],
  ] as const)('says so when the %s prefill cannot be read', async (kind, msg) => {
    server.use(http.get(url(kind), () => HttpResponse.json({ detail: 'down' }, { status: 502 })));
    open(kind);
    expect(await screen.findByText(msg)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});
