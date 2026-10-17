import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { UploadCloud } from 'lucide-react';
import type { ProjectSection } from '../../../api/client';
import { focusRingCls } from '../../formStyles';
import { useFileDropZone } from './useFileDropZone';
import { PRINTABLE_ACCEPT } from './filesUi';

/** The dashed last cell of the card grid: drop (or pick) a `.3mf` to create an item named after
 *  it. `onFiles` is the section's own drop handler (create-or-reuse by name, then upload). */
export function NewItemDropCard({ section, onFiles }: { section: ProjectSection; onFiles: (files: File[]) => void | Promise<void> }) {
  const { t } = useTranslation();
  const chooser = useRef<HTMLInputElement>(null);
  const { dragOver, ...dropHandlers } = useFileDropZone({ canDrop: true, stopPropagation: 'dragOverAndDrop', onFiles });
  return (
    <li className="flex" {...dropHandlers}>
      <button type="button" onClick={() => chooser.current?.click()}
        className={`flex min-h-[200px] w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-3 text-center transition-colors ${
          dragOver ? 'border-bambu-green text-bambu-green' : 'border-bambu-dark-tertiary text-bambu-gray hover:border-bambu-green/60 hover:text-bambu-green'
        } ${focusRingCls}`}>
        <UploadCloud className="h-7 w-7" aria-hidden />
        <span className="text-sm">{t('projectsPdm.files.dropToCreate')}</span>
        <span className="text-[11px]">{t('projectsPdm.files.dropToCreateHint')}</span>
      </button>
      <input ref={chooser} type="file" accept={PRINTABLE_ACCEPT} className="hidden" data-testid={`new-item-drop-input-${section}`}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void onFiles(files);
        }} />
    </li>
  );
}
