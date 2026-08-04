import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ShippingFields } from '../../components/aito/ShippingFields';
import { emptyShippingDraft } from '../../utils/shippingDraft';
import type { ShippingDraft } from '../../utils/shippingDraft';
import type { AitoShippingService } from '../../api/client';

const SERVICES: AitoShippingService[] = [
  {
    key: 'tuamotu',
    name: 'Livraison Avion Tuamotu',
    rate: 3200,
    islands: [{ key: 'rangiroa', label: 'Rangiroa' }],
  },
];

function setup(overrides: Partial<ShippingDraft> = {}) {
  const onChange = vi.fn();
  const value = { ...emptyShippingDraft(null), ...overrides };
  render(
    <ShippingFields value={value} onChange={onChange} services={SERVICES} catalogueResolved currency="XPF" />,
  );
  return { onChange, value };
}

describe('ShippingFields', () => {
  it('resolves the service and seeds the price when an island is picked', async () => {
    const { onChange } = setup();
    await userEvent.click(screen.getByRole('combobox', { name: /destination island/i }));
    await userEvent.click(screen.getByRole('option', { name: 'Rangiroa' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ island: 'rangiroa', service: 'tuamotu', price: 3200, priceEdited: false }),
    );
  });

  it('shows the matched service and its rate', () => {
    setup({ island: 'rangiroa', service: 'tuamotu', price: 3200 });
    expect(screen.getByText('Livraison Avion Tuamotu')).toBeInTheDocument();
    expect(screen.getByLabelText(/rate/i)).toHaveValue(3200);
  });

  it('offers a reset once the price is edited, and no reset before', async () => {
    const { onChange } = setup({ island: 'rangiroa', service: 'tuamotu', price: 3200 });
    expect(screen.queryByRole('button', { name: /back to the zoho rate/i })).not.toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText(/rate/i));
    await userEvent.type(screen.getByLabelText(/rate/i), '5400');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ priceEdited: true }));
  });

  it('restores the Zoho rate on reset', async () => {
    const { onChange } = setup({ island: 'rangiroa', service: 'tuamotu', price: 5400, priceEdited: true });
    await userEvent.click(screen.getByRole('button', { name: /back to the zoho rate/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ price: 3200, priceEdited: false }));
  });

  it('asks for a price when Zoho gave none', () => {
    render(
      <ShippingFields
        value={{ ...emptyShippingDraft(null), island: 'rangiroa', service: 'tuamotu' }}
        onChange={vi.fn()}
        services={[{ ...SERVICES[0], rate: null }]}
        catalogueResolved={false}
        currency="XPF"
      />,
    );
    expect(screen.getByText(/no rate from zoho/i)).toBeInTheDocument();
  });

  it('shows an error only after a field has been left', async () => {
    setup({ firstName: '' });
    expect(screen.queryByText(/recipient name missing/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/recipient first name/i));
    await userEvent.tab();
    expect(await screen.findByText(/recipient name missing/i)).toBeInTheDocument();
  });
});
