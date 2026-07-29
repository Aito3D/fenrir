import { Trash2 } from 'lucide-react';
import { HoldButton } from './HoldButton';

// Trash2 button that requires a 1s pointer/keyboard hold to fire delete,
// replacing the old ConfirmModal flow. A short press instead shows a
// "hold to delete" hint popover. See task-14-brief.md for the full spec.
//
// A thin wrapper over `HoldButton` (task-12-brief.md): same timer, hint and
// ring, red styling and Trash2 icon, `durationMs={1000}`. Public props and
// behaviour are unchanged — `AitoCardView.test.tsx` and `TaskRow` both
// depend on them.
export function DeleteHoldButton({
  onDelete,
  label,
  hint,
}: {
  onDelete: () => void;
  label: string;
  hint: string;
}) {
  return (
    <HoldButton
      onHold={onDelete}
      durationMs={1000}
      label={label}
      hint={hint}
      className={
        'text-bambu-gray hover:text-red-400 hover:bg-red-400/10 focus-visible:ring-red-400/40 ' +
        'border-transparent ' +
        // HoldButton's base bakes in p-1.5 (6px) + a 1px border for the
        // roomier quote buttons — 7px per side this button doesn't want.
        // -m-1 -m-1 cancelled the old p-1 exactly (4px = 4px, 0px border);
        // margin is additive over the base rather than another same-axis
        // utility fighting it, so it reliably restores the original
        // icon-only footprint here (14px, matching the Pencil edit button
        // beside it) without touching the base's own padding/border classes.
        '-m-[7px] ' +
        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 ' +
        'data-[holding=true]:opacity-100 data-[holding=true]:text-red-400'
      }
    >
      <Trash2 className="relative w-3.5 h-3.5" />
    </HoldButton>
  );
}
