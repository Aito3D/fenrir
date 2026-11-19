import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RevenueProductSearch } from '../../../components/revenue/RevenueProductSearch';
import type { RevenueProduct } from '../../../components/revenue/lib/types';
import i18n from '../../../i18n';

const product = (itemId: string, name: string, brand: string | null = null, totalHt = 1000): RevenueProduct => ({
  itemId,
  name,
  sku: `SKU-${itemId}`,
  totalHt,
  quantity: 1,
  lastDay: '2026-11-01',
  brand,
});

const CATALOGUE: RevenueProduct[] = [
  product('1', 'Support Mini starlink', 'Aito', 5000),
  product('2', 'Support v3 starlink', 'Aito', 3000),
  product('3', 'Sunlu PLA High Speed', 'Sunlu', 2000),
  product('4', 'eSUN PETG', 'eSUN', 4000),
];

function renderSearch(o: { products?: RevenueProduct[] | null; basket?: RevenueProduct[]; brands?: string[]; extra?: boolean } = {}) {
  const spies = { onAdd: vi.fn(), onRemove: vi.fn(), onClear: vi.fn(), onToggleBrand: vi.fn(), onClearBrands: vi.fn(), onClearExtra: vi.fn() };
  const view = render(
    <RevenueProductSearch
      products={o.products === undefined ? CATALOGUE : o.products}
      basket={o.basket ?? []}
      brands={new Set(o.brands ?? [])}
      extraChips={o.extra ? <span>extra chip</span> : null}
      {...spies}
    />,
  );
  return { ...spies, ...view };
}

const searchBox = () => screen.getByRole('searchbox', { name: 'Search for a product' });

describe('RevenueProductSearch — brand popover', () => {
  it('labels the trigger Brand, Brand: X or Brands (N)', () => {
    const { unmount } = renderSearch();
    expect(screen.getByRole('button', { name: /^Brand$/ })).toBeInTheDocument();
    unmount();
    const one = renderSearch({ brands: ['esun'] });
    expect(screen.getByRole('button', { name: /Brand: eSUN/ })).toBeInTheDocument();
    one.unmount();
    renderSearch({ brands: ['esun', 'sunlu'] });
    expect(screen.getByRole('button', { name: /Brands \(2\)/ })).toBeInTheDocument();
  });

  it('lists the brands heaviest first and toggles one', () => {
    const { onToggleBrand, onClearBrands } = renderSearch({ brands: ['esun'] });
    fireEvent.click(screen.getByRole('button', { name: /Brand: eSUN/ }));
    const list = screen.getByRole('listbox', { name: 'Brands' });
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Aito'),
      expect.stringContaining('eSUN'),
      expect.stringContaining('Sunlu'),
    ]);
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Brands: 3')).toBeInTheDocument();
    fireEvent.click(within(options[2]).getByRole('checkbox'));
    expect(onToggleBrand).toHaveBeenCalledWith('sunlu');
    fireEvent.click(within(screen.getByText('Brands: 3').parentElement!).getByRole('button', { name: 'Clear all' }));
    expect(onClearBrands).toHaveBeenCalled();
  });

  it('keeps a picked brand that vanished from the list as a removable chip', () => {
    const { onToggleBrand } = renderSearch({ brands: ['ghost'] });
    const chips = screen.getByLabelText('Selection');
    expect(within(chips).getByText('ghost')).toBeInTheDocument();
    fireEvent.click(within(chips).getByRole('button', { name: 'Remove brand ghost' }));
    expect(onToggleBrand).toHaveBeenCalledWith('ghost');
  });
});

