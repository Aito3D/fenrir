/** The order pickup SMS: the pill in the contact card and the send window. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render } from '../../utils';
import { api, type OrderBoardRow, type OrderContact, type OrderPanelRow } from '../../../api/client';
import { OrderContactBlock } from '../../../components/orders/OrderContactBlock';
import { OrderSmsModal } from '../../../components/orders/OrderSmsModal';

const contact = (o: Partial<OrderContact> = {}): OrderContact => ({ name: 'Kelly SACAULT', email: '', phone: '', mobile: '+689-89530560', ...o });
const row = { id: 'so264', number: 'SO-00264', contact: contact(), contacted: null } as unknown as OrderPanelRow;
const DRAFT = 'Ia Ora na, tes filaments de la commande #1106 sont disponibles. Tu peux venir les récupérer à notre boutique à Arue.\nAito3D';

describe('OrderContactBlock SMS pill', () => {
  it('is absent without the sms prop (non-admins, finished orders)', () => {
    render(<OrderContactBlock contact={contact()} orderNumber="SO-00264" others={[]} />);
    expect(screen.queryByRole('button', { name: /pickup sms/i })).not.toBeInTheDocument();
  });

  it('opens with the mobile number', async () => {
    const onOpen = vi.fn();
    render(<OrderContactBlock contact={contact()} orderNumber="SO-00264" others={[]} sms={{ contacted: null, onOpen }} />);
    await userEvent.setup().click(screen.getByRole('button', { name: /pickup sms/i }));
    expect(onOpen).toHaveBeenCalledWith('+689-89530560');
  });

  it('is disabled with the reason when there is no number', () => {
    render(<OrderContactBlock contact={contact({ mobile: '' })} orderNumber="SO-00264" others={[]} sms={{ contacted: null, onOpen: vi.fn() }} />);
    const pill = screen.getByRole('button', { name: /pickup sms/i });
    expect(pill).toBeDisabled();
    expect(pill).toHaveAttribute('title', 'This client has no phone number');
  });

  it('turns into Contacted once an SMS went out, and still lets you send again', async () => {
    const onOpen = vi.fn();
    render(
      <OrderContactBlock
        contact={contact()}
        orderNumber="SO-00264"
        others={[]}
        sms={{ contacted: { at: '2026-11-10T08:20:00+00:00', by: 'paul' }, onOpen }}
      />,
    );
    expect(screen.queryByRole('button', { name: /pickup sms/i })).not.toBeInTheDocument();
    const pill = screen.getByRole('button', { name: /contacted ·/i });
    expect(pill.getAttribute('title')).toMatch(/^SMS by paul, /);
    await userEvent.setup().click(pill);
    expect(onOpen).toHaveBeenCalledWith('+689-89530560');
  });
});

function relayAnswers(response: () => Response) {
  const posted: unknown[] = [];
  server.use(
    http.post('http://localhost:8765/send', async ({ request }) => {
      posted.push(await request.json());
      return response();
    }),
  );
  return posted;
}

async function openAndSend() {
  render(<OrderSmsModal row={row} phone="+689-89530560" onClose={() => {}} />);
  await screen.findByDisplayValue(/tes filaments/);
  await userEvent.setup().click(screen.getByRole('button', { name: /send sms/i }));
}

describe('OrderSmsModal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the generated text and what it costs', async () => {
    vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue({ message: DRAFT, kind: 'filaments', partial: false, due: 0 });
    render(<OrderSmsModal row={row} phone="+689-89530560" onClose={() => {}} />);
    expect(await screen.findByDisplayValue(/tes filaments de la commande #1106/)).toBeInTheDocument();
    expect(screen.getByText(/Kelly SACAULT · \+689-89530560/)).toBeInTheDocument();
    expect(screen.getByTestId('order-sms-length')).toHaveTextContent(`${DRAFT.length} characters · 1 SMS`);
  });

  it('sends through the local relay, marks the order contacted and says so', async () => {
    vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue({ message: DRAFT, kind: 'filaments', partial: false, due: 0 });
    const posted = relayAnswers(() => new HttpResponse('sent'));
    const record = vi
      .spyOn(api, 'recordOrderSms')
      .mockResolvedValue({ ...row, contacted: { at: '2026-11-10T08:20:00+00:00', by: 'paul' } } as unknown as OrderBoardRow);
    await openAndSend();
    expect(await screen.findByText('SMS sent — order SO-00264 marked as contacted')).toBeInTheDocument();
    expect(posted).toEqual([{ phone: '+689-89530560', text: DRAFT }]);
    expect(record).toHaveBeenCalledWith('so264');
  });

  it('no relay on this machine records nothing and keeps the text', async () => {
    vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue({ message: DRAFT, kind: 'filaments', partial: false, due: 0 });
    relayAnswers(() => HttpResponse.error());
    const record = vi.spyOn(api, 'recordOrderSms');
    await openAndSend();
    expect(await screen.findByText(/sms relay not reachable/i)).toBeInTheDocument();
    expect(record).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByDisplayValue(/tes filaments/)).toBeInTheDocument());
  });
});
