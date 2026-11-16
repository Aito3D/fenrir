import { useState, useRef, useId, type DragEvent } from 'react';
import {
  FolderOpen,
  Trash2,
  MoreVertical,
  ChevronRight,
  CalendarClock,
  Link2,
  Archive as ArchiveIcon,
  Briefcase,
  Pencil,
  Lock,
  FolderSymlink,
  Users,
  FolderInput, // Fenrir: Move to project (projects PDM phase 5)
} from 'lucide-react';
import type {
  LibraryFolderTree,
  Permission,
} from '../../api/client';
import { ContextMenu, type ContextMenuItem } from '../ContextMenu';
import { formatDate } from '../../utils/date';
import { FOLDER_DRAG_TYPE } from '../../utils/libraryFolders';
import { type TFunction } from './fileTypes';

// Folder drag and drop (#3305). The page owns the dragged folder (so drop
// targets can decide validity during dragover, when the payload is not yet
// readable), the one highlighted target and the mutation; rows and columns
// only report where it landed.
export interface FolderDragProps {
  canDrag: (folder: LibraryFolderTree) => boolean;
  onDragStart: (folder: LibraryFolderTree, e: DragEvent) => void;
  onDragEnd: () => void;
  // Would dropping the folder being dragged onto this destination (null =
  // root) be a real, allowed move? False while nothing is being dragged.
  canDropOn: (destinationId: number | null) => boolean;
  onDrop: (destinationId: number | null) => void;
  // The drop target under the pointer (a useId key), or null. Shared so a
  // column stops highlighting the moment a row inside it takes over.
  activeTarget: string | null;
  setActiveTarget: (key: string | null) => void;
}

// Drop-target behaviour for one destination: accepts the drag only when the
// page says the move is valid and highlights while it is the active target.
// A folder drag never travels past the innermost target, accepted or not:
// a row that refuses the drop (e.g. the folder's own parent) must not hand it
// to the column around it, which would move the folder somewhere else. It
// also keeps the drag away from the page-wide upload zone.
function useFolderDropTarget(folderDrag: FolderDragProps | undefined, destinationId: number | null) {
  const key = useId();
  if (!folderDrag) return { isOver: false, handlers: {} };
  const isFolderDrag = (e: DragEvent) => e.dataTransfer.types.includes(FOLDER_DRAG_TYPE);
  const claim = (e: DragEvent) => {
    e.stopPropagation();
    const accepted = folderDrag.canDropOn(destinationId);
    if (accepted) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    } else {
      // Not cancelling the event is what makes the browser show "no drop".
      e.dataTransfer.dropEffect = 'none';
    }
    const next = accepted ? key : null;
    if (folderDrag.activeTarget !== next) folderDrag.setActiveTarget(next);
  };
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (isFolderDrag(e)) claim(e);
    },
    onDragOver: (e: DragEvent) => {
      if (isFolderDrag(e)) claim(e);
    },
    onDragLeave: (e: DragEvent) => {
      const next = e.relatedTarget as Node | null;
      if ((!next || !(e.currentTarget as Node).contains(next)) && folderDrag.activeTarget === key) {
        folderDrag.setActiveTarget(null);
      }
    },
    onDrop: (e: DragEvent) => {
      if (!isFolderDrag(e)) return;
      e.stopPropagation();
      folderDrag.setActiveTarget(null);
      if (!folderDrag.canDropOn(destinationId)) return;
      e.preventDefault();
      folderDrag.onDrop(destinationId);
    },
  };
  return { isOver: folderDrag.activeTarget === key, handlers };
}

const FOLDER_DROP_TARGET_CLASS = 'ring-1 ring-inset ring-bambu-green bg-bambu-green/10';

// A plain div that is also a folder drop target — for hosts that render rows
// inside a `.map` and so cannot call the hook themselves.
type FolderDropZoneProps = React.HTMLAttributes<HTMLDivElement> & {
  folderDrag?: FolderDragProps;
  destinationId: number | null;
  // Accept drops at all; false renders a plain div (e.g. the external bucket).
  enabled?: boolean;
};

export function FolderDropZone({ folderDrag, destinationId, enabled = true, className = '', children, ...rest }: FolderDropZoneProps) {
  const { isOver, handlers } = useFolderDropTarget(enabled ? folderDrag : undefined, destinationId);
  return (
    <div {...rest} {...handlers} className={`${className} ${isOver ? FOLDER_DROP_TARGET_CLASS : ''}`}>
      {children}
    </div>
  );
}

// Folder Tree Item
interface FolderTreeItemProps {
  folder: LibraryFolderTree;
  selectedFolderId: number | null;
  onSelect: (id: number | null) => void;
  onDelete: (id: number) => void;
  onLink: (folder: LibraryFolderTree) => void;
  onRename: (folder: LibraryFolderTree) => void;
  onMove?: (folder: LibraryFolderTree) => void;
  onToggleShared?: (folder: LibraryFolderTree) => void;
  folderDrag?: FolderDragProps;
  depth?: number;
  wrapNames?: boolean;
  defaultExpanded?: boolean;
  showModified?: boolean;
  hasPermission: (permission: Permission) => boolean;
  t: TFunction;
}

