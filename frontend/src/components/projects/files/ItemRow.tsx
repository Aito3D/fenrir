import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Pencil, Trash2, Upload } from 'lucide-react';
import type { ProjectItemOut } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { ConfirmModal } from '../../ConfirmModal';
import { inputCls, focusRingCls } from '../../formStyles';
import { RevisionBlock } from './RevisionBlock';
import type { DerivedOption } from './RevisionBlock';
import type { FileActions } from './useFileActions';
import { filesFromDataTransfer } from './fileDrop';
import { PRINTABLE_ACCEPT, SECTION_LABEL_KEYS, STATUS_CHIP_CLS, STATUS_LABEL_KEYS, chipBase, isSectionEnabled } from './filesUi';

interface Props {
  item: ProjectItemOut;
  derivedOptions: DerivedOption[];
  actions: FileActions;
}

const iconBtn = `inline-flex h-11 w-11 items-center justify-center rounded-lg text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white md:h-8 md:w-8 ${focusRingCls}`;

export function ItemRow({ item, derivedOptions, actions }: Props) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  // An item in a disabled section (projects hold printing files only for now) is
  // read-only except delete: no upload, drop or rename.
  const canUpdate = hasPermission('projects:update') && isSectionEnabled(item.section);
  const canDelete = hasPermission('projects:delete');
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const revisions = [...item.revisions].sort((a, b) => b.number - a.number);
  const newest = revisions[0];
  const fileCount = newest?.files.length ?? 0;
  const outdated = item.section === 'impression' && newest?.outdated_by && newest.derived_from ? newest : null;
  const src = newest?.derived_from;
  const busy = actions.isBusy(item.id);
  // Expanded, each revision block carries its own OUTDATED chip.
  const rowOutdated = outdated && !open;

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (!canUpdate || busy) return;
    const files = filesFromDataTransfer(e.dataTransfer);
    if (files.length) void actions.uploadRevision(item.id, files);
  };

  const renameDone = useRef(false);
  const startRename = () => {
    renameDone.current = false;
    setRenaming(item.name);
  };
  const cancelRename = () => {
    renameDone.current = true;
    setRenaming(null);
  };
  const submitRename = async () => {
    if (renameDone.current) return;
    renameDone.current = true;
    const name = (renaming ?? '').trim();
    setRenaming(null);
    if (name && name !== item.name) await actions.renameItem(item.id, name);
  };

  return (
    <li
      className={`rounded-lg border bg-bambu-dark/60 ${dragOver ? 'border-bambu-green' : 'border-bambu-dark-tertiary'}`}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (canUpdate) setDragOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 p-2">
        {renaming !== null ? (
          <form className="flex min-w-0 flex-1 basis-48 gap-2" onSubmit={(e) => { e.preventDefault(); void submitRename(); }}>
            <input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} onBlur={() => void submitRename()}
              aria-label={t('projectsPdm.files.rename')} className={inputCls}
              onKeyDown={(e) => e.key === 'Escape' && cancelRename()} />
          </form>
        ) : (
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
            className={`flex min-h-[44px] min-w-0 flex-1 basis-40 items-center gap-1.5 rounded-lg text-left md:min-h-0 ${focusRingCls}`}>
            {open ? <ChevronDown className="h-4 w-4 shrink-0 text-bambu-gray" /> : <ChevronRight className="h-4 w-4 shrink-0 text-bambu-gray" />}
            <span className="min-w-0 break-all text-sm font-medium text-white">{item.name}</span>
          </button>
        )}
        {newest && (
          <span className={`${chipBase} ${STATUS_CHIP_CLS[newest.status]}`}>
            {`R${newest.number} · ${t(STATUS_LABEL_KEYS[newest.status])}`}
          </span>
        )}
        <span className="text-xs text-bambu-gray">{t('projectsPdm.files.fileCount', { count: fileCount })}</span>
        {busy && <span role="status" className="text-xs text-bambu-green">{t('projectsPdm.files.uploading')}</span>}
        {(canUpdate || (canDelete && !isSectionEnabled(item.section))) && (
          <span className="flex">
            {canUpdate && (
              <>
                <button type="button" className={`${iconBtn} disabled:opacity-40`} aria-label={t('projectsPdm.files.newRevision')}
                  title={t('projectsPdm.files.newRevision')} disabled={busy} onClick={() => input.current?.click()}>
                  <Upload className="h-4 w-4" />
                </button>
                <button type="button" className={iconBtn} aria-label={t('projectsPdm.files.rename')}
                  title={t('projectsPdm.files.rename')} onClick={startRename}>
                  <Pencil className="h-4 w-4" />
                </button>
              </>
            )}
            {canDelete && (
              <button type="button" className={`${iconBtn} hover:text-red-400`} aria-label={t('projectsPdm.files.deleteItem')}
                title={t('projectsPdm.files.deleteItem')} onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </span>
        )}
        {canUpdate && (
          <input ref={input} type="file" multiple accept={PRINTABLE_ACCEPT} className="hidden" data-testid={`new-revision-input-${item.id}`}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) void actions.uploadRevision(item.id, files);
            }} />
        )}
      </div>
      {(src || rowOutdated) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pb-2 pl-8 text-xs text-bambu-gray">
          {src && (
            <span className="break-words">
              {t('projectsPdm.files.derivedFrom', { label: `${t(SECTION_LABEL_KEYS[src.section])} › ${src.item_name} R${src.number}` })}
            </span>
          )}
          {rowOutdated && src && newest.outdated_by && (
            <span className={`${chipBase} whitespace-normal border-amber-500/40 bg-amber-500/10 text-amber-400`}>
              {t('projectsPdm.files.outdated', { source: `${src.item_name} R${src.number}`, newer: `R${newest.outdated_by.number}` })}
            </span>
          )}
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-bambu-dark-tertiary p-2">
          {revisions.map((r) => (
            <RevisionBlock key={r.id} item={item} revision={r} derivedOptions={derivedOptions} actions={actions} />
          ))}
        </div>
      )}
      {confirmDelete && (
        <ConfirmModal
          title={t('projectsPdm.files.deleteItem')}
          message={t('projectsPdm.files.confirmDeleteItem', { name: item.name })}
          confirmText={t('projectsPdm.files.deleteItem')}
          variant="danger"
          onConfirm={() => { setConfirmDelete(false); void actions.deleteItem(item.id); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </li>
  );
}
