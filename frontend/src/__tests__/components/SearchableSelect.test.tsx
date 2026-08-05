/**
 * Tests for the SearchableSelect combobox, focused on keyboard navigation:
 * ArrowUp/ArrowDown move the highlight (with wrap-around), Enter selects.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

  // `shortLabel` splits what the CLOSED control shows from what the list rows
  // show, so a control can be deliberately too narrow for its own options
  // (PhoneInput's dialling-code picker: `+689` in the field, `+689 French
  // Polynesia` in the menu). The whole point is that shortening the field
  // costs nothing searchable, so the row text and the filter are pinned here
  // together — a `shortLabel` that leaked into either would shrink the menu
  // and silently kill search-by-country-name in all three phone forms.
  describe('shortLabel', () => {
    const CODES = [
      { value: '+33', label: '+33 France', shortLabel: '+33' },
      { value: '+689', label: '+689 French Polynesia', shortLabel: '+689' },
      { value: '+1', label: '+1 United States' }, // no shortLabel: the other 6 call sites
    ];

    it('shows the short form in the closed control and the full label in the list', async () => {
      const user = userEvent.setup();
      render(<SearchableSelect value="+689" onChange={vi.fn()} options={CODES} allowCustom />);
      const input = screen.getByRole('combobox');

      expect(input).toHaveValue('+689');

      await user.click(input);
      expect(screen.getByRole('option', { name: '+689 French Polynesia' })).toBeInTheDocument();
      // The open placeholder keeps showing the SHORT form: it sits in the same
      // narrow field the closed control does, so the full label would just
      // truncate there.
      expect(input).toHaveAttribute('placeholder', '+689');
    });

    it('still filters on the full label, so a country name finds its code', async () => {
      const user = userEvent.setup();
      render(<SearchableSelect value="+689" onChange={vi.fn()} options={CODES} allowCustom />);
      const input = screen.getByRole('combobox');

      await user.click(input);
      await user.type(input, 'France');

      expect(screen.getByRole('option', { name: '+33 France' })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: '+1 United States' })).not.toBeInTheDocument();
    });

    it('falls back to the label when an option defines no shortLabel', () => {
      render(<SearchableSelect value="+1" onChange={vi.fn()} options={CODES} allowCustom />);
      expect(screen.getByRole('combobox')).toHaveValue('+1 United States');
    });
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

  describe('Escape propagation', () => {
    // Regression test for a bug where SearchableSelect registered its Escape
    // handler on `document` without stopping propagation. A parent modal that
    // listens on `window` (e.g. NewProjectModal) still received the same
    // Escape event — document listeners run before window listeners in the
    // bubble phase — and closed itself underneath an open dropdown, discarding
    // whatever the user had typed into the surrounding form.
    it('stops Escape from reaching a window-level handler while its dropdown is open', async () => {
      const user = userEvent.setup();
      const windowHandler = vi.fn();
      window.addEventListener('keydown', windowHandler);
      try {
        const { input } = setup();
        await user.click(input);
        expect(screen.getByRole('option', { name: 'Bambu Lab' })).toBeInTheDocument();

        await user.keyboard('{Escape}');

        expect(screen.queryByRole('option', { name: 'Bambu Lab' })).not.toBeInTheDocument();
        expect(windowHandler).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('keydown', windowHandler);
      }
    });

    it('leaves Escape alone for a window-level handler while its dropdown is closed', () => {
      const windowHandler = vi.fn();
      window.addEventListener('keydown', windowHandler);
      try {
        setup(); // never opened
        fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true });
        expect(windowHandler).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener('keydown', windowHandler);
      }
    });
  });
});
