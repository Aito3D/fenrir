/**
 * CalcInput lets a number field take a calculation ("4/2") and resolve it when
 * the user leaves the field. Plain numbers flow through live, calculations
 * only on blur/Enter, and an invalid calculation never reaches the owner.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalcInput } from '../../components/CalcInput';

function Harness({
  initial = '',
  onValueChange,
  normalize,
}: {
  initial?: string;
  onValueChange?: (raw: string) => void;
  normalize?: (n: number) => number;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <CalcInput
        aria-label="weight"
        value={value}
        normalize={normalize}
        onValueChange={(raw) => {
          setValue(raw);
          onValueChange?.(raw);
        }}
      />
      <output data-testid="committed">{value}</output>
      <button type="button">elsewhere</button>
    </>
  );
}

const input = () => screen.getByRole('textbox', { name: 'weight' });
const committed = () => screen.getByTestId('committed').textContent;

describe('CalcInput', () => {
  it('is a text field with a calculator keyboard toggle', () => {
    render(<Harness />);
    expect(input()).toHaveAttribute('type', 'text');
    expect(input()).toHaveAttribute('inputmode', 'decimal');
    expect(screen.getByRole('button', { name: /calculator keyboard/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('passes a plain number through while typing', async () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);
    await userEvent.type(input(), '12');
    expect(onValueChange).toHaveBeenLastCalledWith('12');
    expect(committed()).toBe('12');
  });

  it('turns a decimal comma into a dot for the owner', async () => {
    render(<Harness />);
    await userEvent.type(input(), '1,5');
    expect(committed()).toBe('1.5');
    expect(input()).toHaveValue('1,5');
  });

  it('holds a calculation as a draft with a live result, then commits it on blur', async () => {
    const onValueChange = vi.fn();
    render(<Harness initial="7" onValueChange={onValueChange} />);
    await userEvent.clear(input());
    onValueChange.mockClear();
    await userEvent.type(input(), '4/2');
    // "4" passes through, "4/" and "4/2" do not.
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('calc-preview')).toHaveTextContent('= 2');
    await userEvent.click(screen.getByText('elsewhere'));
    expect(committed()).toBe('2');
    expect(input()).toHaveValue('2');
    expect(screen.queryByTestId('calc-preview')).toBeNull();
  });

  it('commits a calculation on Enter without submitting the form', async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    function FormHarness() {
      const [value, setValue] = useState('');
      return (
        <form onSubmit={onSubmit}>
          <CalcInput aria-label="weight" value={value} onValueChange={setValue} />
          <output data-testid="committed">{value}</output>
        </form>
      );
    }
    render(<FormHarness />);
    await userEvent.type(input(), '1247-250{Enter}');
    expect(committed()).toBe('997');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input()).toHaveFocus();
  });

  it('applies normalize to the live result and to the committed value', async () => {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    render(<Harness normalize={round2} />);
    await userEvent.type(input(), '10/3');
    expect(screen.getByTestId('calc-preview')).toHaveTextContent('= 3.33');
    await userEvent.tab();
    expect(committed()).toBe('3.33');
  });

  it('keeps an invalid calculation, flags it and commits nothing', async () => {
    const onValueChange = vi.fn();
    render(<Harness initial="5" onValueChange={onValueChange} />);
    await userEvent.type(input(), '/');
    await userEvent.tab();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(committed()).toBe('5');
    expect(input()).toHaveValue('5/');
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid calculation');
  });

  it('Escape drops the draft and shows the committed value again', async () => {
    render(<Harness initial="5" />);
    await userEvent.type(input(), '*3');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(input()).toHaveValue('5');
    expect(committed()).toBe('5');
  });

  it('clearing the field passes an empty string', async () => {
    const onValueChange = vi.fn();
    render(<Harness initial="5" onValueChange={onValueChange} />);
    await userEvent.clear(input());
    expect(onValueChange).toHaveBeenLastCalledWith('');
  });

  it('the icon switches to the full keyboard and keeps focus on the field', async () => {
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: /calculator keyboard/i });
    await userEvent.click(toggle);
    expect(input()).toHaveAttribute('inputmode', 'text');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(input()).toHaveFocus();
    await userEvent.click(toggle);
    expect(input()).toHaveAttribute('inputmode', 'decimal');
  });

  it('toggling the keyboard mid-calculation does not commit it', async () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);
    await userEvent.type(input(), '2*');
    onValueChange.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /calculator keyboard/i }));
    expect(onValueChange).not.toHaveBeenCalled();
    expect(input()).toHaveValue('2*');
    expect(input()).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('an owner that validates its own state on blur sees the resolved result', async () => {
    const seen = vi.fn();
    function ValidatingOwner() {
      const [text, setText] = useState('');
      return <CalcInput aria-label="weight" value={text} onValueChange={setText} onBlur={() => seen(text)} />;
    }
    render(<ValidatingOwner />);
    await userEvent.type(input(), '1247-250');
    await userEvent.tab();
    expect(seen).toHaveBeenCalledWith('997');
  });

  it('shows the owner value when it changes while the field is idle', () => {
    const { rerender } = render(<CalcInput aria-label="weight" value="3" onValueChange={() => {}} />);
    rerender(<CalcInput aria-label="weight" value="8" onValueChange={() => {}} />);
    expect(input()).toHaveValue('8');
  });
});
