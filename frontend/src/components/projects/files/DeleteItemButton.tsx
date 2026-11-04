import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { HoldButton } from '../../aito/HoldButton';

/** Hold-to-delete an item: the trash button of an "Older files" row and of a card's details tray. */
export function DeleteItemButton({ onDelete }: { onDelete: () => void }) {
  const { t } = useTranslation();
  return (
    <HoldButton
      onHold={onDelete}
      durationMs={1000}
      label={t('projectsPdm.files.deleteItem')}
      hint={t('aito.holdToDelete')}
      progress="perimeter"
      className="h-11 w-11 justify-center text-bambu-gray hover:bg-red-400/10 hover:text-red-400 focus-visible:ring-red-400/40 data-[holding=true]:text-red-400 md:h-8 md:w-8"
    >
      <Trash2 className="relative h-4 w-4" />
    </HoldButton>
  );
}
