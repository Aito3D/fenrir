import { useState, type ChangeEvent, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { isPendingQuery } from '../../../utils/aitoSearch';

export const MAX_RESULTS = 8;

/** WAI-ARIA combobox state for the board search: open while focused with a
 *  query that narrows something (not just `+689` or `#`) and not dismissed;
 *  ↑/↓ wrap through the visible rows; Enter picks the highlighted row or the
 *  first; Escape closes, then (unless `escapeClears` is false) clears.
 *  Escape is only stopped when it did something, so drawers and modals still get it otherwise. */
export function useSearchCombobox({
  value,
  onChange,
  hitCount,
  onSelectIndex,
  listboxId,
  escapeClears = true,
}: {
  value: string;
  onChange: (value: string) => void;
  hitCount: number;
  onSelectIndex: (index: number) => void;
  listboxId: string;
  escapeClears?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  const shown = Math.min(hitCount, MAX_RESULTS);
  const open = focused && !dismissed && !isPendingQuery(value);
  const optionId = (index: number) => `${listboxId}-option-${index}`;
  const dismiss = () => {
    setDismissed(true);
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keys that drive an IME (conversion Enter, candidate arrows, cancelling
    // Escape) are not combobox commands. keyCode 229 covers Safari.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && open && shown > 0) {
      event.preventDefault();
      const down = event.key === 'ArrowDown';
      setActive((i) => (down ? (i + 1) % shown : i <= 0 ? shown - 1 : i - 1));
    } else if (event.key === 'Enter' && open && shown > 0) {
      event.preventDefault();
      onSelectIndex(active >= 0 && active < shown ? active : 0);
      dismiss();
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      } else if (escapeClears && value !== '') {
        event.preventDefault();
        event.stopPropagation();
        onChange('');
      }
    }
  };

  const inputProps: InputHTMLAttributes<HTMLInputElement> = {
    role: 'combobox',
    'aria-expanded': open,
    'aria-controls': listboxId,
    'aria-autocomplete': 'list',
    'aria-activedescendant': open && active >= 0 ? optionId(active) : undefined,
    value,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      setDismissed(false);
      setActive(-1);
      onChange(event.target.value);
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onKeyDown,
  };

  return { open, active, setActive, optionId, dismiss, inputProps };
}
