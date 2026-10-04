import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ApplyDepositModal } from '../../components/aito/ApplyDepositModal';
import { api, ApiError } from '../../api/client';

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

  it('keeps the modal open with the server message on a 409', async () => {
    // throwApiError turns {code, message, cap} into message + code + detail.
    vi.spyOn(api, 'applyAitoInvoiceDeposit').mockRejectedValue(
      new ApiError('At most 3000.00 can be applied', 409, 'amount_too_high', { cap: 3000 }),
    );
    const onClose = vi.fn();
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    expect(await screen.findByText(/At most 3000/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
