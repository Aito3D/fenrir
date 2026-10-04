import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ApplyDepositModal } from '../../components/aito/ApplyDepositModal';
import { QueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { formatMoney } from '../../utils/pricing';

const DATA = {
  invoice: { id: 'INV1', number: 'FA-26-4458', balance: 14000, currency_code: 'XPF' },
  deposits: [
    { id: 'R1', number: 'RET26-00301', applicable: 7000, total: 7000 },
    { id: 'R2', number: 'RET26-00302', applicable: 20000, total: 20000 },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe('ApplyDepositModal', () => {
  it('preselects the oldest deposit and prefills what it can cover', () => {
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={() => {}} />);
    expect(screen.getByRole('radio', { name: /RET26-00301/ })).toBeChecked();
    expect(screen.getByLabelText('Amount to apply')).toHaveValue('7000');
    expect(screen.getByText('Uses the whole deposit')).toBeInTheDocument();
  });

  it('re-prefills when another deposit is chosen', async () => {
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('radio', { name: /RET26-00302/ }));
    expect(screen.getByLabelText('Amount to apply')).toHaveValue('14000');
    expect(screen.getByText('Pays the invoice in full')).toBeInTheDocument();
  });

  it('blocks an amount above the cap', async () => {
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={() => {}} />);
    const input = screen.getByLabelText('Amount to apply');
    await userEvent.clear(input);
    await userEvent.type(input, '9000');
    await userEvent.tab();
    expect(screen.getByText(/At most/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Apply/ })).toBeDisabled();
  });

  it('applies and closes', async () => {
    const spy = vi.spyOn(api, 'applyAitoInvoiceDeposit').mockResolvedValue({} as never);
    const onClose = vi.fn();
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(12, { invoice_id: 'INV1', retainer_id: 'R1', amount: 7000 }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('disables the confirm button while the request is in flight (no double submit)', async () => {
    let resolve: (v: never) => void = () => {};
    const spy = vi
      .spyOn(api, 'applyAitoInvoiceDeposit')
      .mockImplementation(() => new Promise((r) => { resolve = r as never; }));
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={() => {}} />);
    const button = screen.getByRole('button', { name: /^Apply/ });
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await userEvent.click(button);
    expect(spy).toHaveBeenCalledTimes(1);
    resolve({} as never);
  });

  it('keeps the modal open with the translated cap on a 409, not the server text', async () => {
    // throwApiError turns {code, message, cap} into message + code + detail.
    vi.spyOn(api, 'applyAitoInvoiceDeposit').mockRejectedValue(
      new ApiError('At most 3000.00 can be applied', 409, 'amount_too_high', { cap: 3000 }),
    );
    const onClose = vi.fn();
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    // formatMoney uses narrow no-break spaces, which toHaveTextContent normalises away.
    expect((await screen.findByRole('alert')).textContent).toBe(`At most ${formatMoney(3000, 'XPF')}`);
    expect(screen.queryByText(/can be applied/)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says to check the invoice when the outcome is unknown', async () => {
    vi.spyOn(api, 'applyAitoInvoiceDeposit').mockRejectedValue(
      new ApiError('The deposit may have been applied; check the invoice before retrying.', 502, 'outcome_unknown', {
        code: 'outcome_unknown',
      }),
    );
    const onClose = vi.fn();
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The deposit may have been applied. Check the invoice in Zoho Books before trying again.',
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('re-reads the deposits and the invoice after any error', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    vi.spyOn(api, 'applyAitoInvoiceDeposit').mockRejectedValue(new ApiError('Books is down', 502));
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Books is down');
    const keys = invalidate.mock.calls.map(([f]) => (f as { queryKey?: unknown[] } | undefined)?.queryKey);
    expect(keys).toContainEqual(['aito-invoice-deposits', 12]);
    expect(keys).toContainEqual(['aito-invoice', 12]);
  });

  it('falls back to the generic sentence for a non-API error', async () => {
    vi.spyOn(api, 'applyAitoInvoiceDeposit').mockRejectedValue(new TypeError('Failed to fetch'));
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The deposit could not be applied');
  });

  it('closes instead of crashing when a refetch empties the deposits', () => {
    const onClose = vi.fn();
    const { rerender } = render(<ApplyDepositModal projectId={12} data={DATA} onClose={onClose} />);
    rerender(<ApplyDepositModal projectId={12} data={{ ...DATA, deposits: [] }} onClose={onClose} />);
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes instead of crashing when a refetch drops the invoice', () => {
    const onClose = vi.fn();
    const { rerender } = render(<ApplyDepositModal projectId={12} data={DATA} onClose={onClose} />);
    rerender(<ApplyDepositModal projectId={12} data={{ invoice: null, deposits: [] }} onClose={onClose} />);
    expect(onClose).toHaveBeenCalled();
  });

  it('reselects the first deposit when the chosen one disappears', async () => {
    const { rerender } = render(<ApplyDepositModal projectId={12} data={DATA} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('radio', { name: /RET26-00302/ }));
    rerender(<ApplyDepositModal projectId={12} data={{ ...DATA, deposits: [DATA.deposits[0]] }} onClose={() => {}} />);
    expect(screen.getByRole('radio', { name: /RET26-00301/ })).toBeChecked();
    expect(screen.getByLabelText('Amount to apply')).toHaveValue('7000');
  });

  it('does not close on overlay click or X while the request is in flight', async () => {
    vi.spyOn(api, 'applyAitoInvoiceDeposit').mockImplementation(() => new Promise(() => {}));
    const onClose = vi.fn();
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await userEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    await new Promise((r) => setTimeout(r, 250));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('rounds a typed amount to cents before sending', async () => {
    const spy = vi.spyOn(api, 'applyAitoInvoiceDeposit').mockResolvedValue({} as never);
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={() => {}} />);
    const input = screen.getByLabelText('Amount to apply');
    await userEvent.clear(input);
    await userEvent.type(input, '100.456');
    await userEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, expect.objectContaining({ amount: 100.46 })));
  });
});
