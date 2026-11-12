/** The order's watch toggle: reads the caller's watch, PUT to watch, DELETE to stop. */
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render } from '../../utils';
import { OrderWatchButton } from '../../../components/orders/OrderWatchButton';

const URL = '/api/v1/order-board/orders/so1/watch';

describe('OrderWatchButton', () => {
  it('shows the stored state and toggles it both ways', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    server.use(
      http.get(URL, () => HttpResponse.json({ watching: false })),
      http.put(URL, () => { calls.push('PUT'); return HttpResponse.json({ watching: true }); }),
      http.delete(URL, () => { calls.push('DELETE'); return HttpResponse.json({ watching: false }); }),
    );
    render(<OrderWatchButton orderId="so1" />);
    const off = await screen.findByRole('button', { name: 'Watch' });
    expect(off).toHaveAttribute('aria-pressed', 'false');
    await user.click(off);
    const on = await screen.findByRole('button', { name: 'Watching' });
    expect(on).toHaveAttribute('aria-pressed', 'true');
    await user.click(on);
    await screen.findByRole('button', { name: 'Watch' });
    expect(calls).toEqual(['PUT', 'DELETE']);
  });

  it('renders nothing until the state is known, and a failed toggle keeps it', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(URL, () => HttpResponse.json({ watching: true })),
      http.delete(URL, () => HttpResponse.json({ detail: 'x' }, { status: 500 })),
    );
    render(<OrderWatchButton orderId="so1" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Watching' }));
    expect(await screen.findByText('Error')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Watching' })).toBeEnabled());
  });
});
