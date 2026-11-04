import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent, ReactNode, TouchEvent as ReactTouchEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type {
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  DropAnimationFunctionArguments,
  MouseSensorOptions,
  TouchSensorOptions,
  UniqueIdentifier,
} from '@dnd-kit/core';
import { ArrowRight, ChevronRight, Flame, Folder, FolderInput, FolderOpen, FolderPlus, Inbox, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import type { ProjectCatalogItem, ProjectFolder } from '../../../api/client';
import { ContextMenu } from '../../ContextMenu';
import { Tooltip } from '../../Tooltip';
import type { ContextMenuItem } from '../../ContextMenu';
import { focusRingCls, inputCls } from '../../formStyles';
import { useReducedMotion } from '../../../hooks/useReducedMotion';
import { formatRelativeTime } from '../../../utils/date';
import { descendantIds, folderPath } from './catalogRules';
import { CodeMark, Highlight, InProductionFlame, PrintedCell, Thumb } from './CatalogRowParts';
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
  /** Opens or closes one folder (a drag hovering a closed folder springs it open). */
  onSetFolderOpen: (folderId: number, open: boolean) => void;
  onMoveProject: (projectId: number, folderId: number | null) => void;
  onCreateFolder: (name: string, parentId: number | null) => Promise<boolean>;
  onRenameFolder: (folderId: number, name: string) => Promise<boolean>;
  onDeleteFolder: (folderId: number) => void;
  /** Files a folder under another (null = top level); nesting has no depth limit. */
  onMoveFolder: (folderId: number, parentId: number | null) => void;
  /** Set when the user may delete projects: each project row gets a ⋯ menu with a hold-to-delete entry. */
  onDeleteProject?: (projectId: number) => void;
  /** The inline "new folder" row: its parent while open, undefined while closed. */
  creating: { parentId: number | null } | null;
  onCreatingChange: (next: { parentId: number | null } | null) => void;
  /** The folder a click just opened: its rows cascade in once. */
  revealed?: { folderId: number; nonce: number } | null;
}

/** dnd-kit ids: `project:<id>` and `folder:<id>` rows, `root` for the "Not in a folder" head. */
type DragItem = { kind: 'project'; id: number } | { kind: 'folder'; id: number };
type GroupKey = number | 'root';
/** Where a drop files things: the folder (null = top level) and the row that stands for it. */
interface DropTarget {
  folderId: number | null;
  key: GroupKey;
}
type Validity = 'valid' | 'noop' | 'invalid';

const dragId = (item: DragItem) => `${item.kind}:${item.id}`;
function parseDragId(id: UniqueIdentifier): DragItem | 'root' | null {
  if (id === 'root') return 'root';
  const [kind, raw] = String(id).split(':');
  const n = Number(raw);
  if ((kind === 'project' || kind === 'folder') && Number.isFinite(n)) return { kind, id: n };
  return null;
}
const rowKey = (key: GroupKey) => (key === 'root' ? 'root' : `f${key}`);

const EASE_SIGNATURE = 'cubic-bezier(0.22, 1, 0.36, 1)'; // var(--ease-signature)
/** How long a drag hovers a closed folder before it springs open (Finder: ~0.6 s). */
const SPRING_OPEN_MS = 600;
const RECEIVE_MS = 700;
const LANDED_MS = 900;

/** The press on a row's controls is theirs — a folder's menu, a form field — except the
 *  folder's own toggle, which is also the row's grip (it is most of the row). */
