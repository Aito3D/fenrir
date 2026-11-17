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
import { OrderSidePanel } from '../../../components/orders/OrderSidePanel';

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

  it('pops the Contacted pill when an SMS goes out while open, never on mount', () => {
    const sent = { at: '2026-11-10T08:20:00+00:00', by: 'paul' };
    const block = (contacted: typeof sent | null) => (
      <OrderContactBlock contact={contact()} orderNumber="SO-00264" others={[]} sms={{ contacted, onOpen: vi.fn() }} />
    );
    const mounted = render(block(sent));
    expect(screen.getByRole('button', { name: /contacted ·/i })).not.toHaveClass('animate-aito-pop-in');
    mounted.unmount();

    const { rerender } = render(block(null));
    rerender(block(sent));
    expect(screen.getByRole('button', { name: /contacted ·/i })).toHaveClass('animate-aito-pop-in');
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

  const url = 'https://pay.example/x';
  const linkDraft = { message: `${DRAFT.replace('\nAito3D', '')}\nLien de paiement : ${url}\nAito3D`, kind: 'filaments' as const, partial: false, due: 0, payment_link: { id: 4, url, amount: 3000 } };

  it('a draft holding the payment link records it as sent', async () => {
    vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue(linkDraft);
    relayAnswers(() => new HttpResponse('sent'));
    const record = vi.spyOn(api, 'recordOrderSms').mockResolvedValue(row as unknown as OrderBoardRow);
    await openAndSend();
    await waitFor(() => expect(record).toHaveBeenCalledWith('so264', 4));
  });

  it('a payment link edited out of the text is not recorded as sent', async () => {
    vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue(linkDraft);
    relayAnswers(() => new HttpResponse('sent'));
    const record = vi.spyOn(api, 'recordOrderSms').mockResolvedValue(row as unknown as OrderBoardRow);
    render(<OrderSmsModal row={row} phone="+689-89530560" onClose={() => {}} />);
    const user = userEvent.setup();
    const box = await screen.findByDisplayValue(/Lien de paiement/);
    await user.clear(box);
    await user.type(box, 'Bonjour');
    await user.click(screen.getByRole('button', { name: /send sms/i }));
    await waitFor(() => expect(record).toHaveBeenCalledWith('so264'));
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

  // Pinned: only a confirmed send reaches recordOrderSms, so a 'maybe sent' (504) does NOT mark the order contacted.
  it.each([
    ['a 504 from the relay warns the text may have gone, and records nothing', 504, /may already have gone/],
    ['any other relay refusal reads as a failed send, and records nothing', 500, /could not send the sms/i],
  ])('%s', async (_name, status, toast) => {
    vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue({ message: DRAFT, kind: 'filaments', partial: false, due: 0 });
    relayAnswers(() => new HttpResponse('nope', { status }));
    const record = vi.spyOn(api, 'recordOrderSms');
    await openAndSend();
    expect(await screen.findByText(toast)).toBeInTheDocument();
    expect(record).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue(/tes filaments/)).toBeInTheDocument();
  });

  it('Reset text puts the generated draft back after an edit and disables itself again', async () => {
    vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue({ message: DRAFT, kind: 'filaments', partial: false, due: 0 });
    render(<OrderSmsModal row={row} phone="+689-89530560" onClose={() => {}} />);
    const user = userEvent.setup();
    const box = await screen.findByDisplayValue(/tes filaments/);
    const reset = screen.getByRole('button', { name: /reset text/i });
    expect(reset).toBeDisabled();
    await user.clear(box);
    await user.type(box, 'Bonjour');
    expect(box).toHaveValue('Bonjour');
    expect(reset).toBeEnabled();
    await user.click(reset);
    expect(box).toHaveValue(DRAFT);
    expect(reset).toBeDisabled();
  });
});

describe('OrderSidePanel ?sms=1 deep link', () => {
  const draft = { message: DRAFT, kind: 'filaments' as const, partial: false, due: 0 };
  const panel = (o: { smsAllowed?: boolean; r?: OrderPanelRow; createInvoice?: unknown } = {}) =>
    render(
      <OrderSidePanel
        row={o.r ?? row}
        others={[]}
        canUpdate
        createInvoice={(o.createInvoice ?? { isPending: false, mutate: vi.fn() }) as never}
        smsAllowed={o.smsAllowed ?? true}
        editingTotal={null}
      />,
    );
  const visit = (qs: string) => window.history.pushState({}, '', `/orders?${qs}`);

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/');
  });

  it('opens the draft for this order with the mobile number, then drops only the sms flag', async () => {
    const getDraft = vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue(draft);
    visit('order=so264&sms=1');
    panel();
    expect(await screen.findByDisplayValue(/tes filaments/)).toBeInTheDocument();
    expect(screen.getByText(/Kelly SACAULT · \+689-89530560/)).toBeInTheDocument();
    expect(getDraft).toHaveBeenCalledWith('so264');
    expect(window.location.search).toBe('?order=so264');
  });

  it('falls back to the landline when there is no mobile', async () => {
    vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue(draft);
    visit('order=so264&sms=1');
    panel({ r: { ...row, contact: contact({ mobile: '', phone: '+689-40111222' }) } as OrderPanelRow });
    expect(await screen.findByText(/Kelly SACAULT · \+689-40111222/)).toBeInTheDocument();
  });

  it('with no phone opens nothing but still drops the flag', async () => {
    const getDraft = vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue(draft);
    visit('order=so264&sms=1');
    panel({ r: { ...row, contact: contact({ mobile: '', phone: '' }) } as OrderPanelRow });
    await waitFor(() => expect(window.location.search).toBe('?order=so264'));
    expect(getDraft).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue(/tes filaments/)).not.toBeInTheDocument();
  });

  it('when sms is not allowed opens nothing but still drops the flag', async () => {
    const getDraft = vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue(draft);
    visit('order=so264&sms=1');
    panel({ smsAllowed: false });
    await waitFor(() => expect(window.location.search).toBe('?order=so264'));
    expect(getDraft).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue(/tes filaments/)).not.toBeInTheDocument();
  });

  it('for another order does nothing, and leaves the URL as it is', async () => {
    const getDraft = vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue(draft);
    visit('order=so999&sms=1');
    panel();
    await screen.findByRole('button', { name: /pickup sms/i });
    expect(getDraft).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?order=so999&sms=1');
  });

  it('without the flag does nothing', async () => {
    const getDraft = vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue(draft);
    visit('order=so264');
    panel();
    await screen.findByRole('button', { name: /pickup sms/i });
    expect(getDraft).not.toHaveBeenCalled();
  });

  it('closing the draft removes it', async () => {
    vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue(draft);
    visit('order=so264&sms=1');
    panel();
    await screen.findByDisplayValue(/tes filaments/);
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByDisplayValue(/tes filaments/)).not.toBeInTheDocument());
  });

  it('Invoice now creates once with the chosen scope, ignoring a second click while it is in flight', async () => {
    server.use(
      http.get('*/order-board/orders/so264/invoice', () =>
        HttpResponse.json({
          available: true, credit: 0, drafts: [],
          packed: { units: 6, invoice_total: 40000, manual_reason: null },
          whole: { units: 10, invoice_total: 60955, manual_reason: null },
        }),
      ),
    );
    const mutate = vi.fn();
    const user = userEvent.setup();
    panel({
      r: { ...row, currency: 'XPF', unbilled_units: 0, lines: [{ remaining: 10, invoiced: 0 }], facts: {} } as unknown as OrderPanelRow,
      createInvoice: { isPending: false, mutate },
    });
    await user.click(screen.getByRole('button', { name: 'Invoice now' }));
    await user.click(await screen.findByRole('radio', { name: /The whole order/ }));
    const create = screen.getByRole('button', { name: 'Create in Zoho Books' });
    await user.click(create);
    await user.click(create);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ id: 'so264', applyCredit: true, scope: 'whole' }, expect.any(Object));
    mutate.mock.calls[0][1].onSettled();
  });
});
