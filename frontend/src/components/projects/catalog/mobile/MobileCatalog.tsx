import { useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ChevronLeft, ChevronRight, Flame, Folder, FolderPlus, MoreHorizontal, Plus, Search, SlidersHorizontal } from 'lucide-react';
import type { ProjectCatalogItem, ProjectFolder, ProjectTagCount } from '../../../../api/client';
import { ActionMenu } from '../../../aito/ActionMenu';
import { focusRingCls, inputCls } from '../../../formStyles';
import { formatRelativeTime } from '../../../../utils/date';
import type { CatalogStatus } from '../CatalogToolbar';
import type { CatalogChip, CatalogFilters, CatalogSort } from '../catalogRules';
import { CHIPS, descendantIds, folderPath } from '../catalogRules';
import { CodeMark, Highlight, InProductionFlame, PrintedCell, Thumb } from '../CatalogRowParts';
import { FilterSheet, FolderSheet, NewFolderSheet } from './sheets';

export interface MobileCatalogProps {
  /** The projects after search, chips and sort — what the desktop list shows. */
  items: ProjectCatalogItem[];
  folders: ProjectFolder[];
  isLoading: boolean;
  q: string;
  onQChange: (q: string) => void;
  /** A search or a chip is on: the list is flat across folders. */
  filtering: boolean;
  filters: CatalogFilters;
  onToggleChip: (chip: CatalogChip) => void;
  onToggleMaterial: (m: string) => void;
  materials: string[];
  usedTags: ProjectTagCount[];
  tagIds: number[];
  onToggleTag: (id: number) => void;
  sort: CatalogSort;
  onSortChange: (s: CatalogSort) => void;
  status: CatalogStatus;
  onStatusChange: (s: CatalogStatus) => void;
  /** The folder on screen; null at the top. */
  folderId: number | null;
  onFolderChange: (id: number | null) => void;
  canCreate: boolean;
  canUpdate: boolean;
  onOpenProject: (id: number) => void;
  onNewProject: () => void;
  onCreateFolder: (name: string, parentId: number | null) => Promise<unknown>;
  onRenameFolder: (id: number, name: string) => Promise<unknown>;
  onDeleteFolder: (id: number) => void;
  onMoveFolder: (id: number, parentId: number | null) => void;
  /** Something else owns the screen (a modal): keep the + out of the way. */
  hideFab: boolean;
  searchRef?: RefObject<HTMLInputElement | null>;
}

type Overlay = { kind: 'create' } | { kind: 'filters' } | { kind: 'folder'; id: number } | { kind: 'newFolder'; parentId: number | null } | null;

const chipCls = (on: boolean) =>
  `btn-press inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-xs ${
    on ? 'border-bambu-green bg-bambu-green/15 text-white' : 'border-bambu-dark-tertiary text-bambu-gray'
  } ${focusRingCls}`;

/** The phone catalog (spec: docs/superpowers/specs/2026-11-01-projects-mobile-design.md): one
 *  folder at a time, search across all of them, the Aito board's floating +. The page is exactly
 *  the screen under the top bar and only the list scrolls. */
