import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { QuantityInput, DiscountSelect } from '../../components/aito/servicePriceFields';

describe('QuantityInput', () => {
  // Not userEvent.clear + userEvent.type: this is a bare (uncontrolled-echo)
  // render, so React re-syncs the DOM back to the unchanged `value` prop
  // after the clear's change event — the same append quirk documented on the
  // test below, just triggered one keystroke earlier. fireEvent.change sets
  // the field's value directly, the same way AitoTaskStepFields.test.tsx
  // tests this component's inline predecessor.
  it('floors at 1 rather than accepting 0', () => {
    const onChange = vi.fn();
    render(<QuantityInput id="q" value={3} onChange={onChange} />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('reports an integer for a fractional entry', async () => {
    const onChange = vi.fn();
    render(<QuantityInput id="q" value={1} onChange={onChange} />);
    await userEvent.type(screen.getByRole('spinbutton'), '2');
    expect(onChange).toHaveBeenLastCalledWith(12);
  });

  // The reason this field holds a draft at all: floor-on-every-keystroke put
  // "1" back the instant the field was emptied, so raising a count to 2 meant
  // typing "12" and deleting the leading 1.
  it('can be emptied, so a new count replaces the old one', async () => {
    const onChange = vi.fn();
    render(<QuantityInput id="q" value={1} onChange={onChange} />);
    const field = screen.getByRole('spinbutton');
    await userEvent.clear(field);
    expect(field).toHaveValue(null);
    await userEvent.type(field, '2');
    expect(onChange).toHaveBeenLastCalledWith(2);
  });

  // Leaving the field blank is not a count of zero: the stored value comes
  // back on blur, and no change is reported for the empty pass through.
  it('restores the stored count when left empty', async () => {
    const onChange = vi.fn();
    render(<QuantityInput id="q" value={3} onChange={onChange} />);
    const field = screen.getByRole('spinbutton');
    await userEvent.clear(field);
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(field).toHaveValue(3);
  });
});

describe('DiscountSelect', () => {
  it('reports null for the em-dash option, never 0', async () => {
    const onChange = vi.fn();
    render(<DiscountSelect id="d" value={10} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole('combobox'), '');
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('reports the chosen percent as a number', async () => {
    const onChange = vi.fn();
    render(<DiscountSelect id="d" value={null} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole('combobox'), '15');
    expect(onChange).toHaveBeenCalledWith(15);
  });
});
