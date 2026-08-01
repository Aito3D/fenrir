import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../Button';

interface ViewToggleButtonProps {
  /** This view is the one currently on screen, so the button reads as the way
   *  back to the board rather than the way into the view. */
  active: boolean;
  onToggle: () => void;
  icon: LucideIcon;
  /** The inactive label — "Show done (30)", "Trash". The active label is always
   *  "Back to board": there is one board, and every one of these views is a
   *  detour from it. */
  label: string;
}

/** The board's view switches — Done and Trash — as one button that does not
 *  change size when you press it.
 *
 *  Both labels are rendered, stacked in a single grid cell, and the one that
 *  does not apply is `invisible` rather than absent. The button is therefore as
 *  wide as its WIDER label at all times, so pressing it swaps the text without
 *  the toolbar reflowing under the pointer that is still on it.
 *
 *  A `min-w-*` was the other option and is worse: the two labels are
 *  translated into 13 locales, and any width big enough for the longest German
 *  string is dead space in every other language. This measures instead of
 *  guessing.
 *
 *  The hidden label is `aria-hidden` — it is a layout strut, and a screen
 *  reader that read both would announce the button as "Show done Back to
 *  board". */
export function ViewToggleButton({ active, onToggle, icon: Icon, label }: ViewToggleButtonProps) {
  const { t } = useTranslation();

  return (
    <Button variant="secondary" onClick={onToggle} aria-pressed={active}>
      <span className="grid">
        <span
          aria-hidden={active}
          className={`[grid-area:1/1] flex items-center justify-center gap-2 ${active ? 'invisible' : ''}`}
        >
          <Icon className="w-4 h-4 mr-2" />
          {label}
        </span>
        <span
          aria-hidden={!active}
          className={`[grid-area:1/1] flex items-center justify-center gap-2 ${active ? '' : 'invisible'}`}
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('aito.backToBoard')}
        </span>
      </span>
    </Button>
  );
}
