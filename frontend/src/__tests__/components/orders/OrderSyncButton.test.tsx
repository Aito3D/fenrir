/** The per-order "Sync" button: what its toast says after a Books re-read. */
import { describe, it, expect, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render } from '../../utils';
import { OrderSyncButton } from '../../../components/orders/OrderSyncButton';

const URL = '/api/v1/order-board/orders/so1/sync';
const board = { rows: [], sync: {} };
const open = () => render(<OrderSyncButton orderId="so1" currency="USD" />);

describe('OrderSyncButton', () => {
  afterEach(() => server.resetHandlers());

  it('lists every change: money, state, filled and empty arrays', async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json({
          board,
          changes: [
            { field: 'total', from: 1, to: 12.5 },
            { field: 'state', from: 'unpaid', to: 'paid' },
            { field: 'state', from: 1, to: 2 },
            { field: 'invoices', from: [], to: ['INV-1', 'INV-2'] },
            { field: 'retainers', from: ['R-1'], to: [] },
            { field: 'left', from: 3, to: null },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: 'Sync' }));
    expect(
      await screen.findByText('Updated from Zoho: Total $12.50 · Payment paid · Payment 2 · Invoices INV-1, INV-2 · Deposits – · Left to pay –'),
    ).toBeInTheDocument();
  });

  it('says up to date when nothing changed', async () => {
    server.use(http.post(URL, () => HttpResponse.json({ board, changes: [] })));
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('button', { name: 'Sync' }));
    expect(await screen.findByText('Up to date in Zoho')).toBeInTheDocument();
  });

  it('is disabled while pending and toasts the failure', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => (release = r));
    server.use(
      http.post(URL, async () => {
        await gate;
        return HttpResponse.json({ detail: 'Books says no' }, { status: 502 });
      }),
    );
    const user = userEvent.setup();
    open();
    const button = screen.getByRole('button', { name: 'Sync' });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    release();
    expect(await screen.findByText('Books says no')).toBeInTheDocument();
    await waitFor(() => expect(button).toBeEnabled());
  });
});