export function MobileCatalog(p: MobileCatalogProps) {
  const { t } = useTranslation();
  const [overlay, setOverlay] = useState<Overlay>(null);
  // Which way the list last moved, for the slide; a nonce restarts the animation on every move.
  const [motion, setMotion] = useState<{ dir: 'in' | 'back'; nonce: number }>({ dir: 'in', nonce: 0 });
  const fabRef = useRef<HTMLButtonElement>(null);
  const byId = new Map(p.folders.map((f) => [f.id, f]));
  const here = p.folderId !== null ? byId.get(p.folderId) ?? null : null;
  const scopeIds = p.folderId !== null ? descendantIds(p.folders, p.folderId) : null;
  const inScope = scopeIds ? p.items.filter((i) => i.folder_id !== null && scopeIds.has(i.folder_id)) : p.items;
  const subfolders = p.folders.filter((f) => f.parent_id === p.folderId);
  const own = p.items.filter((i) => i.folder_id === p.folderId);
  const crumbs = here ? [t('projectsPdm.title'), ...folderPath(p.folders, here.id).slice(0, -1)] : [];

  const go = (id: number | null, dir: 'in' | 'back') => {
    setMotion((m) => ({ dir, nonce: m.nonce + 1 }));
    p.onFolderChange(id);
  };
  const filtersOff = p.status !== 'active' || p.sort !== 'activity';
  const fabShown = p.canCreate && !p.hideFab && (overlay === null || overlay.kind === 'create');
  const caption = here ? t('projectsPdm.catalog.mobile.filedIn', { folder: here.name }) : undefined;

  return (
    <div data-testid="catalog-mobile" className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <header className="shrink-0 space-y-2 border-b border-bambu-dark-tertiary px-4 pt-3 pb-2">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="flex min-w-0 items-center gap-1 text-xl font-bold text-white">
            {here && (
              <button type="button" onClick={() => go(here.parent_id, 'back')} aria-label={t('projectsPdm.catalog.mobile.back')}
                className={`-ml-2 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-bambu-gray active:text-white ${focusRingCls}`}>
                <ChevronLeft className="h-6 w-6" aria-hidden />
              </button>
            )}
            <span className="truncate">{here ? here.name : t('projectsPdm.title')}</span>
          </h1>
          <span className="flex shrink-0 items-center gap-1 text-xs text-bambu-gray tabular-nums" data-testid="catalog-mobile-counts">
            {inScope.length}
            <span className="flex items-center gap-0.5" title={t('projectsPdm.catalog.inProduction')}>· <Flame className="h-3 w-3 text-amber-300" aria-hidden />{inScope.filter((i) => i.open_orders.length > 0).length}</span>
            <span className="flex items-center gap-0.5" title={t('projectsPdm.catalog.readyToPrint')}>· <CheckCircle2 className="h-3 w-3 text-bambu-green" aria-hidden />{inScope.filter((i) => i.recommended !== null).length}</span>
          </span>
        </div>
        {crumbs.length > 0 && <div className="-mt-1 truncate text-[11px] text-bambu-gray">{crumbs.join(' › ')}</div>}
        <div className="flex items-center gap-2">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray" aria-hidden />
            <input ref={p.searchRef} type="search" value={p.q} onChange={(e) => p.onQChange(e.target.value)} placeholder={t('projectsPdm.catalog.searchPlaceholder')}
              aria-label={t('projectsPdm.catalog.searchPlaceholder')} className={`${inputCls} h-10 pl-9 text-[15px]`} />
          </label>
          <button type="button" onClick={() => setOverlay({ kind: 'filters' })} aria-label={t('projectsPdm.catalog.mobile.filters')} aria-haspopup="dialog"
            className={`relative grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-bambu-dark-tertiary bg-bambu-dark text-bambu-gray active:text-white ${focusRingCls}`}>
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            {filtersOff && <span data-testid="catalog-filters-dot" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-bambu-green" />}
          </button>
        </div>
        <div className="scrollbar-hide -mx-4 flex gap-1.5 overflow-x-auto px-4">
          {CHIPS.map(({ id, key, Icon, cls }) => (
            <button key={id} type="button" aria-pressed={p.filters.chips.has(id)} onClick={() => p.onToggleChip(id)} className={chipCls(p.filters.chips.has(id))}>
              <Icon className={`h-3 w-3 ${cls}`} aria-hidden />{t(key)}
            </button>
          ))}
          {p.materials.length > 0 && <span className="my-auto h-5 w-px shrink-0 bg-bambu-dark-tertiary" aria-hidden />}
          {p.materials.map((m) => (
            <button key={m} type="button" aria-pressed={p.filters.materials.has(m)} onClick={() => p.onToggleMaterial(m)} className={chipCls(p.filters.materials.has(m))}>{m}</button>
          ))}
          {p.usedTags.length > 0 && <span className="my-auto h-5 w-px shrink-0 bg-bambu-dark-tertiary" aria-hidden />}
          {p.usedTags.map((tag) => (
            <button key={tag.id} type="button" aria-pressed={p.tagIds.includes(tag.id)} onClick={() => p.onToggleTag(tag.id)} className={chipCls(p.tagIds.includes(tag.id))}>{`#${tag.name}`}</button>
          ))}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-28">
        {p.filtering ? (
          p.items.length === 0 && !p.isLoading ? (
            <p className="px-4 py-12 text-center text-sm text-bambu-gray">{t('projectsPdm.emptySearch')}</p>
          ) : (
            <ul className="divide-y divide-bambu-dark-tertiary">{p.items.map((item) => <ProjectRow key={item.id} item={item} q={p.q} path={folderPath(p.folders, item.folder_id)} onOpen={p.onOpenProject} />)}</ul>
          )
        ) : (
          <div key={motion.nonce} className={motion.dir === 'in' ? 'animate-drill-in' : 'animate-drill-back'}>
            {subfolders.length > 0 && (
              <ul className="divide-y divide-bambu-dark-tertiary">
                {subfolders.map((f) => (
                  <FolderRow key={f.id} folder={f} folders={p.folders} canUpdate={p.canUpdate} onOpen={() => go(f.id, 'in')} onMenu={() => setOverlay({ kind: 'folder', id: f.id })} />
                ))}
              </ul>
            )}
            {own.length > 0 && (
              <>
                {subfolders.length > 0 && (
                  <div className="px-4 pt-4 pb-1 text-[11px] uppercase tracking-wide text-bambu-gray">
                    {here ? t('projectsPdm.catalog.mobile.projectsHere') : t('projectsPdm.catalog.notInFolder')} <span className="normal-case tracking-normal">{own.length}</span>
                  </div>
                )}
                <ul className="divide-y divide-bambu-dark-tertiary">{own.map((item) => <ProjectRow key={item.id} item={item} q={p.q} path={[]} onOpen={p.onOpenProject} />)}</ul>
              </>
            )}
            {subfolders.length === 0 && own.length === 0 && !p.isLoading && (
              <p className="px-4 py-12 text-center text-sm text-bambu-gray">
                {here ? t('projectsPdm.catalog.mobile.folderEmpty') : t('projectsPdm.empty')}
                {here && p.canCreate && <span className="block text-bambu-gray/70">{t('projectsPdm.catalog.mobile.createsHere')}</span>}
              </p>
            )}
          </div>
        )}
      </main>

      {fabShown && (
        <button
          ref={fabRef}
          type="button"
          data-testid="catalog-mobile-fab"
          onClick={() => setOverlay(overlay?.kind === 'create' ? null : { kind: 'create' })}
          aria-haspopup="menu"
          aria-expanded={overlay?.kind === 'create'}
          aria-label={t('projectsPdm.catalog.mobile.create')}
          // The Aito board's button: under the shell drawer by default, over its own menu's scrim while open.
          className={`fixed right-4 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] ${overlay?.kind === 'create' ? 'z-[60]' : 'z-30'} grid h-14 w-14 place-items-center rounded-2xl bg-bambu-green text-white shadow-lg shadow-bambu-green/30`}
        >
          <Plus className={`h-6 w-6 transition-[rotate] duration-200 ease-(--ease-signature) motion-reduce:transition-none ${overlay?.kind === 'create' ? 'rotate-45' : ''}`} aria-hidden="true" />
        </button>
      )}
      {overlay?.kind === 'create' && (
        <ActionMenu
          label={t('projectsPdm.catalog.mobile.create')}
          anchorRef={fabRef}
          placement="above"
          caption={caption}
          items={[
            { key: 'project', icon: Plus, label: t('projectsPdm.newProject'), onSelect: p.onNewProject },
            { key: 'folder', icon: FolderPlus, label: t('projectsPdm.catalog.newFolder'), disabled: !p.canUpdate, onSelect: () => setOverlay({ kind: 'newFolder', parentId: p.folderId }) },
          ]}
          onClose={() => setOverlay((o) => (o?.kind === 'create' ? null : o))}
        />
      )}
      {overlay?.kind === 'filters' && (
        <FilterSheet status={p.status} onStatusChange={p.onStatusChange} sort={p.sort} onSortChange={p.onSortChange} onClose={() => setOverlay(null)} />
      )}
      {overlay?.kind === 'folder' && byId.get(overlay.id) && (
        <FolderSheet
          folder={byId.get(overlay.id)!}
          folders={p.folders}
          onRename={(name) => p.onRenameFolder(overlay.id, name)}
          onNewInside={() => setOverlay({ kind: 'newFolder', parentId: overlay.id })}
          onMove={(parentId) => p.onMoveFolder(overlay.id, parentId)}
          onDelete={() => p.onDeleteFolder(overlay.id)}
          onClose={() => setOverlay((o) => (o?.kind === 'folder' ? null : o))}
        />
      )}
      {overlay?.kind === 'newFolder' && (
        <NewFolderSheet
          parentName={overlay.parentId !== null ? folderPath(p.folders, overlay.parentId).join(' › ') : null}
          onCreate={(name) => p.onCreateFolder(name, overlay.parentId)}
          onClose={() => setOverlay(null)}
        />
      )}
    </div>
  );
}

function FolderRow({ folder, folders, canUpdate, onOpen, onMenu }: { folder: ProjectFolder; folders: ProjectFolder[]; canUpdate: boolean; onOpen: () => void; onMenu: () => void }) {
  const { t } = useTranslation();
  const subCount = folders.filter((f) => f.parent_id === folder.id).length;
  return (
    <li className="relative flex min-h-[3.75rem] items-center gap-3 py-2 pl-4 pr-1" data-testid={`catalog-mobile-folder-${folder.id}`}>
      <button type="button" onClick={onOpen} className="absolute inset-0 rounded-none active:bg-white/5" aria-label={folder.name} />
      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-amber-300/20 bg-amber-300/10 text-amber-200/90"><Folder className="h-5 w-5" aria-hidden /></div>
      <div className="pointer-events-none min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium text-white">{folder.name}</div>
        <div className="truncate text-[11px] text-bambu-gray">
          {t('projectsPdm.catalog.mobile.projects', { count: folder.project_count })}
          {subCount > 0 && ` · ${t('projectsPdm.catalog.mobile.folders', { count: subCount })}`}
          {folder.in_production_count > 0 && (
            <span className="text-amber-300"> · <Flame className="inline h-3 w-3" aria-hidden />{t('projectsPdm.catalog.mobile.inProductionCount', { count: folder.in_production_count })}</span>
          )}
        </div>
      </div>
      <ChevronRight className="pointer-events-none h-4 w-4 shrink-0 text-bambu-gray" aria-hidden />
      {canUpdate && (
        <button type="button" onClick={onMenu} aria-label={t('projectsPdm.catalog.folderActions')}
          className={`relative grid h-10 w-10 shrink-0 place-items-center rounded-lg text-bambu-gray active:text-white ${focusRingCls}`}>
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </button>
      )}
    </li>
  );
}

function ProjectRow({ item, q, path, onOpen }: { item: ProjectCatalogItem; q: string; path: string[]; onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const r = item.recommended;
  const who = [...item.client_names, ...item.open_orders.map((o) => t('projectsPdm.catalog.order', { id: o.order_id }))];
  const file = item.files_count === 0 ? t('projectsPdm.catalog.noFileYet') : r ? null : t('projectsPdm.catalog.nothingSliced');
  return (
    <li data-testid={`catalog-mobile-row-${item.id}`}>
      <button type="button" onClick={() => onOpen(item.id)} className={`flex min-h-[4.5rem] w-full items-center gap-3 px-4 py-2.5 text-left active:bg-white/5 ${focusRingCls}`}>
        <Thumb item={item} className="h-14 w-14" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <CodeMark item={item} q={q} />
            <InProductionFlame item={item} />
            <span className="ml-auto text-xs tabular-nums"><PrintedCell item={item} /></span>
          </div>
          <div className="truncate text-[15px] text-white"><Highlight text={item.name} q={q} /></div>
          {path.length > 0 && <div className="flex items-center gap-1 truncate text-[11px] text-bambu-gray/70"><Folder className="h-3 w-3 shrink-0" aria-hidden />{path.join(' › ')}</div>}
          <div className="truncate text-[11px] text-bambu-gray">{who.length > 0 ? who.map((w, i) => <span key={i}>{i > 0 && ' · '}<Highlight text={w} q={q} /></span>) : <span className="text-bambu-gray/60">{t('projectsPdm.catalog.internal')}</span>}</div>
          <div className="truncate text-[11px] text-bambu-gray">
            {file ?? (r && <><span className="text-bambu-green">{`R${r.number}`}</span> <Highlight text={r.item_name} q={q} />{r.filament_types.length > 0 && ` · ${r.filament_types.join(', ')}`}</>)}
            {` · ${formatRelativeTime(item.last_activity, 'system', t)}`}
          </div>
        </div>
      </button>
    </li>
  );
}