// Folder kebab: Rename / Link / Delete. Shared by the tree sidebar and the
// columns view so both offer exactly the same entries and permission gates.
// Rendered through `ContextMenu` (position: fixed, anchored to the button)
// rather than an absolutely positioned dropdown, because both hosts scroll —
// a dropdown inside an overflow-y-auto column gets clipped at its edge.
interface FolderActionsMenuProps {
  folder: LibraryFolderTree;
  onDelete: (id: number) => void;
  onLink: (folder: LibraryFolderTree) => void;
  onRename: (folder: LibraryFolderTree) => void;
  // Move to root or into another folder (#3305). Not offered for external folders.
  onMove?: (folder: LibraryFolderTree) => void;
  // Share with every library:read_own user, or stop (#3201). library:update_all only.
  onToggleShared?: (folder: LibraryFolderTree) => void;
  hasPermission: (permission: Permission) => boolean;
  // Hide the kebab until its `group` row is hovered or focused — only for
  // pointers that can hover (#2865). The menu is a DOM descendant, so the
  // wrapper stays opaque while it is open: browsers that don't focus a button
  // on click (Safari) would otherwise fade the open menu out with the row.
  revealOnHover?: boolean;
  tabIndex?: number;
  t: TFunction;
}

export function FolderActionsMenu({ folder, onDelete, onLink, onRename, onMove, onToggleShared, hasPermission, revealOnHover = false, tabIndex, t }: FolderActionsMenuProps) {
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setMenuAnchor(null);
    // A menu entry activated by Enter unmounts with the menu; hand focus back
    // to the kebab rather than letting it drop to <body>. Focus that already
    // moved elsewhere (click-outside, the columns pane) is left alone.
    if (rootRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
  };
  const hasChildren = folder.children.length > 0;
  const isLinked = folder.project_id || folder.archive_id;
  const isExternal = folder.is_external;
  // The backend says what this user may do with the folder (#3201): delete
  // their own folder when everything in it is theirs, or an ownerless empty
  // one (#1781). The fallbacks cover a response without those fields.
  const canDeleteFolder =
    folder.can_delete ??
    (hasPermission('library:delete_all') ||
      (hasPermission('library:delete_own') && folder.file_count === 0 && !hasChildren && !isExternal && !isLinked));
  const deleteDisabledTooltip = canDeleteFolder
    ? undefined
    : hasPermission('library:delete_own') && !isExternal && !isLinked
      ? t('fileManager.onlyOwnFoldersDeletable')
      : t('fileManager.noPermissionDeleteFolder');
  const canRename = folder.can_rename ?? hasPermission('library:update_all');
  // Moving is the same backend update as renaming (#3305), so it follows the
  // same gate; the picker handles where the folder may go.
  const canMove = canRename;
  const canLink = hasPermission('library:update_all');

  const items: ContextMenuItem[] = [
    {
      label: t('common.rename'),
      icon: <Pencil className="w-3.5 h-3.5" />,
      onClick: () => onRename(folder),
      disabled: !canRename,
      title: !canRename ? t('fileManager.noPermissionRenameFolder') : undefined,
    },
    ...(onMove && !isExternal
      ? [
          {
            label: t('fileManager.moveFolder'),
            icon: <FolderInput className="w-3.5 h-3.5" />,
            onClick: () => onMove(folder),
            disabled: !canMove,
            title: !canMove ? t('fileManager.noPermissionMoveFolder') : undefined,
          },
        ]
      : []),
    {
      label: isLinked ? t('fileManager.changeLink') : t('fileManager.linkTo'),
      icon: <Link2 className="w-3.5 h-3.5" />,
      onClick: () => onLink(folder),
      disabled: !canLink,
      title: !canLink ? t('fileManager.noPermissionLinkFolder') : undefined,
    },
    ...(onToggleShared && canLink
      ? [
          {
            label: folder.shared ? t('fileManager.unshareFolder') : t('fileManager.shareFolder'),
            icon: <Users className="w-3.5 h-3.5" />,
            onClick: () => onToggleShared(folder),
            title: t('fileManager.shareFolderHint'),
          },
        ]
      : []),
    {
      label: t('common.delete'),
      icon: <Trash2 className="w-3.5 h-3.5" />,
      onClick: () => onDelete(folder.id),
      danger: true,
      disabled: !canDeleteFolder,
      title: deleteDisabledTooltip,
    },
  ];

  return (
    <div
      ref={rootRef}
      className={`relative flex-shrink-0 flex items-center transition-opacity ${
        revealOnHover && !menuAnchor ? 'can-hover:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100' : ''
      }`}
      data-folder-actions
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // The menu has no arrow-key navigation; Up/Down mean "leave it".
        if (menuAnchor && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) closeMenu();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        tabIndex={tabIndex}
        onClick={(e) => {
          if (menuAnchor) {
            closeMenu();
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          setMenuAnchor({ x: rect.left, y: rect.bottom + 4 });
        }}
        className="p-1 rounded hover:bg-bambu-dark-tertiary"
        title={t('common.actions')}
      >
        <MoreVertical className="w-3.5 h-3.5 text-bambu-gray" />
      </button>
      {menuAnchor && (
        <ContextMenu x={menuAnchor.x} y={menuAnchor.y} items={items} onClose={closeMenu} anchorRef={buttonRef} />
      )}
    </div>
  );
}

export function FolderTreeItem({ folder, selectedFolderId, onSelect, onDelete, onLink, onRename, onMove, onToggleShared, folderDrag, depth = 0, wrapNames = false, defaultExpanded = true, showModified = false, hasPermission, t }: FolderTreeItemProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = folder.children.length > 0;
  const isLinked = folder.project_id || folder.archive_id;
  const isExternal = folder.is_external;
  const canDrag = folderDrag?.canDrag(folder) === true;
  const { isOver, handlers: dropHandlers } = useFolderDropTarget(folderDrag, folder.id);

  return (
    <div>
      <div
        className={`group flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer transition-colors ${
          selectedFolderId === folder.id
            ? 'bg-bambu-green/20 text-bambu-green'
            : 'hover:bg-bambu-dark text-white'
        } ${isOver ? FOLDER_DROP_TARGET_CLASS : ''}`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => onSelect(folder.id)}
        draggable={canDrag || undefined}
        onDragStart={canDrag ? (e) => folderDrag?.onDragStart(folder, e) : undefined}
        onDragEnd={canDrag ? folderDrag?.onDragEnd : undefined}
        {...dropHandlers}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="p-0.5 hover:bg-bambu-dark-tertiary rounded"
          >
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <div className="w-4.5" />
        )}
        {isExternal ? (
          <FolderSymlink className="w-4 h-4 text-purple-600 dark:text-purple-400 flex-shrink-0" />
        ) : (
          <FolderOpen className="w-4 h-4 text-bambu-green flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <span className={`block text-sm ${wrapNames ? 'break-all' : 'truncate'}`} title={folder.name}>{folder.name}</span>
          {/* #2680 follow-up: the same toolbar toggle that shows dates on file
              cards also shows them here. This is `latest_activity_at` — the
              newest timestamp among the folder itself, its files and its
              subfolders (the value "sort by recent activity" orders on) — not
              the folder's own on-disk mtime, hence the distinct label. */}
          {showModified && folder.latest_activity_at && (
            <span className="mt-0.5 flex items-center gap-1 text-xs text-bambu-gray" title={t('fileManager.lastActivity')}>
              <CalendarClock className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{formatDate(folder.latest_activity_at)}</span>
            </span>
          )}
        </div>
        {/* Link indicator - clickable to change link */}
        {isLinked && (
          <button
            onClick={(e) => { e.stopPropagation(); onLink(folder); }}
            className="flex-shrink-0 flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-500/30 transition-colors"
            title={`${folder.project_name ? `Project: ${folder.project_name}` : `Archive: ${folder.archive_name}`} (click to change)`}
          >
            <Link2 className="w-3 h-3" />
            {folder.project_name ? (
              <Briefcase className="w-3 h-3" />
            ) : (
              <ArchiveIcon className="w-3 h-3" />
            )}
          </button>
        )}
        {folder.shared && (
          <span title={t('fileManager.sharedFolder')}>
            <Users className="w-3 h-3 text-bambu-gray flex-shrink-0" />
          </span>
        )}
        {/* Read-only indicator for external folders */}
        {isExternal && folder.external_readonly && (
          <span title={t('fileManager.readOnly')}>
            <Lock className="w-3 h-3 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          </span>
        )}
        {folder.file_count > 0 && (
          <span className="flex-shrink-0 text-xs text-bambu-gray">{folder.file_count}</span>
        )}
        {/* Quick link button - always visible for unlinked folders */}
        {!isLinked && !isExternal && (
          <button
            onClick={(e) => { e.stopPropagation(); onLink(folder); }}
            className="flex-shrink-0 p-1 rounded hover:bg-bambu-dark-tertiary"
            title={t('fileManager.linkToProjectOrArchive')}
          >
            <Link2 className="w-3.5 h-3.5 text-bambu-gray hover:text-bambu-green" />
          </button>
        )}
        <FolderActionsMenu
          folder={folder}
          onDelete={onDelete}
          onLink={onLink}
          onRename={onRename}
          onMove={onMove}
          onToggleShared={onToggleShared}
          hasPermission={hasPermission}
          revealOnHover={!wrapNames}
          t={t}
        />
      </div>
      {hasChildren && expanded && (
        <div>
          {folder.children.map((child) => (
            <FolderTreeItem
              key={child.id}
              folder={child}
              selectedFolderId={selectedFolderId}
              onSelect={onSelect}
              onDelete={onDelete}
              onLink={onLink}
              onRename={onRename}
              onMove={onMove}
              onToggleShared={onToggleShared}
              folderDrag={folderDrag}
              depth={depth + 1}
              wrapNames={wrapNames}
              defaultExpanded={defaultExpanded}
              showModified={showModified}
              hasPermission={hasPermission}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}
