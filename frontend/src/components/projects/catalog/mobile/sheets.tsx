import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Folder, FolderInput, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import type { ProjectFolder } from '../../../../api/client';
import { focusRingCls, inputCls } from '../../../formStyles';
import { CATALOG_STATUSES, type CatalogStatus } from '../CatalogToolbar';
import type { CatalogSort } from '../catalogRules';
import { descendantIds, folderPath } from '../catalogRules';
import { Sheet } from './Sheet';

const SORTS: CatalogSort[] = ['activity', 'code', 'name', 'printed'];
const SORT_KEYS: Record<CatalogSort, string> = {
  activity: 'projectsPdm.catalog.sortActivity',
  code: 'projectsPdm.catalog.sortCode',
  name: 'projectsPdm.catalog.sortName',
  printed: 'projectsPdm.catalog.sortPrinted',
};
const sectionCls = 'px-1 pt-3 pb-1 text-[11px] uppercase tracking-wide text-bambu-gray';
const rowCls = `btn-press flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-[15px] text-white active:bg-bambu-dark-tertiary ${focusRingCls}`;

/** Status (segments) and sort (a list with a check) — the two selects of the desktop toolbar. */
export function FilterSheet({
  status,
  onStatusChange,
  sort,
  onSortChange,
  onClose,
}: {
  status: CatalogStatus;
  onStatusChange: (s: CatalogStatus) => void;
  sort: CatalogSort;
  onSortChange: (s: CatalogSort) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet label={t('projectsPdm.catalog.mobile.filters')} testId="catalog-filter-sheet" onClose={onClose}>
      {(close) => (
        <>
          <div className={sectionCls}>{t('projectsPdm.catalog.mobile.status')}</div>
          <div role="group" aria-label={t('projectsPdm.catalog.mobile.status')} className="flex gap-1 rounded-xl bg-bambu-dark p-1">
            {CATALOG_STATUSES.map((s) => (
              <button key={s} type="button" aria-pressed={status === s} onClick={() => onStatusChange(s)}
                className={`btn-press h-9 flex-1 rounded-lg text-sm ${status === s ? 'bg-bambu-dark-secondary text-white shadow-sm' : 'text-bambu-gray'} ${focusRingCls}`}>
                {s === 'all' ? t('projectsPdm.statusAll') : t(`projectDetail.status.${s}`)}
              </button>
            ))}
          </div>
          <div className={sectionCls}>{t('projectsPdm.catalog.mobile.sort')}</div>
          <ul className="divide-y divide-bambu-dark-tertiary rounded-xl border border-bambu-dark-tertiary">
            {SORTS.map((s) => (
              <li key={s}>
                <button type="button" aria-pressed={sort === s} onClick={() => onSortChange(s)}
                  className={`flex w-full items-center justify-between px-3 py-2.5 text-[15px] ${sort === s ? 'text-white' : 'text-bambu-gray'} ${focusRingCls}`}>
                  {t(SORT_KEYS[s])}
                  {sort === s && <Check className="h-4 w-4 text-bambu-green" aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={close} className={`btn-press mt-4 h-11 w-full rounded-xl bg-bambu-green font-medium text-white ${focusRingCls}`}>
            {t('projectsPdm.catalog.mobile.done')}
          </button>
        </>
      )}
    </Sheet>
  );
}

/** One folder's actions: rename in place, a new folder inside, move, delete. */
export function FolderSheet({
  folder,
  folders,
  onRename,
  onNewInside,
  onMove,
  onDelete,
  onClose,
}: {
  folder: ProjectFolder;
  folders: ProjectFolder[];
  onRename: (name: string) => Promise<unknown>;
  onNewInside: () => void;
  onMove: (parentId: number | null) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'menu' | 'rename' | 'move'>('menu');
  const [name, setName] = useState(folder.name);
  const path = folderPath(folders, folder.id).join(' › ');
  const excluded = descendantIds(folders, folder.id);
  return (
    <Sheet label={t('projectsPdm.catalog.folderActions')} testId="catalog-folder-sheet" onClose={onClose}>
      {(close) => (
        <>
          <div className="flex items-center gap-1.5 px-3 pb-2 text-xs text-bambu-gray"><Folder className="h-3.5 w-3.5 text-amber-200/80" aria-hidden />{path}</div>
          {mode === 'rename' ? (
            <form className="space-y-2 px-1" onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) void onRename(name.trim()).then(close); }}>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label={t('projectsPdm.catalog.folderName')} className={`${inputCls} h-11`} />
              <button type="submit" disabled={!name.trim()} className={`btn-press h-11 w-full rounded-xl bg-bambu-green font-medium text-white disabled:opacity-50 ${focusRingCls}`}>
                {t('projectsPdm.catalog.rename')}
              </button>
            </form>
          ) : mode === 'move' ? (
            <div className="space-y-2 px-1">
              <select autoFocus defaultValue={folder.parent_id ?? ''} aria-label={t('projectsPdm.catalog.moveTo')}
                onChange={(e) => { onMove(e.target.value ? Number(e.target.value) : null); close(); }}
                className={`${inputCls} h-11`}>
                <option value="">{t('projectsPdm.catalog.atTop')}</option>
                {folders.filter((f) => !excluded.has(f.id)).map((f) => (
                  <option key={f.id} value={f.id}>{folderPath(folders, f.id).join(' › ')}</option>
                ))}
              </select>
            </div>
          ) : (
            <>
              <button type="button" onClick={() => setMode('rename')} className={rowCls}><Pencil className="h-4 w-4 text-bambu-gray-light" aria-hidden />{t('projectsPdm.catalog.rename')}</button>
              <button type="button" onClick={() => { onNewInside(); close(); }} className={rowCls}><FolderPlus className="h-4 w-4 text-bambu-gray-light" aria-hidden />{t('projectsPdm.catalog.mobile.newFolderInside')}</button>
              <button type="button" onClick={() => setMode('move')} className={rowCls}><FolderInput className="h-4 w-4 text-bambu-gray-light" aria-hidden />{t('projectsPdm.catalog.moveTo')}</button>
              <button type="button" onClick={() => { onDelete(); close(); }} className={`${rowCls} mt-1 border-t border-bambu-dark-tertiary !text-red-400`}>
                <Trash2 className="h-4 w-4" aria-hidden />
                <span>{t('projectsPdm.catalog.deleteFolder')}<span className="block text-[11px] text-bambu-gray">{t('projectsPdm.catalog.deleteFolderHint')}</span></span>
              </button>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}

/** Name a new folder; it is created where the user is (or inside the folder picked from ⋯). */
export function NewFolderSheet({
  parentName,
  onCreate,
  onClose,
}: {
  parentName: string | null;
  onCreate: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  return (
    <Sheet label={t('projectsPdm.catalog.newFolder')} testId="catalog-new-folder-sheet" onClose={onClose}>
      {(close) => (
        <form className="space-y-2 px-1" onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) void onCreate(name.trim()).then(close); }}>
          <div className="px-2 pb-1 text-sm font-medium text-white">{t('projectsPdm.catalog.newFolder')}</div>
          <div className="px-2 text-xs text-bambu-gray">{parentName ? t('projectsPdm.catalog.inFolder', { path: parentName }) : t('projectsPdm.catalog.atTop')}</div>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('projectsPdm.catalog.folderName')} aria-label={t('projectsPdm.catalog.folderName')} className={`${inputCls} h-11`} />
          <button type="submit" disabled={!name.trim()} className={`btn-press h-11 w-full rounded-xl bg-bambu-green font-medium text-white disabled:opacity-50 ${focusRingCls}`}>
            {t('projectsPdm.catalog.create')}
          </button>
        </form>
      )}
    </Sheet>
  );
}
