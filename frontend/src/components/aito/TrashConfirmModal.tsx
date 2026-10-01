import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { ConfirmModal } from '../ConfirmModal';
import { HoldButton } from './HoldButton';

/** "Move to trash" from the card's ⋯ menu.
 *
 *  The footer's hold-to-delete pill moved into the menu, and the hold came
 *  with it: the confirm's commit control IS the 1s hold, not a click, so a
 *  menu row followed by a reflexive Enter can never trash a card. The modal
 *  only frames the question; `onTrash` fires when the hold completes. */
export function TrashConfirmModal({ onTrash, onCancel }: { onTrash: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const label = t('aito.trashConfirmHold');

  return (
    <ConfirmModal
      title={t('aito.trashConfirmTitle')}
      message={t('aito.trashConfirmBody')}
      variant="danger"
      // Opened over the panel, which closes on Escape too.
      isolateEscape
      onConfirm={onTrash}
      onCancel={onCancel}
      confirmControl={
        // HoldButton's outer wrapper is a bare `relative` div; the strut
        // stretches it into the modal's flex-1 slot beside Cancel.
        <div className="flex flex-1 [&>div]:flex [&>div]:flex-1">
          <HoldButton
            onHold={() => onTrash()}
            durationMs={1000}
            label={label}
            hint={t('aito.holdToDelete')}
            progress="bar"
            barClassName="bg-white/25"
            radiusClassName="rounded-lg"
            pressEffect="none"
            className="w-full justify-center px-4 py-2 min-h-[44px] md:min-h-0 text-sm font-medium text-white bg-red-500 hover:bg-red-600 focus-visible:ring-red-400/60"
          >
            <Trash2 className="relative h-4 w-4" aria-hidden="true" />
            <span className="relative">{label}</span>
          </HoldButton>
        </div>
      }
    />
  );
}
