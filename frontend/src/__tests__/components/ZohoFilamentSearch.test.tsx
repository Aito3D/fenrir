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

function renderSearch(onSelect = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ZohoFilamentSearch onSelect={onSelect} currencySymbol="F" />
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
});
