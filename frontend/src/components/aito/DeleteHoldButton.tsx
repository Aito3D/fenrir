import { Trash2 } from 'lucide-react';
import { HoldButton } from './HoldButton';

// Trash2 button that requires a 1s pointer/keyboard hold to fire delete,
// replacing the old ConfirmModal flow. A short press instead shows a
// "hold to delete" hint popover. See task-14-brief.md for the full spec.
//
// A thin wrapper over `HoldButton` (task-12-brief.md): same timer, hint and
// ring, red styling and Trash2 icon, `durationMs={1000}`. Public props and
// behaviour are unchanged — `ProjectDetailPanel.test.tsx` and `TaskRow` both
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
        // No border — HoldButton's base doesn't add one either, so this is
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
    </HoldButton>
  );
}
