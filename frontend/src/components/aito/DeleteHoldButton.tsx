import { Trash2 } from 'lucide-react';
import { HoldButton } from './HoldButton';

// Trash2 button that requires a 1s pointer/keyboard hold to fire delete,
// replacing the old ConfirmModal flow. A short press instead shows a
// "hold to delete" hint popover. See task-14-brief.md for the full spec.
//
// A thin wrapper over `HoldButton` (task-12-brief.md): same timer, hint and
// ring, red styling and Trash2 icon, `durationMs={1000}`. Public props and
// behaviour (including the default hover-reveal styling) are unchanged —
// `ProjectDetailPanel.test.tsx` and `TaskRow` both depend on them.
export function DeleteHoldButton({
  onDelete,
  label,
  hint,
  /** Renders as a permanent bordered pill with a visible label instead of an
   *  icon that only reveals itself on `group-hover`. Opt-in (default false):
   *  `TaskRow` sits right next to a Pencil edit button it hovers alongside,
   *  where the icon-only reveal is still correct, so that call site is left
   *  untouched. The panel footer passes `true` — far from any dismiss
   *  control, an icon invisible at rest would be missable, and the reference
   *  design shows it as a bordered button matching "Print quote" and "Open
   *  in Zoho" beside it. */
  alwaysVisible = false,
}: {
  onDelete: () => void;
  label: string;
  hint: string;
  alwaysVisible?: boolean;
}) {
  return (
    <HoldButton
      onHold={onDelete}
      durationMs={1000}
      label={label}
      hint={hint}
      // A bar only on the wide labelled pill. The ring is right when the
      // button IS its icon, but scaled across a 130px-wide footer button it
      // lands as a small circle floating over the middle of the label.
      progress={alwaysVisible ? 'bar' : 'ring'}
      className={
        alwaysVisible
          ? 'rounded-md border border-bambu-dark-tertiary px-2.5 py-1 text-sm ' +
            'text-bambu-gray hover:text-red-400 hover:border-red-400/45 focus-visible:ring-red-400/40 ' +
            'data-[holding=true]:text-red-400 data-[holding=true]:border-red-400'
          : // No border — HoldButton's base doesn't add one either, so this is
            // the whole box: exactly the pre-extraction p-1 -m-1 (padding and
            // margin cancel exactly), matching TaskRow's Pencil edit button
            // (`flex-shrink-0 p-1 -m-1 rounded-md`) pixel for pixel.
            'p-1 -m-1 ' +
            'text-bambu-gray hover:text-red-400 hover:bg-red-400/10 focus-visible:ring-red-400/40 ' +
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 ' +
            'data-[holding=true]:opacity-100 data-[holding=true]:text-red-400'
      }
    >
      <Trash2 className="relative w-3.5 h-3.5" />
      {alwaysVisible && <span className="relative">{label}</span>}
    </HoldButton>
  );
}