describe('RevenueProductSearch — search', () => {
  it('waits for the products list', () => {
    renderSearch({ products: null });
    expect(searchBox()).toBeDisabled();
    expect(searchBox()).toHaveAttribute('placeholder', 'Loading products…');
  });

  it('needs two characters before listing matches', () => {
    renderSearch();
    fireEvent.change(searchBox(), { target: { value: 's' } });
    expect(screen.queryByRole('listbox', { name: 'Matching products' })).toBeNull();
    fireEvent.change(searchBox(), { target: { value: 'starlink' } });
    const list = screen.getByRole('listbox', { name: 'Matching products' });
    expect(within(list).getAllByRole('option')).toHaveLength(2);
    expect(within(list).getByText('Results: 2')).toBeInTheDocument();
  });

  it('shows 12 of the matches and adds them all', () => {
    const many = Array.from({ length: 15 }, (_, i) => product(`p${i}`, `Filament ${i}`));
    const { onAdd } = renderSearch({ products: many });
    fireEvent.change(searchBox(), { target: { value: 'filament' } });
    const list = screen.getByRole('listbox', { name: 'Matching products' });
    expect(within(list).getAllByRole('option')).toHaveLength(12);
    expect(within(list).getByText(/Results: 15 · 12 shown/)).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Add all 15 results' }));
    expect(onAdd.mock.calls[0][0]).toHaveLength(15);
    expect(searchBox()).toHaveValue('');
  });

  it('Enter adds the first match, Escape closes the list', () => {
    const { onAdd } = renderSearch();
    fireEvent.change(searchBox(), { target: { value: 'starlink' } });
    fireEvent.keyDown(searchBox(), { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Matching products' })).toBeNull();
    fireEvent.change(searchBox(), { target: { value: 'starlink' } });
    fireEvent.keyDown(searchBox(), { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith([CATALOGUE[0]]);
  });

  it('swallows mousedown on the list so a click does not blur the input first', () => {
    renderSearch();
    fireEvent.change(searchBox(), { target: { value: 'starlink' } });
    const row = within(screen.getByRole('listbox', { name: 'Matching products' })).getAllByRole('option')[0];
    expect(fireEvent.mouseDown(row)).toBe(false);
  });

  it('only matches the picked brands, and leaves out the basket', () => {
    const { onAdd } = renderSearch({ brands: ['aito'], basket: [CATALOGUE[0]] });
    fireEvent.change(searchBox(), { target: { value: 'su' } });
    const list = screen.getByRole('listbox', { name: 'Matching products' });
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(1);
    fireEvent.click(within(options[0]).getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith([CATALOGUE[1]]);
  });

  it('says when nothing matches', () => {
    renderSearch();
    fireEvent.change(searchBox(), { target: { value: 'zzz' } });
    expect(screen.getByText(/No Aito3D product matches/)).toBeInTheDocument();
  });
});

describe('RevenueProductSearch — chips', () => {
  it('removes a product and clears everything', () => {
    const { onRemove, onClear, onClearBrands, onClearExtra } = renderSearch({ basket: [CATALOGUE[2]], extra: true });
    const chips = screen.getByLabelText('Selection');
    expect(within(chips).getByText('extra chip')).toBeInTheDocument();
    expect(within(chips).getByText('Products: 1')).toBeInTheDocument();
    fireEvent.click(within(chips).getByRole('button', { name: 'Remove Sunlu PLA High Speed' }));
    expect(onRemove).toHaveBeenCalledWith('3');
    fireEvent.click(within(chips).getByRole('button', { name: 'Clear all' }));
    expect(onClear).toHaveBeenCalled();
    expect(onClearBrands).toHaveBeenCalled();
    expect(onClearExtra).toHaveBeenCalled();
  });

  it('renders no chip row when nothing is picked', () => {
    renderSearch();
    expect(screen.queryByLabelText('Selection')).toBeNull();
  });
});

describe('RevenueProductSearch — counted labels', () => {
  it('prints counts of 3 in Russian, never a key path', async () => {
    await i18n.changeLanguage('ru');
    try {
      const three = [product('a', 'Starlink A', 'X'), product('b', 'Starlink B', 'Y'), product('c', 'Starlink C', 'Z')];
      renderSearch({ products: [...three, product('d', 'Other D', 'W')], basket: [] });
      fireEvent.click(screen.getByRole('button', { name: 'Бренд' }));
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'starlink' } });
      expect(screen.getByText('Брендов: 4')).toBeInTheDocument();
      expect(screen.getByText('Результатов: 3')).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/revenue\./);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('shows each basket product with its HT amount', () => {
    renderSearch({ basket: [CATALOGUE[2], CATALOGUE[3], CATALOGUE[0]] });
    const chips = screen.getByLabelText('Selection');
    expect(within(chips).getByText('Products: 3')).toBeInTheDocument();
    expect(within(chips).getByText('2.000 FCP')).toHaveClass('tabular-nums');
  });
});
