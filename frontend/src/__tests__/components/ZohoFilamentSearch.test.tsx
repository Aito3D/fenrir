import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ZohoFilamentSearch } from '@/components/calculator/ZohoFilamentSearch';
import { api } from '@/api/client';

const PRODUCTS = [
  {
    item_id: '66407000008022673',
    name: 'Bambu Lab - ABS-GF - Bleu (Blue) - 1.75mm - 1kg',
    sku: 'B50-B0-1.75-1000-SPL',
    brand: 'Bambu Lab',
    material: 'ABS-GF',
    colour: 'Bleu (Blue)',
    spool_weight_kg: 1,
    weight_inferred: false,
    dealer_price: 1866,
    cost_per_kg: 1866,
    has_price: true,
  },
  {
    item_id: '66407000008023724',
    name: 'Bambu Lab - ABS-GF - Blanc (White) - 1.75mm - 1kg',
    sku: 'B50-W0-1.75-1000-SPL',
    brand: 'Bambu Lab',
    material: 'ABS-GF',
    colour: 'Blanc (White)',
    spool_weight_kg: 1,
    weight_inferred: false,
    dealer_price: 0,
    cost_per_kg: 0,
    has_price: false,
  },
];

function renderSearch(onSelect = vi.fn(), currency = 'USD') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ZohoFilamentSearch onSelect={onSelect} currency={currency} />
    </QueryClientProvider>,
  );
  return onSelect;
}

describe('ZohoFilamentSearch', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('searches Zoho and lists matching products', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockResolvedValue(PRODUCTS);
    renderSearch();
    await userEvent.type(screen.getByRole('combobox'), 'abs-gf');
    await waitFor(() => expect(api.searchZohoFilaments).toHaveBeenCalled());
    expect(await screen.findByText(/Bleu \(Blue\)/)).toBeInTheDocument();
  });

  it('flags products with no dealer price', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockResolvedValue(PRODUCTS);
    renderSearch();
    await userEvent.type(screen.getByRole('combobox'), 'abs-gf');
    expect(await screen.findByText(/no dealer price/i)).toBeInTheDocument();
  });

  it('hands the chosen product to onSelect', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockResolvedValue(PRODUCTS);
    const onSelect = renderSearch();
    await userEvent.type(screen.getByRole('combobox'), 'abs-gf');
    await userEvent.click(await screen.findByText(/Bleu \(Blue\)/));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ item_id: '66407000008022673' }));
  });

  it('does not query Zoho for a blank search', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockResolvedValue([]);
    renderSearch();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api.searchZohoFilaments).not.toHaveBeenCalled();
  });

  it('shows an error row when Zoho is unreachable', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockRejectedValue(new Error('502'));
    renderSearch();
    await userEvent.type(screen.getByRole('combobox'), 'abs');
    expect(await screen.findByText(/could not reach zoho/i)).toBeInTheDocument();
  });

  // F1 — aria-expanded must track whether the popup is actually rendered
  // (i.e. whether a search is "enabled"), not whether it happens to have
  // result rows. The no-results status row is visibly on screen too.
  it('reports aria-expanded while the popup shows a status row, not just result rows', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockResolvedValue([]);
    renderSearch();
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'zzz');
    await screen.findByText(/no matching zoho filament/i);
    expect(input).toHaveAttribute('aria-expanded', 'true');
  });

  // F2 — formatMoney keys its zero-decimal-currency detection off the ISO
  // *code*, not a display symbol. XPF is a real, zero-decimal user currency;
  // passing anything but the code here must not print spurious decimals.
  it('formats prices for a zero-decimal currency (XPF) with no decimal part', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockResolvedValue(PRODUCTS);
    renderSearch(vi.fn(), 'XPF');
    await userEvent.type(screen.getByRole('combobox'), 'abs-gf');
    const price = await screen.findByText(/1[\s\u2009\u202f\u00a0]?866/);
    expect(price.textContent).not.toMatch(/1[\s\u2009\u202f\u00a0]?866\.00/);
  });

  // F3 — the debounce exists specifically to avoid one Zoho request per
  // keystroke. Assert an exact call count, not just "was called".
  it('debounces so a multi-character query fires exactly one search', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockResolvedValue(PRODUCTS);
    renderSearch();
    await userEvent.type(screen.getByRole('combobox'), 'abs-gf');
    await waitFor(() => expect(api.searchZohoFilaments).toHaveBeenCalledTimes(1));
    // Give any extra pending timers a chance to fire so a broken/absent
    // debounce (one call per keystroke) would be caught here too.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api.searchZohoFilaments).toHaveBeenCalledTimes(1);
  });

  // F4 — the shared `renderSearch` helper's QueryClient defaults to
  // retry:false, which would mask the component losing its own retry:false
  // on the query. Build a client here with production's retry:1 default
  // (frontend/src/App.tsx) so it's the component's own setting under test.
  it('does not retry a failed search even when the QueryClient default allows retries', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockRejectedValue(new Error('502'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <ZohoFilamentSearch onSelect={vi.fn()} currency="USD" />
      </QueryClientProvider>,
    );
    await userEvent.type(screen.getByRole('combobox'), 'abs');
    expect(await screen.findByText(/could not reach zoho/i)).toBeInTheDocument();
    expect(api.searchZohoFilaments).toHaveBeenCalledTimes(1);
  });
});
