/** The parcel-label dialog of an opened order. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render } from '../../utils';
import type { OrderPanelRow } from '../../../api/client';
import { OrderShippingLabelModal } from '../../../components/orders/OrderShippingLabelModal';

const build = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/shippingLabel', () => ({ buildShippingLabelHtml: build }));

const services = {
  services: [
    { key: 'sea', name: 'Sea freight', islands: [{ key: 'bor', label: 'Bora Bora' }, { key: 'hua', label: 'Huahine' }] },
    { key: 'air', name: 'Air freight', islands: [{ key: 'bor', label: 'Raiatea' }] },
  ],
};
const row = (o: Partial<OrderPanelRow> = {}) =>
  ({ id: 'so1', number: 'SO-00412', customer: 'Lycée de Taravao', payment: null, contact: null, ...o }) as OrderPanelRow;
const inv = (number: string) => ({ id: number, number }) as never;
const payment = (...numbers: string[]) => ({ invoices: numbers.map(inv) }) as OrderPanelRow['payment'];
const open = (r: OrderPanelRow, onClose = vi.fn()) => {
  server.use(http.get('/api/v1/aito/shipping/services', () => HttpResponse.json(services)));
  return render(<OrderShippingLabelModal row={r} onClose={onClose} />);
};
const printBtn = () => screen.getByRole('button', { name: 'Print shipping label' });
const pick = async (user: ReturnType<typeof userEvent.setup>, service = 'sea', island = 'Bora Bora') => {
  await screen.findByRole('option', { name: 'Sea freight' });
  await user.selectOptions(screen.getByLabelText('Shipping service'), service);
  await user.selectOptions(screen.getByLabelText('Destination island'), island);
};

describe('OrderShippingLabelModal', () => {
  beforeEach(() => {
    build.mockReset().mockReturnValue('<html></html>');
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => server.resetHandlers());

  it('prefills the contact name and prefers the mobile over the phone', async () => {
    open(row({ contact: { name: 'Moana', mobile: '87111111', phone: '40222222' } as OrderPanelRow['contact'] }));
    expect(screen.getByLabelText('Recipient')).toHaveValue('Moana');
    expect(screen.getByLabelText('Recipient phone')).toHaveValue('87111111');
  });

  it('falls back to the phone, then to the customer name and an empty phone', () => {
    const { unmount } = open(row({ contact: { name: 'Moana', mobile: '', phone: '40222222' } as OrderPanelRow['contact'] }));
    expect(screen.getByLabelText('Recipient phone')).toHaveValue('40222222');
    unmount();
    open(row());
    expect(screen.getByLabelText('Recipient')).toHaveValue('Lycée de Taravao');
    expect(screen.getByLabelText('Recipient phone')).toHaveValue('');
  });

  it('references the newest invoice, else the order number', () => {
    const { unmount } = open(row({ payment: payment('FAC-1', 'FAC-2') }));
    expect(screen.getByText('SO-00412 · FAC-2')).toBeInTheDocument();
    unmount();
    open(row());
    expect(screen.getByText('SO-00412 · SO-00412')).toBeInTheDocument();
  });

  it('keeps Print disabled until a service and an island are chosen, and the island list follows the service', async () => {
    const user = userEvent.setup();
    open(row());
    await screen.findByRole('option', { name: 'Sea freight' });
    const island = screen.getByLabelText('Destination island');
    expect(island).toBeDisabled();
    expect(printBtn()).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Shipping service'), 'sea');
    expect(island).toBeEnabled();
    expect(screen.getByRole('option', { name: 'Huahine' })).toBeInTheDocument();
    expect(printBtn()).toBeDisabled();
    await user.selectOptions(island, 'Bora Bora');
    expect(printBtn()).toBeEnabled();
    await user.selectOptions(screen.getByLabelText('Shipping service'), 'air');
    expect(island).toHaveValue('');
    expect(screen.queryByRole('option', { name: 'Huahine' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Raiatea' })).toBeInTheDocument();
    expect(printBtn()).toBeDisabled();
  });

  it('keeps Print disabled when the recipient is blank', async () => {
    const user = userEvent.setup();
    open(row());
    await pick(user);
    await user.clear(screen.getByLabelText('Recipient'));
    expect(printBtn()).toBeDisabled();
  });

  it('builds the label from trimmed values', async () => {
    const user = userEvent.setup();
    open(row({ payment: payment('FAC-9') }));
    await pick(user);
    await user.clear(screen.getByLabelText('Recipient'));
    await user.type(screen.getByLabelText('Recipient'), '  Moana  ');
    await user.type(screen.getByLabelText('Recipient phone'), ' 87111111 ');
    await user.click(printBtn());
    await waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    const [label] = build.mock.calls[0];
    expect(label).toEqual({
      recipientName: 'Moana', recipientPhone: '(+689) 87.11.11.11', island: 'Bora Bora', serviceName: 'Sea freight', reference: 'FAC-9',
    });
    expect(build.mock.calls[0][1]).toMatch(/^http/);
  });

  it('sends an empty phone as an empty string', async () => {
    const user = userEvent.setup();
    open(row());
    await pick(user);
    await user.click(printBtn());
    await waitFor(() => expect(build).toHaveBeenCalled());
    expect(build.mock.calls[0][0]).toMatchObject({ recipientName: 'Lycée de Taravao', recipientPhone: '', reference: 'SO-00412' });
  });

  it('toasts the print-failed message when the label cannot be built', async () => {
    build.mockImplementation(() => { throw new Error('boom'); });
    const user = userEvent.setup();
    open(row());
    await pick(user);
    await user.click(printBtn());
    expect(await screen.findByText('Could not prepare the shipping label')).toBeInTheDocument();
  });
});
