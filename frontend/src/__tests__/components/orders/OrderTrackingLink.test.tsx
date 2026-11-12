/** The "copy tracking link" chip among an order's reference chips. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { OrderPanelRow } from '../../../api/client';
import { server } from '../../mocks/server';
import { render } from '../../utils';
import { OrderRefChips } from '../../../components/orders/OrderRefChips';
import * as clipboard from '../../../utils/clipboard';

const row = { id: 'so1', number: 'SO-00425', zoho_url: null, facts: { channel: '', reference: '', shopify_order: '', quote_number: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null } } as unknown as OrderPanelRow;

function mockLink(tracking_url: string | null, status = 200) {
  const seen: string[] = [];
  server.use(
    http.get('/api/v1/order-board/orders/:id/tracking-link', ({ params }) => {
      seen.push(String(params.id));
      return HttpResponse.json(status === 200 ? { tracking_url } : { detail: 'x' }, { status });
    }),
  );
  return seen;
}

afterEach(() => vi.restoreAllMocks());

describe('OrderRefChips tracking link', () => {
  it('fetches the link of this order and copies it', async () => {
    const copy = vi.spyOn(clipboard, 'copyTextToClipboard').mockResolvedValue(true);
    vi.spyOn(clipboard, 'writeClipboardFromPromise').mockReturnValue(null);
    const seen = mockLink('https://suivi.example/t/o/K7F3XQ');
    render(<OrderRefChips row={row} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy tracking link' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('https://suivi.example/t/o/K7F3XQ'));
    expect(seen).toEqual(['so1']);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('a write started inside the click is not repeated', async () => {
    const copy = vi.spyOn(clipboard, 'copyTextToClipboard').mockResolvedValue(true);
    vi.spyOn(clipboard, 'writeClipboardFromPromise').mockReturnValue(Promise.resolve());
    mockLink('https://suivi.example/t/o/K7F3XQ');
    render(<OrderRefChips row={row} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy tracking link' }));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(copy).not.toHaveBeenCalled();
  });

  it('without the external URL it points at Settings and copies nothing', async () => {
    const copy = vi.spyOn(clipboard, 'copyTextToClipboard').mockResolvedValue(true);
    vi.spyOn(clipboard, 'writeClipboardFromPromise').mockImplementation(() => Promise.reject(new Error('empty')));
    mockLink(null);
    render(<OrderRefChips row={row} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy tracking link' }));
    expect(await screen.findByText('Set the external URL in Settings to enable tracking links')).toBeInTheDocument();
    expect(copy).not.toHaveBeenCalled();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });

  it('says so when the link cannot be fetched or the browser refuses the copy', async () => {
    vi.spyOn(clipboard, 'writeClipboardFromPromise').mockReturnValue(null);
    vi.spyOn(clipboard, 'copyTextToClipboard').mockResolvedValue(false);
    mockLink('https://suivi.example/t/o/K7F3XQ');
    const view = render(<OrderRefChips row={row} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy tracking link' }));
    expect(await screen.findByText('Could not copy the tracking link')).toBeInTheDocument();
    view.unmount();
    mockLink(null, 500);
    render(<OrderRefChips row={row} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy tracking link' }));
    expect(await screen.findByText('Error loading data')).toBeInTheDocument();
  });
});