function grabbable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  const hit = target.closest('[data-drag-grip], button, a, input, select, textarea');
  return hit === null || hit.hasAttribute('data-drag-grip');
}
class RowMouseSensor extends MouseSensor {
  static activators = [
    {
      eventName: 'onMouseDown' as const,
      handler: ({ nativeEvent: event }: ReactMouseEvent, { onActivation }: MouseSensorOptions) => {
        if (event.button !== 0 || !grabbable(event.target)) return false;
        onActivation?.({ event });
        return true;
      },
    },
  ];
}
class RowTouchSensor extends TouchSensor {
  static activators = [
    {
      eventName: 'onTouchStart' as const,
      handler: ({ nativeEvent: event }: ReactTouchEvent, { onActivation }: TouchSensorOptions) => {
        if (event.touches.length > 1 || !grabbable(event.target)) return false;
        onActivation?.({ event });
        return true;
      },
    },
  ];
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

const indent = (depth: number): CSSProperties => ({ paddingLeft: 12 + depth * 18 });

/** What a project row shows — in the list and, unchanged, under the pointer while it is dragged. */
function ProjectRowBody({ item, q, path }: { item: ProjectCatalogItem; q: string; path: string[] }) {
  const { t } = useTranslation();
  return (
    <>
      <Thumb item={item} className="h-10 w-10" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <CodeMark item={item} q={q} />
          <span className="truncate text-sm text-white"><Highlight text={item.name} q={q} /></span>
          <InProductionFlame item={item} />
        </div>
        {path.length > 0 && (
          <div className="flex items-center gap-1 text-[11px] text-bambu-gray/70"><Folder className="h-3 w-3" aria-hidden />{path.join(' › ')}</div>
        )}
        <div className="truncate text-[11px] text-bambu-gray">{factsLine(item, t)}</div>
      </div>
      <span className="text-xs"><PrintedCell item={item} /></span>
    </>
  );
}

/** A folder row's glyphs and name — shared with its drag ghost. */
function FolderRowBody({ folder, collapsed, q, children }: { folder: ProjectFolder; collapsed: boolean; q: string; children?: ReactNode }) {
  return (
    <>
      <ChevronRight className="catalog-chevron h-3.5 w-3.5 shrink-0 text-bambu-gray" data-open={!collapsed} aria-hidden />
      {collapsed ? (
        <Folder className="catalog-folder-icon h-4 w-4 shrink-0 text-amber-200/80" aria-hidden />
      ) : (
        <FolderOpen className="catalog-folder-icon h-4 w-4 shrink-0 text-amber-200/80" aria-hidden />
      )}
      {children ?? <span className="truncate font-medium text-white"><Highlight text={folder.name} q={q} /></span>}
      <span className="text-[11px] text-bambu-gray">{folder.project_count}</span>
      {folder.in_production_count > 0 && (
        <span className="flex items-center gap-0.5 text-[11px] text-amber-300"><Flame className="h-3 w-3" aria-hidden />{folder.in_production_count}</span>
      )}
    </>
  );
}

/** One drag's live state. `target` is where a drop would file the row right now. */
interface DragState {
  item: DragItem;
  target: DropTarget | null;
}

interface RowCommon {
  canDrag: boolean;
  /** The row sits in the group a drop would file into: a faint wash. */
  tinted: boolean;
  /** The row just unfolded: its slot in the cascade, or -1. */
  revealSlot: number;
}

function revealStyle(slot: number): CSSProperties | undefined {
  return slot >= 0 ? ({ '--reveal-delay': `${Math.min(slot, 6) * 18}ms` } as CSSProperties) : undefined;
}

function ProjectRow({
  node,
  q,
  filtering,
  folders,
  selected,
  landed,
  onSelect,
  onOpenMenu,
  canDrag,
  tinted,
  revealSlot,
}: RowCommon & {
  /** Opens the row's ⋯ menu; absent, the row has none. */
  onOpenMenu?: (item: ProjectCatalogItem, anchor: HTMLButtonElement) => void;
  node: Extract<TreeNode, { kind: 'project' }>;
  q: string;
  filtering: boolean;
  folders: ProjectFolder[];
  selected: boolean;
  landed: boolean;
  onSelect: (projectId: number) => void;
}) {
  const { t } = useTranslation();
  const { item, depth } = node;
  const id = dragId({ kind: 'project', id: item.id });
  const { setNodeRef: setDragRef, listeners, isDragging } = useDraggable({ id, disabled: !canDrag });
  const { setNodeRef: setDropRef } = useDroppable({ id, disabled: !canDrag });
  const path = filtering ? folderPath(folders, item.folder_id) : [];
  return (
    <li className={revealSlot >= 0 ? 'catalog-row-reveal' : undefined} style={revealStyle(revealSlot)}>
      <div
        ref={(el) => {
          setDragRef(el);
          setDropRef(el);
        }}
        role="option"
        aria-selected={selected}
        data-testid={`catalog-row-${item.id}`}
        data-catalog-row
        tabIndex={-1}
        onClick={() => onSelect(item.id)}
        {...listeners}
        className={`flex cursor-pointer touch-manipulation items-center gap-3 px-3 py-2 ${
          selected ? 'bg-bambu-green/10 shadow-[inset_3px_0_0_theme(colors.bambu.green)]' : tinted ? 'bg-bambu-green/[0.06]' : 'hover:bg-bambu-dark-tertiary/40'
        } ${isDragging ? 'opacity-40' : ''} ${landed ? 'catalog-landed' : ''}`}
        style={indent(depth)}
      >
        <ProjectRowBody item={item} q={q} path={path} />
        {onOpenMenu && (
          <button type="button" aria-label={t('projectsPdm.catalog.projectActions')} aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              onOpenMenu(item, e.currentTarget);
            }}
            className={`-mr-1 rounded p-1 text-bambu-gray opacity-60 transition-opacity duration-100 hover:bg-bambu-dark-tertiary hover:text-white hover:opacity-100 focus-visible:opacity-100 ${focusRingCls}`}>
            <MoreVertical className="h-4 w-4" />
          </button>
        )}
      </div>
    </li>
  );
}

