/** The invoice email dialog of an opened order. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render } from '../../utils';
import { OrderInvoiceEmailModal } from '../../../components/orders/OrderInvoiceEmailModal';

const content = {
  subject: 'Invoice subject',
  body: '<p>Bonjour</p>',
  recipients: [{ email: 'moana@client.pf', name: 'Moana', contact_person_id: 'cp2' }],
  default_email: 'moana@client.pf',
  document_id: 'i1',
  document_number: 'INV-1',
};
const url = '/api/v1/order-board/invoices/i1/email';
const open = (onClose = vi.fn()) => render(<OrderInvoiceEmailModal invoice={{ id: 'i1' }} onClose={onClose} />);
const ready = () => waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('moana@client.pf'));

describe('OrderInvoiceEmailModal', () => {
  afterEach(() => server.resetHandlers());

  it('posts {to}, toasts the address and closes', async () => {
    const posted: unknown[] = [];
    server.use(
      http.get(url, () => HttpResponse.json(content)),
      http.post(url, async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ board: { rows: [], sync: {} } });
      }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    open(onClose);
    expect(await screen.findByRole('dialog', { name: 'Send invoice by email' })).toBeInTheDocument();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posted).toEqual([{ to: 'moana@client.pf' }]));
    expect(await screen.findByText('Invoice sent to moana@client.pf')).toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('toasts a generic failure and keeps the dialog open', async () => {
    server.use(
      http.get(url, () => HttpResponse.json(content)),
      http.post(url, () => HttpResponse.json({ detail: 'Books says no' }, { status: 500 })),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    open(onClose);
    await ready();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Could not send the invoice')).toBeInTheDocument();
    expect(screen.queryByText(/just edited/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Invoice sent to/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says the address was just edited when the server refuses it for that', async () => {
    server.use(
      http.get(url, () => HttpResponse.json(content)),
      http.post(url, () =>
        HttpResponse.json({ detail: { code: 'recipient_recently_edited', message: 'edited' } }, { status: 409 }),
      ),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    open(onClose);
    await ready();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/just edited/)).toBeInTheDocument();
    expect(screen.queryByText('Could not send the invoice')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says so when the prefill cannot be read', async () => {
    server.use(http.get(url, () => HttpResponse.json({ detail: 'down' }, { status: 502 })));
    open();
    expect(await screen.findByText('Could not load the email details')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});
