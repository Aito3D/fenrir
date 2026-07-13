/**
 * Tests for the SearchableSelect combobox, focused on keyboard navigation:
 * ArrowUp/ArrowDown move the highlight (with wrap-around), Enter selects.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchableSelect } from '../../components/SearchableSelect';

const OPTIONS = [
  { value: 'Bambu Lab', label: 'Bambu Lab' },
  { value: 'Creality', label: 'Creality' },
  { value: 'SUNLU', label: 'SUNLU' },
];

function setup(props: Partial<React.ComponentProps<typeof SearchableSelect>> = {}) {
  const onChange = vi.fn();
  render(
    <SearchableSelect value="" onChange={onChange} options={OPTIONS} allowCustom={false} {...props} />,
  );
  return { onChange, input: screen.getByRole('combobox') };
}

describe('SearchableSelect keyboard navigation', () => {
  it('opens on focus and highlights options with ArrowDown', async () => {
    const user = userEvent.setup();
    const { input } = setup();

    await user.click(input);
    expect(screen.getByRole('option', { name: 'Bambu Lab' })).toBeInTheDocument();

    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', expect.stringContaining('-opt-0'));
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', expect.stringContaining('-opt-1'));
  });

  it('selects the highlighted option with Enter and closes', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();

    await user.click(input);
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(onChange).toHaveBeenCalledWith('Creality');
    expect(screen.queryByRole('option', { name: 'Creality' })).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('wraps around at both ends', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();

    await user.click(input);
    // ArrowUp from no highlight wraps to the last option
    await user.keyboard('{ArrowUp}{Enter}');
    expect(onChange).toHaveBeenCalledWith('SUNLU');

    // Input kept focus after selecting, so the first ArrowDown only reopens
    // the dropdown; the next four move the highlight 0 → 1 → 2 → wrap to 0.
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('Bambu Lab');
  });

  it('Enter selects the first match while typing without arrowing', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();

    await user.click(input);
    await user.type(input, 'sun');
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('SUNLU');
  });

  it('Enter does not submit the surrounding form while the dropdown is open', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <SearchableSelect value="" onChange={vi.fn()} options={OPTIONS} allowCustom={false} />
      </form>,
    );

    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the current selection visible as placeholder while open and untyped', async () => {
    const user = userEvent.setup();
    const { input } = setup({ value: 'Creality' });

    await user.click(input);
    // Field is cleared for searching, but the selection stays readable
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('placeholder', 'Creality');

    // Typing replaces the placeholder hint with the live filter text
    await user.type(input, 'sun');
    expect(input).toHaveValue('sun');
    expect(screen.getByRole('option', { name: 'SUNLU' })).toBeInTheDocument();
  });

  it('allowCustom: Enter picks the "use custom" row when nothing matches', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup({ allowCustom: true });

    await user.click(input);
    await user.type(input, 'MyBrand');
    onChange.mockClear(); // ignore the live per-keystroke onChange calls
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('MyBrand');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });
});
