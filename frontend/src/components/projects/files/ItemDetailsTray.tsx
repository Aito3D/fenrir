import type { DragEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Trash2, X } from 'lucide-react';
import type { ProjectItemOut, ProjectRevisionOut } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { HoldButton } from '../../aito/HoldButton';
import { focusRingCls } from '../../formStyles';
import { RevisionBlock } from './RevisionBlock';
import type { FileActions } from './useFileActions';
import { useDerivedOptions } from './useDerivedOptions';
import { isSectionEnabled } from './filesUi';

interface Props {
  item: ProjectItemOut;
  /** The revision the card shows (its picked chip); none for an item without a revision yet. */
  revision: ProjectRevisionOut | undefined;
  actions: FileActions;
  /** The card's drop handlers: a file dropped on the tray is the item's new revision too. */
  dropHandlers: { onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
  /** The card's rename input while renaming, shown in place of the name. */
  renameField: ReactNode;
  onRename: () => void;
  onClose: () => void;
  /** The card's ⋯ fork request: that revision's block opens with its fork form. */
  fork: { revisionId: number; nonce: number } | null;
}

const iconBtn = `inline-flex h-11 w-11 items-center justify-center rounded-lg text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white md:h-8 md:w-8 ${focusRingCls}`;

/** The card's details, a full-width grid cell under its row: rename and hold-to-delete the item,
 *  then the shown revision's block (status, note, derived-from, files, delete revision). */
export function ItemDetailsTray({ item, revision, actions, dropHandlers, renameField, onRename, onClose, fork }: Props) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canUpdate = hasPermission('projects:update') && isSectionEnabled(item.section);
  const canDelete = hasPermission('projects:delete');
  const derivedOptions = useDerivedOptions(actions.projectId);
  const forking = fork !== null && fork.revisionId === revision?.id;

  return (
    <li data-testid={`item-tray-${item.id}`}
      className="col-span-full space-y-2 rounded-lg border border-bambu-green/40 bg-bambu-dark/70 p-3" {...dropHandlers}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {renameField || <span className="min-w-0 flex-1 basis-40 break-all text-sm font-medium text-white">{item.name}</span>}
        <span className="flex [&>div]:flex">
          {canUpdate && (
            <button type="button" className={iconBtn} aria-label={t('projectsPdm.files.rename')} title={t('projectsPdm.files.rename')}
              onClick={onRename}>
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {canDelete && (
            <HoldButton
              onHold={() => void actions.deleteItem(item.id)}
              durationMs={1000}
              label={t('projectsPdm.files.deleteItem')}
              hint={t('aito.holdToDelete')}
              progress="perimeter"
              className="h-11 w-11 justify-center text-bambu-gray hover:bg-red-400/10 hover:text-red-400 focus-visible:ring-red-400/40 data-[holding=true]:text-red-400 md:h-8 md:w-8"
            >
              <Trash2 className="relative h-4 w-4" />
            </HoldButton>
          )}
          <button type="button" className={iconBtn} aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </span>
      </div>
      {revision && (
        <RevisionBlock
          key={forking ? `${revision.id}:${fork?.nonce}` : revision.id}
          item={item}
          revision={revision}
          derivedOptions={derivedOptions}
          actions={actions}
          initialForking={forking}
        />
      )}
    </li>
  );
}