function FolderRow({
  node,
  q,
  folders,
  isTarget,
  receiving,
  landed,
  renaming,
  onRenamingChange,
  movingFolder,
  onMovingFolderChange,
  onToggleFolder,
  onRenameFolder,
  onMoveFolder,
  onOpenMenu,
  canUpdate,
  canDrag,
  tinted,
  revealSlot,
  registerEl,
}: RowCommon & {
  node: Extract<TreeNode, { kind: 'folder' }>;
  /** Hands the row's element to the tree (the drop animation lands the ghost on it). */
  registerEl: (el: HTMLElement | null) => void;
  q: string;
  folders: ProjectFolder[];
  isTarget: boolean;
  receiving: boolean;
  landed: boolean;
  renaming: { id: number; name: string } | null;
  onRenamingChange: (next: { id: number; name: string } | null) => void;
  movingFolder: number | null;
  onMovingFolderChange: (next: number | null) => void;
  onToggleFolder: (folderId: number) => void;
  onRenameFolder: (folderId: number, name: string) => Promise<boolean>;
  onMoveFolder: (folderId: number, parentId: number | null) => void;
  onOpenMenu: (folder: ProjectFolder, anchor: HTMLButtonElement) => void;
  canUpdate: boolean;
}) {
  const { t } = useTranslation();
  const { folder, depth, collapsed } = node;
  const id = dragId({ kind: 'folder', id: folder.id });
  const isRenaming = renaming?.id === folder.id;
  const { setNodeRef: setDragRef, listeners, isDragging } = useDraggable({ id, disabled: !canDrag || isRenaming });
  const { setNodeRef: setDropRef } = useDroppable({ id, disabled: !canDrag });
  const blocked = descendantIds(folders, folder.id);
  return (
    <li
      ref={(el) => {
        setDragRef(el);
        setDropRef(el);
        registerEl(el);
      }}
      data-testid={`catalog-folder-${folder.id}`}
      data-catalog-row
      {...listeners}
      className={`group flex flex-wrap touch-manipulation items-center gap-2 px-3 py-1.5 text-sm ${
        isTarget ? 'bg-bambu-green/15 ring-1 ring-inset ring-bambu-green' : tinted ? 'bg-bambu-green/[0.06]' : 'hover:bg-bambu-dark-tertiary/40'
      } ${isDragging ? 'opacity-40' : ''} ${receiving ? 'catalog-receive' : ''} ${landed ? 'catalog-landed' : ''} ${revealSlot >= 0 ? 'catalog-row-reveal' : ''}`}
      style={{ ...indent(depth), ...revealStyle(revealSlot) }}
    >
      <button type="button" aria-expanded={!collapsed} onClick={() => onToggleFolder(folder.id)} data-drag-grip
        className={`flex min-w-0 flex-1 items-center gap-2 rounded text-left ${focusRingCls}`}>
        <FolderRowBody folder={folder} collapsed={collapsed} q={q}>
          {isRenaming ? (
            <form className="flex-1" onSubmit={(e) => { e.preventDefault(); void onRenameFolder(folder.id, renaming.name).then((ok) => ok && onRenamingChange(null)); }}>
              <input autoFocus value={renaming.name} aria-label={t('projectsPdm.catalog.folderName')} onChange={(e) => onRenamingChange({ id: folder.id, name: e.target.value })}
                onBlur={() => onRenamingChange(null)} onKeyDown={(e) => e.key === 'Escape' && onRenamingChange(null)} onClick={(e) => e.stopPropagation()} className={`${inputCls} py-0.5 text-sm`} />
            </form>
          ) : undefined}
        </FolderRowBody>
      </button>
      {canUpdate && (
        <Tooltip content={t('projectsPdm.catalog.folderActions')} side="bottom" align="end">
          <button type="button" aria-label={t('projectsPdm.catalog.folderActions')} aria-haspopup="menu"
            onClick={(e) => onOpenMenu(folder, e.currentTarget)}
            className={`rounded p-1 text-bambu-gray opacity-60 transition-opacity duration-100 hover:bg-bambu-dark-tertiary hover:text-white group-hover:opacity-100 ${focusRingCls}`}>
            <MoreVertical className="h-4 w-4" />
          </button>
        </Tooltip>
      )}
      {movingFolder === folder.id && (
        <div className="animate-rise-sm flex basis-full items-center gap-2 py-1 text-xs text-bambu-gray" onClick={(e) => e.stopPropagation()}>
          <FolderInput className="h-3.5 w-3.5" aria-hidden />
          <select autoFocus aria-label={t('projectsPdm.catalog.moveTo')} defaultValue={folder.parent_id ?? ''}
            onChange={(e) => { onMoveFolder(folder.id, e.target.value ? Number(e.target.value) : null); onMovingFolderChange(null); }}
            onKeyDown={(e) => e.key === 'Escape' && onMovingFolderChange(null)}
            className="rounded border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-xs text-white">
            <option value="">{t('projectsPdm.catalog.atTop')}</option>
            {folders.filter((f) => !blocked.has(f.id)).map((f) => <option key={f.id} value={f.id}>{folderPath(folders, f.id).join(' › ')}</option>)}
          </select>
          <button type="button" onClick={() => onMovingFolderChange(null)} className={`ml-auto rounded px-1 hover:text-white ${focusRingCls}`}>{t('common.cancel')}</button>
        </div>
      )}
    </li>
  );
}

