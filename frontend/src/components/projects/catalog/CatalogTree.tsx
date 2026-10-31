import { useRef, useState } from 'react';
import type { DragEvent, FormEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Box, ChevronDown, ChevronRight, Flame, Folder, FolderInput, FolderOpen, FolderPlus, Inbox, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { api } from '../../../api/client';
import type { ProjectCatalogItem, ProjectFolder } from '../../../api/client';
import { ContextMenu } from '../../ContextMenu';
import type { ContextMenuItem } from '../../ContextMenu';
import { focusRingCls, inputCls } from '../../formStyles';
import { formatRelativeTime } from '../../../utils/date';
import { folderPath, splitHighlight } from './catalogRules';
import type { TreeNode } from './catalogRules';

export interface CatalogTreeProps {
  nodes: TreeNode[];
  folders: ProjectFolder[];
  q: string;
  /** A search or a chip is active: rows are flat and carry their folder path. */
  filtering: boolean;
  selectedId: number | null;
  canUpdate: boolean;
  onSelect: (projectId: number) => void;
  onToggleFolder: (folderId: number) => void;
  onMoveProject: (projectId: number, folderId: number | null) => void;
  onCreateFolder: (name: string, parentId: number | null) => Promise<boolean>;
  onRenameFolder: (folderId: number, name: string) => Promise<boolean>;
  onDeleteFolder: (folderId: number) => void;
  /** The inline "new folder" row: its parent while open, undefined while closed. */
  creating: { parentId: number | null } | null;
  onCreatingChange: (next: { parentId: number | null } | null) => void;
}

const DRAG_TYPE = 'application/x-fenrir-project';

/** Text with the search terms marked. */
export function Highlight({ text, q }: { text: string; q: string }) {
  return (
    <>
      {splitHighlight(text, q).map((seg, i) =>
        seg.hit ? <mark key={i} className="rounded-sm bg-bambu-green/30 text-inherit">{seg.text}</mark> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

function Thumb({ item, className }: { item: ProjectCatalogItem; className: string }) {
  return (
    <div className={`${className} flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark`}>
      {item.thumbnail_file_id !== null ? (
        <img src={api.getLibraryFileThumbnailUrl(item.thumbnail_file_id)} alt="" loading="lazy" className="h-full w-full object-cover brightness-125 contrast-110" />
      ) : (
        <Box className="h-4 w-4 text-bambu-gray/40" aria-hidden />
      )}
    </div>
  );
}

/** The one-line facts under a project's title: client, files · recommended revision, material, activity. */
function factsLine(item: ProjectCatalogItem, t: (k: string, o?: Record<string, unknown>) => string): string {
  const parts: string[] = [];
  if (item.client_names.length > 0) parts.push(item.client_names.join(', '));
  if (item.files_count === 0) parts.push(t('projectsPdm.catalog.noFileYet'));
  else {
    parts.push(t('projectsPdm.catalog.filesCount', { count: item.files_count }));
    if (item.recommended) parts.push(`R${item.recommended.number} ${item.recommended.item_name}`);
    else if (item.has_unsliced_only) parts.push(t('projectsPdm.catalog.nothingSliced'));
  }
  if (item.recommended?.filament_types.length) parts.push(item.recommended.filament_types.join(', '));
  parts.push(formatRelativeTime(item.last_activity, 'system', t));
  return parts.join(' · ');
}

function printedCell(item: ProjectCatalogItem) {
  if (item.target_count) {
    const done = item.printed_count >= item.target_count;
    return <span className={done ? 'text-bambu-green' : 'text-white'}>{`${item.printed_count}/${item.target_count}`}</span>;
  }
  return item.printed_count > 0 ? <span className="text-white">{item.printed_count}</span> : <span className="text-bambu-gray/50">—</span>;
}

export function CatalogTree(props: CatalogTreeProps) {
  const { t } = useTranslation();
  const { nodes, folders, q, filtering, selectedId, canUpdate, creating } = props;
  const [dragOver, setDragOver] = useState<number | 'root' | null>(null);
  const [moving, setMoving] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [menu, setMenu] = useState<{ folder: ProjectFolder; x: number; y: number } | null>(null);
  const menuAnchor = useRef<HTMLButtonElement>(null);

  const dropTarget = (key: number | 'root') => ({
    onDragOver: (e: DragEvent) => {
      if (!canUpdate || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragOver !== key) setDragOver(key);
    },
    onDragLeave: () => setDragOver((current) => (current === key ? null : current)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      const id = Number(e.dataTransfer.getData(DRAG_TYPE));
      if (id) props.onMoveProject(id, key === 'root' ? null : key);
    },
  });

  const submitNewFolder = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = (new FormData(e.currentTarget).get('name') as string).trim();
    const parent = (new FormData(e.currentTarget).get('parent') as string) || '';
    if (!name) return;
    if (await props.onCreateFolder(name, parent ? Number(parent) : null)) props.onCreatingChange(null);
  };

  const newFolderRow = creating && (
    <li className="px-3 py-2">
      <form onSubmit={(e) => void submitNewFolder(e)} className="flex flex-wrap items-center gap-2 text-sm">
        <FolderPlus className="h-4 w-4 text-amber-200/80" aria-hidden />
        <input name="name" autoFocus aria-label={t('projectsPdm.catalog.folderName')} placeholder={t('projectsPdm.catalog.folderName')}
          className={`${inputCls} min-w-[10rem] flex-1`} onKeyDown={(e) => e.key === 'Escape' && props.onCreatingChange(null)} />
        <select name="parent" defaultValue={creating.parentId ?? ''} aria-label={t('projectsPdm.catalog.atTop')}
          className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-2 text-xs text-bambu-gray-light">
          <option value="">{t('projectsPdm.catalog.atTop')}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>{t('projectsPdm.catalog.inFolder', { path: folderPath(folders, f.id).join(' › ') })}</option>
          ))}
        </select>
        <button type="submit" className={`rounded-lg bg-bambu-green px-2.5 py-1.5 text-xs font-medium text-white ${focusRingCls}`}>{t('projectsPdm.catalog.create')}</button>
        <button type="button" onClick={() => props.onCreatingChange(null)} className={`rounded px-2 py-1.5 text-xs text-bambu-gray hover:text-white ${focusRingCls}`}>{t('common.cancel')}</button>
      </form>
    </li>
  );

  const folderMenuItems = (folder: ProjectFolder): ContextMenuItem[] => [
    { label: t('projectsPdm.catalog.rename'), icon: <Pencil className="h-4 w-4" />, onClick: () => setRenaming({ id: folder.id, name: folder.name }) },
    { label: t('projectsPdm.catalog.newFolder'), icon: <FolderPlus className="h-4 w-4" />, onClick: () => props.onCreatingChange({ parentId: folder.id }) },
    { label: t('projectsPdm.catalog.deleteFolder'), icon: <Trash2 className="h-4 w-4" />, danger: true, title: t('projectsPdm.catalog.deleteFolderHint'), onClick: () => props.onDeleteFolder(folder.id) },
  ];

  const renderFolder = (node: Extract<TreeNode, { kind: 'folder' }>): ReactNode => {
    const { folder, depth, collapsed } = node;
    const isRenaming = renaming?.id === folder.id;
    return (
      <li key={`f${folder.id}`} data-testid={`catalog-folder-${folder.id}`} {...dropTarget(folder.id)}
        className={`group flex items-center gap-2 px-3 py-1.5 text-sm ${dragOver === folder.id ? 'bg-bambu-green/15 ring-1 ring-inset ring-bambu-green' : 'hover:bg-bambu-dark-tertiary/40'}`}
        style={{ paddingLeft: 12 + depth * 18 }}>
        <button type="button" aria-expanded={!collapsed} onClick={() => props.onToggleFolder(folder.id)}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded text-left ${focusRingCls}`}>
          {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-bambu-gray" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-bambu-gray" aria-hidden />}
          {collapsed ? <Folder className="h-4 w-4 shrink-0 text-amber-200/80" aria-hidden /> : <FolderOpen className="h-4 w-4 shrink-0 text-amber-200/80" aria-hidden />}
          {isRenaming ? (
            <form className="flex-1" onSubmit={(e) => { e.preventDefault(); void props.onRenameFolder(folder.id, renaming.name).then((ok) => ok && setRenaming(null)); }}>
              <input autoFocus value={renaming.name} aria-label={t('projectsPdm.catalog.folderName')} onChange={(e) => setRenaming({ id: folder.id, name: e.target.value })}
                onBlur={() => setRenaming(null)} onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} onClick={(e) => e.stopPropagation()} className={`${inputCls} py-0.5 text-sm`} />
            </form>
          ) : (
            <span className="truncate font-medium text-white"><Highlight text={folder.name} q={q} /></span>
          )}
          <span className="text-[11px] text-bambu-gray">{folder.project_count}</span>
          {folder.in_production_count > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] text-amber-300"><Flame className="h-3 w-3" aria-hidden />{folder.in_production_count}</span>
          )}
        </button>
        {canUpdate && (
          <button type="button" aria-label={t('projectsPdm.catalog.folderActions')} title={t('projectsPdm.catalog.folderActions')} aria-haspopup="menu"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); menuAnchor.current = e.currentTarget; setMenu({ folder, x: r.right, y: r.bottom }); }}
            className={`rounded p-1 text-bambu-gray opacity-60 hover:bg-bambu-dark-tertiary hover:text-white group-hover:opacity-100 ${focusRingCls}`}>
            <MoreVertical className="h-4 w-4" />
          </button>
        )}
      </li>
    );
  };

  const renderProject = (node: Extract<TreeNode, { kind: 'project' }>): ReactNode => {
    const { item, depth } = node;
    const selected = item.id === selectedId;
    const path = filtering ? folderPath(folders, item.folder_id) : [];
    return (
      <li key={`p${item.id}`}>
        <div role="option" aria-selected={selected} data-testid={`catalog-row-${item.id}`} tabIndex={-1}
          draggable={canUpdate} onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, String(item.id)); e.dataTransfer.effectAllowed = 'move'; }}
          onClick={() => props.onSelect(item.id)}
          className={`flex cursor-pointer items-center gap-3 px-3 py-2 ${selected ? 'bg-bambu-green/10 shadow-[inset_3px_0_0_theme(colors.bambu.green)]' : 'hover:bg-bambu-dark-tertiary/40'}`}
          style={{ paddingLeft: 12 + depth * 18 }}>
          <Thumb item={item} className="h-10 w-10" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {item.code && <span className="font-mono text-[11px] text-bambu-green"><Highlight text={item.code} q={q} /></span>}
              <span className="truncate text-sm text-white"><Highlight text={item.name} q={q} /></span>
              {item.open_orders.length > 0 && <Flame className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-label={t('projectsPdm.catalog.inProduction')} />}
            </div>
            {path.length > 0 && (
              <div className="flex items-center gap-1 text-[11px] text-bambu-gray/70"><Folder className="h-3 w-3" aria-hidden />{path.join(' › ')}</div>
            )}
            <div className="truncate text-[11px] text-bambu-gray">{factsLine(item, t)}</div>
          </div>
          <span className="text-xs">{printedCell(item)}</span>
          {canUpdate && (
            <button type="button" aria-label={t('projectsPdm.catalog.moveTo')} title={t('projectsPdm.catalog.moveTo')}
              onClick={(e) => { e.stopPropagation(); setMoving((m) => (m === item.id ? null : item.id)); }}
              className={`rounded p-1 text-bambu-gray/60 hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}>
              <FolderInput className="h-4 w-4" />
            </button>
          )}
        </div>
        {moving === item.id && (
          <div className="flex items-center gap-2 bg-bambu-dark/60 px-3 py-2 text-xs text-bambu-gray" style={{ paddingLeft: 12 + depth * 18 + 52 }}>
            <FolderInput className="h-3.5 w-3.5" aria-hidden />
            <select autoFocus aria-label={t('projectsPdm.catalog.moveTo')} defaultValue={item.folder_id ?? ''}
              onChange={(e) => { props.onMoveProject(item.id, e.target.value ? Number(e.target.value) : null); setMoving(null); }}
              onKeyDown={(e) => e.key === 'Escape' && setMoving(null)}
              className="rounded border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-xs text-white">
              <option value="">{t('projectsPdm.catalog.noFolder')}</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{folderPath(folders, f.id).join(' › ')}</option>)}
            </select>
            <button type="button" onClick={() => setMoving(null)} className={`ml-auto rounded px-1 hover:text-white ${focusRingCls}`}>{t('common.cancel')}</button>
          </div>
        )}
      </li>
    );
  };

  return (
    <>
      <ul role="listbox" aria-label={t('projectsPdm.title')} className="divide-y divide-bambu-dark-tertiary/60">
        {newFolderRow}
        {nodes.map((node) =>
          node.kind === 'folder' ? renderFolder(node) : node.kind === 'project' ? renderProject(node) : (
            <li key="unfiled" {...dropTarget('root')}
              className={`flex items-center gap-2 px-3 pb-1 pt-3 text-[11px] uppercase tracking-wide text-bambu-gray ${dragOver === 'root' ? 'bg-bambu-green/15' : ''}`}>
              <Inbox className="h-3.5 w-3.5" aria-hidden />{t('projectsPdm.catalog.notInFolder')}<span>{node.count}</span>
            </li>
          ),
        )}
      </ul>
      {menu && createPortal(
        <ContextMenu x={menu.x} y={menu.y} items={folderMenuItems(menu.folder)} onClose={() => setMenu(null)} anchorRef={menuAnchor} />,
        document.body,
      )}
    </>
  );
}
