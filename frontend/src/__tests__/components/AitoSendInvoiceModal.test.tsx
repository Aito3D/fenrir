import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SendInvoiceModal } from '../../components/aito/SendInvoiceModal';
import { api } from '../../api/client';
import type { AitoInvoice } from '../../api/client';

const CONTENT = {
  subject: 'Facture INV-00087',
  body: '<p>Bonjour</p>',
  recipients: [
    { email: 'contact@example.pf', name: 'Jean-Pierre DUPONT', contact_person_id: 'cp-1' },
    { email: 'compta@example.pf', name: 'Marie TAMA', contact_person_id: 'cp-2' },
  ],
  default_email: 'contact@example.pf',
  invoice_id: 'INV-7',
  invoice_number: 'INV-00087',
};

const SENT_INVOICE = {
  id: 'INV-7',
  number: 'INV-00087',
  date: '2026-08-18',
  due_date: '2026-09-18',
  total: 45000,
  balance: 45000,
  currency_code: 'XPF',
  status: 'sent',
  url: 'https://books.zoho.com/app#/invoices/INV-7',
  invoice_count: 1,
} as AitoInvoice;

describe('SendInvoiceModal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preselects the default address and sends it, pinned to the shown invoice', async () => {
    vi.spyOn(api, 'getAitoInvoiceEmail').mockResolvedValue(CONTENT);
    const send = vi.spyOn(api, 'sendAitoInvoiceEmail').mockResolvedValue(SENT_INVOICE);
    const user = userEvent.setup();
    render(<SendInvoiceModal projectId={12} invoiceId="INV-7" onClose={() => {}} />);

    const select = await screen.findByLabelText(/recipient/i);
    await waitFor(() => expect(select).toHaveValue('contact@example.pf'));

    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(12, { to: 'contact@example.pf', invoice_id: 'INV-7' }),
    );
  });

  it('sends the address the user picked, not the default', async () => {
    vi.spyOn(api, 'getAitoInvoiceEmail').mockResolvedValue(CONTENT);
    const send = vi.spyOn(api, 'sendAitoInvoiceEmail').mockResolvedValue(SENT_INVOICE);
    const user = userEvent.setup();
    render(<SendInvoiceModal projectId={12} invoiceId="INV-7" onClose={() => {}} />);

    const select = await screen.findByLabelText(/recipient/i);
    await waitFor(() => expect(select).toHaveValue('contact@example.pf'));
    await user.selectOptions(select, 'compta@example.pf');

    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(12, { to: 'compta@example.pf', invoice_id: 'INV-7' }),
    );
  });

  it('shows a success toast and closes on success', async () => {
    vi.spyOn(api, 'getAitoInvoiceEmail').mockResolvedValue(CONTENT);
    vi.spyOn(api, 'sendAitoInvoiceEmail').mockResolvedValue(SENT_INVOICE);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SendInvoiceModal projectId={12} invoiceId="INV-7" onClose={onClose} />);

    await screen.findByLabelText(/recipient/i);
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(await screen.findByText('Invoice sent to contact@example.pf')).toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('keeps the modal open on failure so the address can be retried', async () => {
    vi.spyOn(api, 'getAitoInvoiceEmail').mockResolvedValue(CONTENT);
    vi.spyOn(api, 'sendAitoInvoiceEmail').mockRejectedValue(new Error('502'));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SendInvoiceModal projectId={12} invoiceId="INV-7" onClose={onClose} />);

    await screen.findByLabelText(/recipient/i);
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(await screen.findByText('Could not send the invoice')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/recipient/i)).toBeInTheDocument();
  });

  it('says so, rather than showing an empty dropdown, when nobody can receive it', async () => {
    vi.spyOn(api, 'getAitoInvoiceEmail').mockResolvedValue({
      ...CONTENT,
      recipients: [],
      default_email: null,
    });
    render(<SendInvoiceModal projectId={12} invoiceId="INV-7" onClose={() => {}} />);

    expect(
      await screen.findByText('This client has no email address in Zoho.'),
    ).toBeInTheDocument();
  });

  it('reports a prefill failure instead of an empty form', async () => {
    vi.spyOn(api, 'getAitoInvoiceEmail').mockRejectedValue(new Error('502'));
    render(<SendInvoiceModal projectId={12} invoiceId="INV-7" onClose={() => {}} />);

    expect(await screen.findByText('Could not load the email details')).toBeInTheDocument();
  });
});
