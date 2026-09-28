import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SendInvoiceButton } from '../../components/aito/SendInvoiceButton';
import { api } from '../../api/client';

describe('SendInvoiceButton', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens the modal and fetches the prefill for this invoice', async () => {
    const spy = vi.spyOn(api, 'getAitoInvoiceEmail').mockResolvedValue({
      subject: 'Facture INV-00087',
      body: '<p>Bonjour</p>',
      recipients: [{ email: 'contact@example.pf', name: 'Jean-Pierre DUPONT', contact_person_id: 'cp-1' }],
      default_email: 'contact@example.pf',
      invoice_id: 'INV-7',
      invoice_number: 'INV-00087',
    });
    const user = userEvent.setup();
    render(<SendInvoiceButton projectId={12} document={{ kind: 'invoice', id: 'INV-7' }} />);

    await user.click(screen.getByRole('button', { name: /send invoice/i }));

    expect(await screen.findByLabelText(/recipient/i)).toBeInTheDocument();
    // Pinned to the invoice the card is showing, not "whatever is newest".
    expect(spy).toHaveBeenCalledWith(12, 'INV-7');
  });

  it('fetches the retainer prefill and posts the retainer send for a retainer document', async () => {
    const spy = vi.spyOn(api, 'getAitoRetainerEmail').mockResolvedValue({
      subject: 'Acompte AC-26-0031',
      body: '<p>Bonjour</p>',
      recipients: [{ email: 'contact@example.pf', name: 'Jean-Pierre Dupont', contact_person_id: 'cp-1' }],
      default_email: 'contact@example.pf',
      retainer_id: 'RET-B',
      retainer_number: 'AC-26-0031',
    });
    const user = userEvent.setup();
    render(<SendInvoiceButton projectId={12} document={{ kind: 'retainer', id: 'RET-B' }} />);

    await user.click(screen.getByRole('button', { name: 'Send retainer invoice' }));

    expect(await screen.findByRole('dialog', { name: 'Send retainer invoice by email' })).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith(12, 'RET-B');
  });
});
