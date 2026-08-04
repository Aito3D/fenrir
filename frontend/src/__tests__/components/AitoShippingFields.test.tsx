import { useState } from 'react';
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

// ShippingFields is value-in/onChange-out and owns no shipment state of its
// own (see its docstring) — so, like every real caller (the drawer, the
// panel's edit mode), a test has to feed onChange's result back in as the
// next value or the component simply cannot show anything that only exists
// after an update: a freshly-picked island, a freshly-blurred field. A
// static `render` with a `vi.fn()` onChange leaves the component permanently
// uncontrolled, which used to push the component itself to grow a local
// mirror of `blurred` just to satisfy the test — exactly the kind of
// internal state it must not own. This harness is what makes that
// unnecessary: it is a closer match to production than a bare render would
// be, not just a testing convenience.
function Harness({
  initial,
  services = SERVICES,
  catalogueResolved = true,
  onChangeSpy,
}: {
  initial: ShippingDraft;
  services?: AitoShippingService[];
  catalogueResolved?: boolean;
  onChangeSpy?: (next: ShippingDraft) => void;
}) {
  const [value, setValue] = useState<ShippingDraft>(initial);
  return (
    <ShippingFields
      value={value}
      onChange={(next) => {
        onChangeSpy?.(next);
        setValue(next);
      }}
      services={services}
      catalogueResolved={catalogueResolved}
      currency="XPF"
    />
  );
}

function setup(overrides: Partial<ShippingDraft> = {}) {
  const onChange = vi.fn();
  const value = { ...emptyShippingDraft(null), ...overrides };
  render(<Harness initial={value} onChangeSpy={onChange} />);
  return { onChange, value };
}

// `getByLabelText(/rate/i)` is ambiguous once the reset button is on screen:
// its accessible name is "Back to the Zoho rate", which also matches /rate/i.
// The old, uncontrolled test never rendered that button mid-interaction, so
// the ambiguity stayed hidden. A `type=number` input has an implicit
// `spinbutton` role, which the button does not share, so this stays
// unambiguous under the controlled harness.
const getRateInput = () => screen.getByRole('spinbutton', { name: 'Rate' });

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
    expect(getRateInput()).toHaveValue(3200);
  });

  it('offers a reset once the price is edited, and no reset before', async () => {
    const { onChange } = setup({ island: 'rangiroa', service: 'tuamotu', price: 3200 });
    expect(screen.queryByRole('button', { name: /back to the zoho rate/i })).not.toBeInTheDocument();
    await userEvent.clear(getRateInput());
    await userEvent.type(getRateInput(), '5400');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ priceEdited: true }));
  });

  it('restores the Zoho rate on reset', async () => {
    const { onChange } = setup({ island: 'rangiroa', service: 'tuamotu', price: 5400, priceEdited: true });
    await userEvent.click(screen.getByRole('button', { name: /back to the zoho rate/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ price: 3200, priceEdited: false }));
    // The harness feeds the update back in, so the rendered field itself
    // must now show the restored value, not just the onChange payload.
    expect(getRateInput()).toHaveValue(3200);
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

  it('reports the reveal upward, not just locally: blurring first name shows the error and tells the caller', async () => {
    const { onChange } = setup({ firstName: '' });
    await userEvent.click(screen.getByLabelText(/recipient first name/i));
    await userEvent.tab();
    expect(await screen.findByText(/recipient name missing/i)).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ blurred: expect.objectContaining({ firstName: true }) }),
    );
  });
});
