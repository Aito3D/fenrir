/** The card's tax in the Billing panel: pick a rate, keep the price before tax or the total, remember it for the
 *  customer account. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { TaxRow } from '../../components/aito/TaxRow';
import { api } from '../../api/client';
import type { AitoProject, AitoTaxes } from '../../api/client';

const TAXES: AitoTaxes = {
  default_tax_id: 'T13',
  customer_tax_id: null,
  taxes: [
    { tax_id: 'T13', name: 'TVA collectée sur Services', pct: 13 },
    { tax_id: 'T1', name: 'TVA collectée 1%', pct: 1 },
    { tax_id: 'T0', name: 'Franchise', pct: 0 },
  ],
};

const card = (o: Partial<AitoProject> = {}) =>
  ({ id: 7, client_id: 'c1', client_name: 'COJ TAHITI 2027', tasks_total: 9500, shipping_price: null, quote_invoiced: false,
    version: 3, tax_id: null, tax_pct: null, ...o }) as AitoProject;

describe('TaxRow', () => {
  afterEach(() => vi.restoreAllMocks());

  it('previews each rate and applies tax-free keeping the price before tax, remembered for the customer account', async () => {
    vi.spyOn(api, 'getAitoTaxes').mockResolvedValue(TAXES);
    const put = vi.spyOn(api, 'setAitoProjectTax').mockResolvedValue(card({ tax_id: 'T0', tax_pct: 0 }));
    const user = userEvent.setup();
    render(<TaxRow project={card()} canUpdate currency="XPF" />);
    expect(screen.getByText('Default rate')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Standard/ }));
    const free = await screen.findByRole('radio', { name: /Franchise/ });
    // 9 500 incl. 13% is 8 407 before tax: tax-free, the client pays 8 407; at 1%, 8 491.
    expect(free.closest('label')).toHaveTextContent(/8.407/);
    expect(screen.getByRole('radio', { name: /TVA collectée 1%/ }).closest('label')).toHaveTextContent(/8.491/);
    await user.click(free);
    await user.click(screen.getByRole('checkbox', { name: /Use for COJ TAHITI 2027's next cards/ }));
    await user.click(screen.getByRole('button', { name: 'Apply to the quote' }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(7, { tax_id: 'T0', keep_price_before_tax: true, remember: true, expected_version: 3 }),
    );
  });

  it('keeping the price the client pays shows the same total for every rate', async () => {
    vi.spyOn(api, 'getAitoTaxes').mockResolvedValue(TAXES);
    const user = userEvent.setup();
    render(<TaxRow project={card()} canUpdate currency="XPF" />);
    await user.click(screen.getByRole('button', { name: /Standard/ }));
    await user.click(await screen.findByRole('button', { name: 'Price the client pays' }));
    expect(screen.getByRole('radio', { name: /Franchise/ }).closest('label')).toHaveTextContent(/9.500/);
  });

  it("names the customer account's default and locks once invoiced", async () => {
    vi.spyOn(api, 'getAitoTaxes').mockResolvedValue({ ...TAXES, customer_tax_id: 'T0' });
    const { unmount } = render(<TaxRow project={card({ tax_id: 'T0', tax_pct: 0 })} canUpdate currency="XPF" />);
    expect(await screen.findByText('COJ TAHITI 2027 default')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tax-free/ })).toBeEnabled();
    unmount();
    render(<TaxRow project={card({ tax_id: 'T1', tax_pct: 1, quote_invoiced: true })} canUpdate currency="XPF" />);
    expect(screen.getByRole('button', { name: /1%/ })).toBeDisabled();
    expect(screen.getByText(/the invoice keeps its tax/)).toBeInTheDocument();
  });
});