function UnfiledRow({
  count,
  isTarget,
  receiving,
  canDrag,
  registerEl,
}: {
  count: number;
  isTarget: boolean;
  receiving: boolean;
  canDrag: boolean;
  registerEl: (el: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  const { setNodeRef } = useDroppable({ id: 'root', disabled: !canDrag });
  return (
    <li
      ref={(el) => {
        setNodeRef(el);
        registerEl(el);
      }}
      data-catalog-row
      data-testid="catalog-unfiled"
      className={`flex items-center gap-2 px-3 pb-1 pt-3 text-[11px] uppercase tracking-wide text-bambu-gray ${isTarget ? 'bg-bambu-green/15' : ''} ${receiving ? 'catalog-receive' : ''}`}>
      <Inbox className="catalog-folder-icon h-3.5 w-3.5" aria-hidden />{t('projectsPdm.catalog.notInFolder')}<span>{count}</span>
    </li>
  );
}

/** The tree's drop geometry, read off the flattened nodes: which folder each row files into,
 *  and the rows that make up each folder's group (the folder's own row excluded). */
function dropGeometry(nodes: readonly TreeNode[]) {
  const folderOfRow = new Map<string, GroupKey>();
  const groups = new Map<GroupKey, string[]>();
  const stack: number[] = []; // open folder ids by depth
  let inRoot = false;
  nodes.forEach((node) => {
    if (node.kind === 'unfiled') {
      stack.length = 0;
      inRoot = true;
      groups.set('root', []);
      return;
    }
    const depth = node.depth;
    const key = node.kind === 'folder' ? `f${node.folder.id}` : `p${node.item.id}`;
    const parent: GroupKey = inRoot ? 'root' : depth > 0 && stack[depth - 1] !== undefined ? stack[depth - 1] : 'root';
    folderOfRow.set(key, parent);
    // The row belongs to its folder's group and to every open folder above it.
    for (let d = 0; d < Math.min(depth, stack.length); d++) groups.get(stack[d])?.push(key);
    if (inRoot) groups.get('root')?.push(key);
    if (node.kind === 'folder') {
      stack.length = depth;
      stack[depth] = node.folder.id;
      groups.set(node.folder.id, []);
    }
  });
  return { folderOfRow, groups };
}

export function CatalogTree(props: CatalogTreeProps) {
  const { t } = useTranslation();
  const { nodes, folders, q, filtering, selectedId, canUpdate, creating, revealed, onDeleteProject } = props;
  const reducedMotion = useReducedMotion();
  const [drag, setDrag] = useState<DragState | null>(null);
  const [receiving, setReceiving] = useState<{ key: GroupKey; nonce: number } | null>(null);
  const [landed, setLanded] = useState<{ key: string; nonce: number } | null>(null);
  const [movingFolder, setMovingFolder] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [menu, setMenu] = useState<{ items: ContextMenuItem[]; x: number; y: number } | null>(null);
  const navigate = useNavigate();
  const menuAnchor = useRef<HTMLButtonElement>(null);
  // Filing by drag needs the tree: a search result's folder is not on screen to drop on.
  const canDrag = canUpdate && !filtering;

  const sensors = useSensors(
    // 5px before a press becomes a drag, so a click still selects and a grab feels immediate.
    useSensor(RowMouseSensor, { activationConstraint: { distance: 5 } }),
    // Press and hold on touch: a swipe still scrolls the list.
    useSensor(RowTouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  const itemsById = useMemo(() => {
    const out = new Map<number, ProjectCatalogItem>();
    nodes.forEach((n) => n.kind === 'project' && out.set(n.item.id, n.item));
    return out;
  }, [nodes]);
  const foldersById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const { folderOfRow, groups } = useMemo(() => dropGeometry(nodes), [nodes]);
  const collapsedIds = useMemo(() => new Set(nodes.flatMap((n) => (n.kind === 'folder' && n.collapsed ? [n.folder.id] : []))), [nodes]);

  /** Where a drop on `overId` would file the dragged row; null over itself or outside the list. */
  const resolveTarget = useCallback(
    (item: DragItem, overId: UniqueIdentifier | undefined): DropTarget | null => {
      if (overId === undefined || overId === dragId(item)) return null;
      const parsed = parseDragId(overId);
      if (parsed === null) return null;
      if (parsed === 'root') return { folderId: null, key: 'root' };
      if (parsed.kind === 'folder') return { folderId: parsed.id, key: parsed.id };
      const key = folderOfRow.get(`p${parsed.id}`) ?? 'root';
      return { folderId: key === 'root' ? null : key, key };
    },
    [folderOfRow],
  );

  const validity = useCallback(
    (item: DragItem, target: DropTarget): Validity => {
      if (item.kind === 'project') {
        const current = folderOfRow.get(`p${item.id}`) ?? 'root';
        return current === target.key ? 'noop' : 'valid';
      }
      if (descendantIds(folders, item.id).has(target.key as number)) return 'invalid';
      return (foldersById.get(item.id)?.parent_id ?? null) === target.folderId ? 'noop' : 'valid';
    },
    [folderOfRow, folders, foldersById],
  );

  const targetValidity = drag?.target ? validity(drag.item, drag.target) : null;
  const highlightKey = drag?.target && targetValidity !== 'invalid' ? drag.target.key : null;
  const tintedRows = useMemo(() => new Set(highlightKey === null ? [] : groups.get(highlightKey) ?? []), [groups, highlightKey]);

  // The ghost's landing, read by the drop animation: into the target row, or back home.
  const dropOutcome = useRef<{ kind: 'absorb'; rect: DOMRect } | { kind: 'return' }>({ kind: 'return' });
  const rowEls = useRef(new Map<string, HTMLElement>());
  const register = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) rowEls.current.set(key, el);
      else rowEls.current.delete(key);
    },
    [],
  );
  // Folders a hover sprang open during this drag; closed again unless the drop went inside.
  const sprung = useRef(new Set<number>());

  useEffect(() => {
    document.body.classList.toggle('catalog-dragging', drag !== null);
    return () => document.body.classList.remove('catalog-dragging');
  }, [drag]);

  // Spring-loaded folders: a drag parked over a closed folder opens it after a beat.
  const springKey = drag?.target && targetValidity !== 'invalid' && drag.target.key !== 'root' && collapsedIds.has(drag.target.key) ? drag.target.key : null;
  const { onSetFolderOpen } = props;
  useEffect(() => {
    if (springKey === null) return;
    const timer = window.setTimeout(() => {
      sprung.current.add(springKey);
      onSetFolderOpen(springKey, true);
    }, SPRING_OPEN_MS);
    return () => window.clearTimeout(timer);
  }, [springKey, onSetFolderOpen]);

  useEffect(() => {
    if (!receiving) return;
    const timer = window.setTimeout(() => setReceiving(null), RECEIVE_MS);
    return () => window.clearTimeout(timer);
  }, [receiving]);
  useEffect(() => {
    if (!landed) return;
    const timer = window.setTimeout(() => setLanded(null), LANDED_MS);
    return () => window.clearTimeout(timer);
  }, [landed]);

  const unspring = (keep: number | null) => {
    const keepIds = new Set<number>();
    for (let id = keep; id !== null; id = foldersById.get(id)?.parent_id ?? null) {
      if (keepIds.has(id)) break;
      keepIds.add(id);
    }
    sprung.current.forEach((id) => !keepIds.has(id) && onSetFolderOpen(id, false));
    sprung.current.clear();
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    const item = parseDragId(active.id);
    if (item === null || item === 'root') return;
    sprung.current.clear();
    setDrag({ item, target: null });
  };
  const onDragOver = ({ active, over }: DragOverEvent) => {
    const item = parseDragId(active.id);
    if (item === null || item === 'root') return;
    const target = resolveTarget(item, over?.id);
    setDrag((cur) => (cur && cur.target?.key === target?.key && cur.target?.folderId === target?.folderId ? cur : { item, target }));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const item = parseDragId(active.id);
    const target = item === null || item === 'root' ? null : resolveTarget(item, over?.id);
    const v = item !== null && item !== 'root' && target ? validity(item, target) : null;
    if (item && item !== 'root' && target && v !== 'invalid') {
      // The ghost settles onto the folder's own row (the drop may have been on a row inside it).
      const el = rowEls.current.get(rowKey(target.key));
      dropOutcome.current = el ? { kind: 'absorb', rect: el.getBoundingClientRect() } : { kind: 'return' };
      setReceiving((r) => ({ key: target.key, nonce: (r?.nonce ?? 0) + 1 }));
      if (v === 'valid') {
        setLanded((l) => ({ key: item.kind === 'project' ? `p${item.id}` : `f${item.id}`, nonce: (l?.nonce ?? 0) + 1 }));
        if (item.kind === 'project') props.onMoveProject(item.id, target.folderId);
        else props.onMoveFolder(item.id, target.folderId);
      }
      unspring(target.folderId);
    } else {
      dropOutcome.current = { kind: 'return' };
      unspring(null);
    }
    setDrag(null);
  };
  const onDragCancel = () => {
    dropOutcome.current = { kind: 'return' };
    unspring(null);
    setDrag(null);
  };

  /** The ghost's drop: it settles onto the row it was dropped on and dissolves, or flies
   *  home when nothing took it (dnd-kit's own return flight, on the app's curve). */
  const dropAnimation = useCallback(({ active, dragOverlay, transform }: DropAnimationFunctionArguments) => {
    const node = dragOverlay.node;
    if (typeof node.animate !== 'function') return;
    const outcome = dropOutcome.current;
    const from = `translate3d(${transform.x}px, ${transform.y}px, 0)`;
    if (outcome.kind === 'absorb') {
      const dx = outcome.rect.left - dragOverlay.rect.left;
      const dy = outcome.rect.top - dragOverlay.rect.top;
      const to = `translate3d(${transform.x + dx}px, ${transform.y + dy}px, 0)`;
      const animation = node.animate(
        [{ transform: from, opacity: 1, scale: '1' }, { transform: to, opacity: 0, scale: '0.97' }],
        { duration: 200, easing: EASE_SIGNATURE, fill: 'forwards' },
      );
      return new Promise<void>((resolve) => { animation.onfinish = () => resolve(); });
    }
    const to = `translate3d(${transform.x - (dragOverlay.rect.left - active.rect.left)}px, ${transform.y - (dragOverlay.rect.top - active.rect.top)}px, 0)`;
    node.firstElementChild?.classList.add('catalog-ghost-dropping');
    active.node.style.opacity = '0';
    const animation = node.animate([{ transform: from }, { transform: to }], { duration: 250, easing: EASE_SIGNATURE, fill: 'forwards' });
    return new Promise<void>((resolve) => {
      animation.onfinish = () => {
        active.node.style.opacity = '';
        resolve();
      };
    });
  }, []);

  const announceTarget = (over: { id: UniqueIdentifier } | null, item: DragItem) => {
    const target = resolveTarget(item, over?.id);
    if (!target) return undefined;
    return target.folderId === null ? t('projectsPdm.catalog.notInFolder') : t('projectsPdm.catalog.inFolder', { path: folderPath(folders, target.folderId).join(' › ') });
  };
  const nameOf = (item: DragItem) => (item.kind === 'project' ? itemsById.get(item.id)?.name : foldersById.get(item.id)?.name) ?? '';
  const announcements = {
    onDragStart: ({ active }: { active: { id: UniqueIdentifier } }) => {
      const item = parseDragId(active.id);
      return item && item !== 'root' ? nameOf(item) : undefined;
    },
    onDragOver: ({ active, over }: { active: { id: UniqueIdentifier }; over: { id: UniqueIdentifier } | null }) => {
      const item = parseDragId(active.id);
      return item && item !== 'root' ? announceTarget(over, item) : undefined;
    },
    onDragEnd: ({ active, over }: { active: { id: UniqueIdentifier }; over: { id: UniqueIdentifier } | null }) => {
      const item = parseDragId(active.id);
      return item && item !== 'root' ? announceTarget(over, item) : undefined;
    },
    onDragCancel: () => undefined,
  };

  const submitNewFolder = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = (new FormData(e.currentTarget).get('name') as string).trim();
    const parent = (new FormData(e.currentTarget).get('parent') as string) || '';
    if (!name) return;
    if (await props.onCreateFolder(name, parent ? Number(parent) : null)) props.onCreatingChange(null);
  };

  const newFolderRow = creating && (
    <li className="animate-rise-sm px-3 py-2">
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
        <button type="submit" className={`btn-press rounded-lg bg-bambu-green px-2.5 py-1.5 text-xs font-medium text-white ${focusRingCls}`}>{t('projectsPdm.catalog.create')}</button>
        <button type="button" onClick={() => props.onCreatingChange(null)} className={`btn-press rounded px-2 py-1.5 text-xs text-bambu-gray hover:text-white ${focusRingCls}`}>{t('common.cancel')}</button>
      </form>
    </li>
  );

  const folderMenuItems = (folder: ProjectFolder): ContextMenuItem[] => [
    { label: t('projectsPdm.catalog.rename'), icon: <Pencil className="h-4 w-4" />, onClick: () => setRenaming({ id: folder.id, name: folder.name }) },
    { label: t('projectsPdm.catalog.newFolder'), icon: <FolderPlus className="h-4 w-4" />, onClick: () => props.onCreatingChange({ parentId: folder.id }) },
    { label: t('projectsPdm.catalog.moveTo'), icon: <FolderInput className="h-4 w-4" />, onClick: () => setMovingFolder(folder.id) },
    { label: t('projectsPdm.catalog.deleteFolder'), icon: <Trash2 className="h-4 w-4" />, danger: true, title: t('projectsPdm.catalog.deleteFolderHint'), onClick: () => props.onDeleteFolder(folder.id) },
  ];

  const projectMenuItems = (item: ProjectCatalogItem, onDelete: (projectId: number) => void): ContextMenuItem[] => [
    { label: t('projectsPdm.catalog.openProject'), icon: <ArrowRight className="h-4 w-4" />, onClick: () => navigate(`/projects/${item.id}`) },
    { label: '', divider: true, onClick: () => {} },
    { label: t('projectsPdm.catalog.deleteProject'), icon: <Trash2 className="h-4 w-4" />, hold: true, title: t('aito.holdToDelete'), onClick: () => onDelete(item.id) },
  ];

  // The rows a click just unfolded: everything under that folder until the tree comes back
  // up to its level (or reaches the unfiled head), in list order.
  const revealSlots = useMemo(() => {
    const out = new Map<string, number>();
    if (!revealed) return out;
    const at = nodes.findIndex((n) => n.kind === 'folder' && n.folder.id === revealed.folderId);
    if (at === -1) return out;
    const depth = (nodes[at] as Extract<TreeNode, { kind: 'folder' }>).depth;
    for (let i = at + 1, slot = 0; i < nodes.length; i++, slot++) {
      const n = nodes[i];
      if (n.kind === 'unfiled' || n.depth <= depth) break;
      out.set(n.kind === 'folder' ? `f${n.folder.id}` : `p${n.item.id}`, slot);
    }
    return out;
  }, [nodes, revealed]);

  // The ghost under the pointer: the lifted row, laid out exactly as it is in the list (same
  // indent, same content) so the grab point stays under the finger.
  const dragNode = drag
    ? nodes.find((n) => (n.kind === 'project' && drag.item.kind === 'project' && n.item.id === drag.item.id) || (n.kind === 'folder' && drag.item.kind === 'folder' && n.folder.id === drag.item.id))
    : undefined;
  const ghost = dragNode && dragNode.kind !== 'unfiled' && (
    <div
      className="catalog-ghost rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary"
      data-invalid={targetValidity === 'invalid' || undefined}
      data-testid="catalog-drag-ghost"
    >
      {dragNode.kind === 'project' ? (
        <div className="flex items-center gap-3 px-3 py-2" style={indent(dragNode.depth)}>
          <ProjectRowBody item={dragNode.item} q={q} path={[]} />
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-1.5 text-sm" style={indent(dragNode.depth)}>
          <FolderRowBody folder={dragNode.folder} collapsed={dragNode.collapsed} q={q} />
        </div>
      )}
    </div>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      // Rows move under a live drag (a folder springs open), so targets are measured as they stand.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t('projectsPdm.catalog.dragHint') } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <ul role="listbox" aria-label={t('projectsPdm.title')} className={`divide-y divide-bambu-dark-tertiary/60 ${drag ? 'select-none' : ''}`}>
        {newFolderRow}
        {nodes.map((node) => {
          if (node.kind === 'unfiled') {
            return (
              <UnfiledRow key="unfiled" count={node.count} isTarget={highlightKey === 'root'} receiving={receiving?.key === 'root'} canDrag={canDrag} registerEl={register('root')} />
            );
          }
          if (node.kind === 'folder') {
            const key = `f${node.folder.id}`;
            return (
              <FolderRow
                  key={key}
                  node={node}
                  q={q}
                  folders={folders}
                  isTarget={highlightKey === node.folder.id}
                  receiving={receiving?.key === node.folder.id}
                  landed={landed?.key === key}
                  renaming={renaming}
                  onRenamingChange={setRenaming}
                  movingFolder={movingFolder}
                  onMovingFolderChange={setMovingFolder}
                  onToggleFolder={props.onToggleFolder}
                  onRenameFolder={props.onRenameFolder}
                  onMoveFolder={props.onMoveFolder}
                  onOpenMenu={(folder, anchor) => {
                    const r = anchor.getBoundingClientRect();
                    menuAnchor.current = anchor;
                    setMenu({ items: folderMenuItems(folder), x: r.right, y: r.bottom });
                  }}
                  canUpdate={canUpdate}
                  canDrag={canDrag}
                  tinted={tintedRows.has(key)}
                  revealSlot={revealSlots.get(key) ?? -1}
                  registerEl={register(key)}
                />
            );
          }
          const key = `p${node.item.id}`;
          return (
            <ProjectRow
              key={key}
              node={node}
              q={q}
              filtering={filtering}
              folders={folders}
              selected={node.item.id === selectedId}
              landed={landed?.key === key}
              onSelect={props.onSelect}
              onOpenMenu={onDeleteProject && ((item, anchor) => {
                const r = anchor.getBoundingClientRect();
                menuAnchor.current = anchor;
                setMenu({ items: projectMenuItems(item, onDeleteProject), x: r.right, y: r.bottom });
              })}
              canDrag={canDrag}
              tinted={tintedRows.has(key)}
              revealSlot={revealSlots.get(key) ?? -1}
            />
          );
        })}
      </ul>
      {createPortal(
        <DragOverlay dropAnimation={reducedMotion ? null : dropAnimation}>{ghost}</DragOverlay>,
        document.body,
      )}
      {menu && createPortal(
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} anchorRef={menuAnchor} />,
        document.body,
      )}
    </DndContext>
  );
}
