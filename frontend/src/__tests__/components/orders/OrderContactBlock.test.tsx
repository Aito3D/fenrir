/** The contact editor in the order's contact card: writes email/phone to Zoho Books through PUT /contact. */
import { describe, it, expect, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render } from '../../utils';
import type { OrderContact } from '../../../api/client';
import { OrderContactBlock } from '../../../components/orders/OrderContactBlock';

const contact = (o: Partial<OrderContact> = {}): OrderContact => ({ name: 'Kelly SACAULT', email: 'k@x.pf', phone: '', mobile: '', ...o });

let bodies: unknown[] = [];
let creditCalls = 0;
let contactStatus = 200;
let release: (() => void) | null = null;
afterEach(() => {
  server.resetHandlers();
  bodies = [];
  creditCalls = 0;
  contactStatus = 200;
  release = null;
});

function useHandlers(hold = false) {
  server.use(
    http.get('/api/v1/order-board/orders/so1/client-rating', () => HttpResponse.json(null)),
    http.get('/api/v1/order-board/orders/so1/customer-credit', () => {
      creditCalls += 1;
      return HttpResponse.json({ credit: 0 });
    }),
    http.put('/api/v1/order-board/orders/so1/contact', async ({ request }) => {
      bodies.push(await request.json());
      if (hold) await new Promise<void>(r => { release = r; });
      if (contactStatus !== 200) return HttpResponse.json({ detail: 'boom' }, { status: contactStatus });
      return HttpResponse.json({ board: { rows: [] } });
    }),
  );
}

async function openEditor(c: OrderContact) {
  const user = userEvent.setup();
  render(<OrderContactBlock contact={c} orderNumber="SO-1" others={[]} orderId="so1" canEdit />);
  await user.click(screen.getByRole('button', { name: 'Edit the client' }));
  return user;
}

describe('OrderContactBlock editor', () => {
  it.each([
    ['mobile set', { mobile: ' 111 ', phone: '222' }, 'mobile', '111'],
    ['only phone set', { phone: ' 222 ', mobile: ' ' }, 'phone', '222'],
    ['neither set', { phone: '', mobile: '' }, 'mobile', '333'],
  ])('%s: sends trimmed values to the right field', async (_n, c, field, expected) => {
    useHandlers();
    const user = await openEditor(contact(c));
    const phone = screen.getByLabelText('Phone');
    const email = screen.getByLabelText('Email');
    expect(phone).toHaveValue(field === 'phone' ? ' 222 ' : c.mobile ? ' 111 ' : '');
    await user.clear(phone);
    await user.type(phone, `  ${expected}  `);
    await user.clear(email);
    await user.type(email, ' new@x.pf ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toEqual([{ email: 'new@x.pf', phone: expected, phone_field: field }]));
  });

  it('closes the editor and refreshes the customer queries on success', async () => {
    useHandlers();
    const user = await openEditor(contact({ mobile: '111' }));
    await waitFor(() => expect(creditCalls).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Phone')).not.toBeInTheDocument());
    await waitFor(() => expect(creditCalls).toBe(2));
  });

  it('shows the failure toast and keeps the form open on a server error', async () => {
    contactStatus = 500;
    useHandlers();
    const user = await openEditor(contact({ mobile: '111' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Could not update the client. Please try again.')).toBeInTheDocument();
    expect(screen.getByLabelText('Phone')).toBeInTheDocument();
  });

  it('disables Cancel and Save while the write is pending', async () => {
    useHandlers(true);
    const user = await openEditor(contact({ mobile: '111' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    release?.();
    await waitFor(() => expect(screen.queryByLabelText('Phone')).not.toBeInTheDocument());
  });

  it('Cancel closes the editor without writing', async () => {
    useHandlers();
    const user = await openEditor(contact({ mobile: '111' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Phone')).not.toBeInTheDocument();
    expect(bodies).toEqual([]);
  });
});
