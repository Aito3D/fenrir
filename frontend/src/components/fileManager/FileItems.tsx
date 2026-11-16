import { useState } from 'react';
import {
  Trash2,
  Download,
  ExternalLink,
  MoreVertical,
  Clock,
  CalendarClock,
  Layers,
  Cog,
  Play,
  Printer,
  Package,
  Pencil,
  Image,
  FileBox,
  FileText,
  FileSpreadsheet,
  User,
  Box,
  Tag as TagIcon,
  History,
  Calculator,
  Info,
  Globe,
  StickyNote,
  Camera,
  FolderInput, // Fenrir: Move to project (projects PDM phase 5)
} from 'lucide-react';
import { api } from '../../api/client';
import { type CalcConfig } from '../../utils/archivePricing';
import type {
  LibraryFileListItem,
  Permission,
} from '../../api/client';
import { ContextMenu, type ContextMenuItem } from '../ContextMenu';
import { formatDuration, formatDate } from '../../utils/date';
import { formatFileSize } from '../../utils/file';
import { type SlicerType } from '../../utils/slicer';
import { isSlicedLibraryFile, isSliceableLibraryFile } from '../../utils/libraryFiles';
import { isPrintableFilename } from '../projects/files/filesUi';
import { PrintFacts } from '../PrintFacts';
import { type TFunction, isPreviewableLibraryFile, isModelPreview, documentPreviewIcon, hasServerThumbnail, isStepType, isSpreadsheetType, stopRowActivation, fileTypeBadgeClass, isImageType } from './fileTypes';

// The icon a file without a thumbnail shows. Shared by the grid card, the list
// row and the columns view so the three never disagree about a type.
export function FileTypePlaceholderIcon({ fileType, className }: { fileType: string; className: string }) {
  const Icon =
    fileType === 'pdf'
      ? FileText
      : isSpreadsheetType(fileType)
        ? FileSpreadsheet
        : isImageType(fileType)
          ? Image
          : FileBox;
  return <Icon className={className} />;
}

// Fenrir: who may move a file into a project (projects PDM phase 5) — printing
// files only, the File Manager move right (ownership-aware) plus projects:update.
function canMoveFileToProject(
  file: LibraryFileListItem,
  hasPermission: (permission: Permission) => boolean,
  canModify: FileCardProps['canModify'],
): boolean {
  return (
    isPrintableFilename(file.filename) &&
    canModify('library', 'update', file.created_by_id) &&
    hasPermission('projects:update')
  );
}

// File Card
// The mark on a file a ?highlight= link points at; the Archives page's colour.
const HIGHLIGHT_CARD_STYLE = { outline: '4px solid #facc15', outlineOffset: '2px' } as const;
export const HIGHLIGHT_ROW_STYLE = { outline: '2px solid #facc15', outlineOffset: '-2px' } as const;

interface FileCardProps {
  file: LibraryFileListItem;
  isSelected: boolean;
  /** The file a ?highlight= link points at, marked for a few seconds. */
  isHighlighted?: boolean;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
  onDownload: (id: number) => void;
  onPrint?: (file: LibraryFileListItem) => void;
  onSlice?: (file: LibraryFileListItem) => void;
  onOpenInSlicer?: (file: LibraryFileListItem) => void;
  onRunPipeline?: (file: LibraryFileListItem) => void;
  useSlicerApi?: boolean;
  // Which slicer the desktop handoff targets. Decides whether an STL or STEP
  // gets a Slice action at all: Bambu Studio's protocol handler takes 3MF only
  // (#3029), so offering one there would only ever fail.
  desktopSlicer: SlicerType;
  canSlice?: boolean;
  onPreview?: (file: LibraryFileListItem) => void;
  onOpenInCalculator?: (file: LibraryFileListItem) => void;
  onRename?: (file: LibraryFileListItem) => void;
  onDetails?: (file: LibraryFileListItem) => void;
  onGenerateThumbnail?: (file: LibraryFileListItem) => void;
  onManageTags?: (file: LibraryFileListItem) => void;
  onTagClick?: (tagId: number) => void;
  onHistory?: (file: LibraryFileListItem) => void;
  onMoveToProject?: (file: LibraryFileListItem) => void; // Fenrir: projects PDM phase 5
  thumbnailVersion?: number;
  hasPermission: (permission: Permission) => boolean;
  canModify: (resource: 'queue' | 'archives' | 'library', action: 'update' | 'delete' | 'reprint', createdById: number | null | undefined) => boolean;
  authEnabled: boolean;
  showModified: boolean;
  t: TFunction;
  /** Fenrir: the calculator config and currency for the card's PrintFacts cost rows. */
  calcConfig?: CalcConfig | null;
  currencyCode?: string;
}

// Destructure order follows FileCardProps above, which the merge already
// unioned: upstream's onOpenInSlicer/canSlice/onPreview and the fork's
// onOpenInCalculator/onManageTags/onHistory all belong here. Taking either
// side's list alone leaves the other's buttons wired to undefined.
export function FileCard({ file, isSelected, isHighlighted, onSelect, onDelete, onDownload, onPrint, onSlice, onOpenInSlicer, onRunPipeline, useSlicerApi, desktopSlicer, canSlice, onPreview, onOpenInCalculator, onRename, onDetails, onGenerateThumbnail, onManageTags, onTagClick, onHistory, onMoveToProject, thumbnailVersion, hasPermission, canModify, authEnabled, showModified, t, calcConfig = null, currencyCode = 'USD' }: FileCardProps) {
  // Viewport coordinates rather than a flag, because the menu is rendered by
  // `ContextMenu` at `position: fixed` and anchored to the button (#2846). The
  // card it belongs to is only ~270px tall for a bare STL, which is shorter
  // than the seven-entry menu, so a menu positioned inside the card had its
  // top entry -- Slice -- cut off. The archive card menu works the same way.
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);

  const canPreview3d = hasPermission('library:read');
  const canRename = canModify('library', 'update', file.created_by_id);
  const canDelete = canModify('library', 'delete', file.created_by_id);
  // Same rule the archive card's menu uses: the calculator needs both a weight
  // and a duration to prefill, so a file the slicer left without either can't
  // open it. Shown greyed out rather than hidden, like every sibling entry.
  const canOpenInCalculator =
    hasPermission('calculator:read') && !!file.filament_used_grams && !!file.print_time_seconds;
  // Fenrir: printing files only, with the File Manager move right plus projects:update.
  const canMoveToProject = canMoveFileToProject(file, hasPermission, canModify);

  const menuItems: ContextMenuItem[] = [];
  if (onPrint && isSlicedLibraryFile(file)) {
    menuItems.push({
      label: t('common.print'),
      // The action stays visually distinct now that the menu component styles
      // its own labels; only the icon carries the accent.
      icon: <Printer className="w-4 h-4 text-bambu-green" />,
      onClick: () => onPrint(file),
      disabled: !hasPermission('queue:create'),
      title: !hasPermission('queue:create') ? t('fileManager.noPermissionAddToQueue') : undefined,
    });
  }
  if (isSliceableLibraryFile(file, !!useSlicerApi, desktopSlicer) && (useSlicerApi ? onSlice : onOpenInSlicer)) {
    menuItems.push({
      label: t('slice.action'),
      icon: useSlicerApi ? <Cog className="w-4 h-4" /> : <ExternalLink className="w-4 h-4" />,
      onClick: () => { if (useSlicerApi) onSlice?.(file); else onOpenInSlicer?.(file); },
      disabled: !canSlice,
      title: !canSlice ? (useSlicerApi ? t('fileManager.noPermissionSlice') : t('fileManager.noPermissionDownload')) : undefined,
    });
  }
  if (onRunPipeline && useSlicerApi && isSliceableLibraryFile(file, true, desktopSlicer)) {
    menuItems.push({
      label: t('library.runWithPipeline.actionLabel'),
      icon: <Play className="w-4 h-4" />,
      onClick: () => onRunPipeline(file),
      disabled: !hasPermission('pipelines:run'),
      title: !hasPermission('pipelines:run') ? t('library.runWithPipeline.noPermission') : undefined,
    });
  }
  if (onPreview && isPreviewableLibraryFile(file)) {
    const modelPreview = isModelPreview(file);
    menuItems.push({
      label: modelPreview ? t('fileManager.preview3d') : t('fileManager.preview.open'),
      icon: modelPreview ? <Box className="w-4 h-4" /> : documentPreviewIcon(file.file_type),
      onClick: () => onPreview(file),
      disabled: !canPreview3d,
      title: !canPreview3d ? t('fileManager.noPermissionPreview') : undefined,
    });
  }
  if (onOpenInCalculator) {
    menuItems.push({
      label: t('archives.menu.openInCalculator'),
      icon: <Calculator className="w-4 h-4" />,
      onClick: () => onOpenInCalculator(file),
      disabled: !canOpenInCalculator,
    });
  }
  if (onHistory) {
    menuItems.push({
      label: t('fileManager.fileHistory.menuLabel'),
      icon: <History className="w-4 h-4" />,
      onClick: () => onHistory(file),
      disabled: !canPreview3d,
      title: !canPreview3d ? t('fileManager.noPermissionPreview') : undefined,
    });
  }
  menuItems.push({
    label: t('common.download'),
    icon: <Download className="w-4 h-4" />,
    onClick: () => onDownload(file.id),
    disabled: !hasPermission('library:read'),
    title: !hasPermission('library:read') ? t('fileManager.noPermissionDownload') : undefined,
  });
  if (onRename) {
    menuItems.push({
      label: t('common.rename'),
      icon: <Pencil className="w-4 h-4" />,
      onClick: () => onRename(file),
      disabled: !canRename,
      title: !canRename ? t('fileManager.noPermissionRenameFile') : undefined,
    });
  }
  if (onMoveToProject && canMoveToProject) {
    // Fenrir: projects PDM phase 5
    menuItems.push({
      label: t('projectsPdm.filing.moveToProject'),
      icon: <FolderInput className="w-4 h-4" />,
      onClick: () => onMoveToProject(file),
    });
  }
  if (onManageTags) {
    menuItems.push({
      label: t('fileManager.tags.title'),
      icon: <TagIcon className="w-4 h-4" />,
      onClick: () => onManageTags(file),
      disabled: !canRename,
      title: !canRename ? t('fileManager.tags.noPermission') : undefined,
    });
  }
  if (onDetails) {
    menuItems.push({
      label: t('fileManager.details.title'),
      icon: <Info className="w-4 h-4" />,
      onClick: () => onDetails(file),
      disabled: !canPreview3d,
      title: !canPreview3d ? t('fileManager.noPermissionPreview') : undefined,
    });
  }
  if (file.external_url) {
    menuItems.push({
      label: t('fileManager.details.openLink'),
      icon: <Globe className="w-4 h-4" />,
      // The URL is stored by whoever owns the file, so the opened page must
      // not get a handle on this window (#3077).
      onClick: () => window.open(file.external_url!, '_blank', 'noopener,noreferrer'),
    });
  }
  if (onGenerateThumbnail && hasServerThumbnail(file.file_type)) {
    menuItems.push({
      label: t('fileManager.generateThumbnail'),
      icon: <Image className="w-4 h-4" />,
      onClick: () => onGenerateThumbnail(file),
      disabled: !canRename,
      title: !canRename ? t('fileManager.noPermissionGenerateThumbnail') : undefined,
    });
  }
  menuItems.push({
    label: t('common.delete'),
    icon: <Trash2 className="w-4 h-4" />,
    onClick: () => onDelete(file.id),
    danger: true,
    disabled: !canDelete,
    title: !canDelete ? t('fileManager.noPermissionDeleteFile') : undefined,
  });

  return (
    <div
      data-file-id={file.id}
      style={isHighlighted ? HIGHLIGHT_CARD_STYLE : undefined}
      className={`group relative bg-bambu-dark-secondary rounded-lg border transition-all cursor-pointer ${
        isSelected
          ? 'border-bambu-green ring-1 ring-bambu-green'
          : 'border-bambu-dark-tertiary hover:border-bambu-green/50'
      }`}
      onClick={() => onSelect(file.id)}
      // Double-click opens the preview (#2976). The two clicks that precede it
      // toggle the selection twice, so the selection is left as it was.
      onDoubleClick={() => onPreview?.(file)}
    >
      {/* Thumbnail */}
      <div className="aspect-square bg-bambu-dark flex items-center justify-center overflow-hidden rounded-t-lg">
        {file.thumbnail_path ? (
          <img
            src={`${api.getLibraryFileThumbnailUrl(file.id, file.thumbnail_path)}${thumbnailVersion ? ((api.getLibraryFileThumbnailUrl(file.id, file.thumbnail_path).includes('?') ? '&' : '?') + `v=${thumbnailVersion}`) : ''}`}
            loading="lazy"
            alt={file.filename}
            className="w-full h-full object-cover brightness-125 contrast-110"
          />
        ) : (
          <FileTypePlaceholderIcon fileType={file.file_type} className="w-12 h-12 text-bambu-gray/30" />
        )}
        {/* File type badge */}
        <div className={`absolute top-2 right-2 text-xs px-1.5 py-0.5 rounded font-medium ${
          file.file_type === '3mf' ? 'bg-bambu-green/90 text-white'
          // Sliced output — share the gcode blue so users see at a glance
          // that the file is already sliced and ready to print (#1543).
          : file.file_type === 'gcode' || file.file_type === 'gcode.3mf' ? 'bg-blue-500/90 text-white'
          : file.file_type === 'stl' ? 'bg-purple-500/90 text-white'
          : isStepType(file.file_type) ? 'bg-amber-500/90 text-white'
          : file.file_type === 'pdf' ? 'bg-red-500/90 text-white'
          : isSpreadsheetType(file.file_type) ? 'bg-teal-500/90 text-white'
          : 'bg-bambu-gray/90 text-white'
        }`}>
          {file.file_type.toUpperCase()}
        </div>
      </div>

      {/* Info */}
      <div className="p-3 stagger-nested">
        <h3 className="text-sm font-medium text-white truncate" title={file.print_name || file.filename}>
          {file.print_name || file.filename}
        </h3>
        <div className="flex items-center gap-3 mt-1 text-xs text-bambu-gray">
          <span>{formatFileSize(file.file_size)}</span>
          {file.print_time_seconds && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDuration(file.print_time_seconds)}
            </span>
          )}
          {file.filament_used_grams != null && file.filament_used_grams > 0 && (
            <span className="flex items-center gap-1">
              <Package className="w-3 h-3" />
              {file.filament_used_grams.toFixed(1)}g
            </span>
          )}
        </div>
        {(file.sliced_for_model || file.filament_type) && (
          <div className="mt-1 text-xs text-bambu-gray flex items-center gap-1 min-w-0">
            {file.sliced_for_model && (
              <>
                <Printer className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{file.sliced_for_model}</span>
              </>
            )}
            {file.sliced_for_model && file.filament_type && <span className="text-bambu-gray/50">·</span>}
            {file.filament_type && <span className="truncate" title={file.filament_type}>{file.filament_type}</span>}
          </div>
        )}
        {/* Fenrir: the archive card's rows for a sliced file (costs, layers, objects, colours). */}
        <PrintFacts facts={file} calcConfig={calcConfig} currencyCode={currencyCode} printerHints={[file.sliced_for_model]} omitMaterialType className="mt-1" />
        {/* Counts the whole group, including members in other folders (#671 /
            #2570) — printing this file will offer all of them. */}
        {(file.variant_count ?? 0) > 1 && (
          <div className="mt-1 text-xs text-bambu-green flex items-center gap-1">
            <Layers className="w-3 h-3" />
            {t('fileManager.variants.badge', { count: file.variant_count })}
          </div>
        )}
        {file.print_count > 0 && (
          <div className="mt-1 text-xs text-bambu-green">
            {/* Second entry point into the history timeline — the label is the
                collapsed version of exactly what the modal expands. */}
            {onHistory && hasPermission('library:read') ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onHistory(file); }}
                className="hover:underline"
                aria-label={t('fileManager.fileHistory.viewHistoryAria')}
                title={t('fileManager.fileHistory.viewHistoryAria')}
              >
                {t('fileManager.printedCount', { count: file.print_count })}
              </button>
            ) : (
              t('fileManager.printedCount', { count: file.print_count })
            )}
          </div>
        )}
        {/* Metadata indicators (#3077): link, notes, photos. The link opens in
            a new tab like the archive card's globe; the others open Details. */}
        {(file.external_url || file.has_notes || (file.photo_count ?? 0) > 0) && (
          <div className="mt-1 flex items-center gap-2 text-xs text-bambu-gray" {...stopRowActivation}>
            {file.external_url && (
              <a
                href={file.external_url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-0.5 rounded hover:text-bambu-green"
                title={t('fileManager.details.openLink')}
                aria-label={t('fileManager.details.openLink')}
              >
                <Globe className="w-3.5 h-3.5" />
              </a>
            )}
            {file.has_notes && (
              <button
                type="button"
                onClick={() => onDetails?.(file)}
                className="p-0.5 rounded hover:text-bambu-green"
                title={t('fileManager.details.hasNotes')}
                aria-label={t('fileManager.details.hasNotes')}
              >
                <StickyNote className="w-3.5 h-3.5" />
              </button>
            )}
            {(file.photo_count ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => onDetails?.(file)}
                className="flex items-center gap-0.5 p-0.5 rounded hover:text-bambu-green"
                title={t('fileManager.details.photoCount', { count: file.photo_count })}
                aria-label={t('fileManager.details.photoCount', { count: file.photo_count })}
              >
                <Camera className="w-3.5 h-3.5" />
                <span>{file.photo_count}</span>
              </button>
            )}
          </div>
        )}
        {authEnabled && file.created_by_username && (
          <div className="mt-1 text-xs text-bambu-gray flex items-center gap-1">
            <User className="w-3 h-3" />
            {file.created_by_username}
          </div>
        )}
        {/* #2680: last-modified date, toggled from the toolbar. Uses the real
            on-disk mtime when known, else the DB created_at. */}
        {showModified && (
          <div className="mt-1 text-xs text-bambu-gray flex items-center gap-1" title={t('fileManager.lastModified')}>
            <CalendarClock className="w-3 h-3" />
            {formatDate(file.fs_modified_at ?? file.created_at)}
          </div>
        )}
        {(file.tags?.length ?? 0) > 0 && (
          <div className="mt-2 flex flex-wrap gap-1" {...stopRowActivation}>
            {file.tags!.map((tg) => (
              <button
                key={tg.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTagClick?.(tg.id);
                }}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-bambu-green/10 text-bambu-green hover:bg-bambu-green/20 transition-colors max-w-full"
                title={tg.name}
              >
                <span className="truncate">{tg.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Actions - hover-revealed with a mouse, always there without one (#2865) */}
      {/* Fenrir: Move to project lives in the ⋯ menu only (projects PDM phase 5) */}
      <div className="absolute bottom-2 right-2 transition-opacity can-hover:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" {...stopRowActivation}>
        <button
          onClick={(e) => {
            // No open/close toggle: the menu's own outside-mousedown handler
            // has already dismissed it by the time this click lands.
            const rect = e.currentTarget.getBoundingClientRect();
            setMenuAnchor({ x: rect.left, y: rect.bottom + 4 });
          }}
          className="p-1.5 rounded bg-bambu-dark-secondary/90 hover:bg-bambu-dark-tertiary"
        >
          <MoreVertical className="w-4 h-4 text-bambu-gray" />
        </button>
        {menuAnchor && (
          <ContextMenu x={menuAnchor.x} y={menuAnchor.y} items={menuItems} onClose={() => setMenuAnchor(null)} />
        )}
      </div>

      {/* Selection checkbox - hover-revealed with a mouse, always there without one (#2865) */}
      <div className={`absolute top-2 left-2 w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
        isSelected
          ? 'bg-bambu-green border-bambu-green'
          : 'border-white/30 bg-black/30 can-hover:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
      }`}>
        {isSelected && <div className="w-2 h-2 bg-white rounded-sm" />}
      </div>
    </div>
  );
}

// Per-file icon strip: Print, Slice, Run with pipeline, Preview, Download,
// Details, Rename, Generate thumbnail, Delete. The list row and the columns view render
// the same strip so the two stay identical in order, icons and gating; the
// grid card packs the same actions into its kebab menu instead.
interface FileActionStripProps {
  file: LibraryFileListItem;
  onPrint: (file: LibraryFileListItem) => void;
  onSlice: (file: LibraryFileListItem) => void;
  onOpenInSlicer: (file: LibraryFileListItem) => void;
  onRunPipeline: (file: LibraryFileListItem) => void;
  useSlicerApi: boolean;
  desktopSlicer: SlicerType;
  canSlice: boolean;
  onPreview: (file: LibraryFileListItem) => void;
  onDetails: (file: LibraryFileListItem) => void;
  onDownload: (id: number) => void;
  onRename: (file: LibraryFileListItem) => void;
  onGenerateThumbnail: (file: LibraryFileListItem) => void;
  thumbnailPending: boolean;
  onDelete: (id: number) => void;
  onMoveToProject?: (file: LibraryFileListItem) => void; // Fenrir: projects PDM phase 5
  hasPermission: (permission: Permission) => boolean;
  canModify: (resource: 'queue' | 'archives' | 'library', action: 'update' | 'delete' | 'reprint', createdById: number | null | undefined) => boolean;
  // Roving tabindex for the columns view: only the focused row's buttons take
  // part in the Tab order, so Tab from the pane lands on that row's actions.
  tabIndex?: number;
  t: TFunction;
}

export function FileActionStrip({ file, onPrint, onSlice, onOpenInSlicer, onRunPipeline, useSlicerApi, desktopSlicer, canSlice, onPreview, onDetails, onDownload, onRename, onGenerateThumbnail, thumbnailPending, onDelete, onMoveToProject, hasPermission, canModify, tabIndex, t }: FileActionStripProps) {
  const canRename = canModify('library', 'update', file.created_by_id);
  const canDelete = canModify('library', 'delete', file.created_by_id);
  return (
    <div className="flex items-center gap-1" data-file-actions {...stopRowActivation}>
      {isSlicedLibraryFile(file) && (
        <button
          tabIndex={tabIndex}
          onClick={() => hasPermission('queue:create') && onPrint(file)}
          className={`p-1.5 rounded transition-colors ${
            hasPermission('queue:create')
              ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
              : 'text-bambu-gray/50 cursor-not-allowed'
          }`}
          title={hasPermission('queue:create') ? t('common.print') : t('fileManager.noPermissionAddToQueue')}
          disabled={!hasPermission('queue:create')}
        >
          <Printer className="w-4 h-4" />
        </button>
      )}
      {isSliceableLibraryFile(file, useSlicerApi, desktopSlicer) && (
        <button
          tabIndex={tabIndex}
          onClick={() => {
            if (!canSlice) return;
            (useSlicerApi ? onSlice : onOpenInSlicer)(file);
          }}
          className={`p-1.5 rounded transition-colors ${
            canSlice
              ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
              : 'text-bambu-gray/50 cursor-not-allowed'
          }`}
          title={canSlice ? t('slice.action') : (useSlicerApi ? t('fileManager.noPermissionSlice') : t('fileManager.noPermissionDownload'))}
          disabled={!canSlice}
        >
          {useSlicerApi ? <Cog className="w-4 h-4" /> : <ExternalLink className="w-4 h-4" />}
        </button>
      )}
      {useSlicerApi && isSliceableLibraryFile(file, true, desktopSlicer) && (
        <button
          tabIndex={tabIndex}
          onClick={() => hasPermission('pipelines:run') && onRunPipeline(file)}
          className={`p-1.5 rounded transition-colors ${
            hasPermission('pipelines:run')
              ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
              : 'text-bambu-gray/50 cursor-not-allowed'
          }`}
          title={hasPermission('pipelines:run') ? t('library.runWithPipeline.actionLabel') : t('library.runWithPipeline.noPermission')}
          disabled={!hasPermission('pipelines:run')}
        >
          <Play className="w-4 h-4" />
        </button>
      )}
      {isModelPreview(file) && (
        <button
          tabIndex={tabIndex}
          onClick={() => hasPermission('library:read') && onPreview(file)}
          className={`p-1.5 rounded transition-colors ${
            hasPermission('library:read')
              ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
              : 'text-bambu-gray/50 cursor-not-allowed'
          }`}
          title={hasPermission('library:read') ? t('fileManager.preview3d') : t('fileManager.noPermissionPreview')}
          disabled={!hasPermission('library:read')}
        >
          <Box className="w-4 h-4" />
        </button>
      )}
      {!isModelPreview(file) && isPreviewableLibraryFile(file) && (
        <button
          tabIndex={tabIndex}
          onClick={() => hasPermission('library:read') && onPreview(file)}
          className={`p-1.5 rounded transition-colors ${
            hasPermission('library:read')
              ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
              : 'text-bambu-gray/50 cursor-not-allowed'
          }`}
          title={hasPermission('library:read') ? t('fileManager.preview.open') : t('fileManager.noPermissionPreview')}
          disabled={!hasPermission('library:read')}
        >
          {documentPreviewIcon(file.file_type)}
        </button>
      )}
      <button
        tabIndex={tabIndex}
        onClick={() => hasPermission('library:read') && onDownload(file.id)}
        className={`p-1.5 rounded transition-colors ${
          hasPermission('library:read')
            ? 'hover:bg-bambu-dark text-bambu-gray hover:text-white'
            : 'text-bambu-gray/50 cursor-not-allowed'
        }`}
        title={hasPermission('library:read') ? t('common.download') : t('fileManager.noPermissionDownload')}
        disabled={!hasPermission('library:read')}
      >
        <Download className="w-4 h-4" />
      </button>
      <button
        tabIndex={tabIndex}
        onClick={() => hasPermission('library:read') && onDetails(file)}
        className={`p-1.5 rounded transition-colors ${
          hasPermission('library:read')
            ? 'hover:bg-bambu-dark text-bambu-gray hover:text-white'
            : 'text-bambu-gray/50 cursor-not-allowed'
        }`}
        title={hasPermission('library:read') ? t('fileManager.details.title') : t('fileManager.noPermissionPreview')}
        disabled={!hasPermission('library:read')}
      >
        <Info className="w-4 h-4" />
      </button>
      <button
        tabIndex={tabIndex}
        onClick={() => canRename && onRename(file)}
        className={`p-1.5 rounded transition-colors ${
          canRename
            ? 'hover:bg-bambu-dark text-bambu-gray hover:text-white'
            : 'text-bambu-gray/50 cursor-not-allowed'
        }`}
        title={canRename ? t('common.rename') : t('fileManager.noPermissionRenameFile')}
        disabled={!canRename}
      >
        <Pencil className="w-4 h-4" />
      </button>
      {/* Fenrir: Move to project (projects PDM phase 5) */}
      {onMoveToProject && canMoveFileToProject(file, hasPermission, canModify) && (
        <button
          type="button"
          tabIndex={tabIndex}
          onClick={() => onMoveToProject(file)}
          className="p-1.5 rounded transition-colors hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green"
          title={t('projectsPdm.filing.moveToProject')}
          aria-label={t('projectsPdm.filing.moveToProject')}
        >
          <FolderInput className="w-4 h-4" />
        </button>
      )}
      {hasServerThumbnail(file.file_type) && (
        <button
          tabIndex={tabIndex}
          onClick={() => canRename && onGenerateThumbnail(file)}
          className={`p-1.5 rounded transition-colors ${
            canRename
              ? 'hover:bg-bambu-dark text-bambu-gray hover:text-bambu-green'
              : 'text-bambu-gray/50 cursor-not-allowed'
          }`}
          title={canRename ? t('fileManager.generateThumbnail') : t('fileManager.noPermissionGenerateThumbnail')}
          disabled={thumbnailPending || !canRename}
        >
          <Image className="w-4 h-4" />
        </button>
      )}
      <button
        tabIndex={tabIndex}
        onClick={() => canDelete && onDelete(file.id)}
        className={`p-1.5 rounded transition-colors ${
          canDelete
            ? 'hover:bg-bambu-dark text-bambu-gray hover:text-red-700 dark:hover:text-red-400'
            : 'text-bambu-gray/50 cursor-not-allowed'
        }`}
        title={canDelete ? t('common.delete') : t('fileManager.noPermissionDeleteFile')}
        disabled={!canDelete}
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

// One row of a Miller column's file list. Extracted so every column renders
// its files with the same markup, action strip and double-click behaviour the
// selected folder's pane has always used.
interface ColumnFileRowProps {
  file: LibraryFileListItem;
  isSelected: boolean;
  isHighlighted?: boolean;
  isFocused: boolean;
  showModified: boolean;
  thumbnailVersion?: number;
  onSelect: (file: LibraryFileListItem) => void;
  onOpen: (file: LibraryFileListItem) => void;
  actionProps: Omit<FileActionStripProps, 'file' | 'tabIndex'>;
  t: TFunction;
}

export function ColumnFileRow({ file, isSelected, isHighlighted, isFocused, showModified, thumbnailVersion, onSelect, onOpen, actionProps, t }: ColumnFileRowProps) {
  const thumbnailUrl = api.getLibraryFileThumbnailUrl(file.id, file.thumbnail_path);
  return (
    <div
      data-file-id={file.id}
      style={isHighlighted ? HIGHLIGHT_ROW_STYLE : undefined}
      onClick={() => onSelect(file)}
      onDoubleClick={() => onOpen(file)}
      className={`group flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
        isSelected ? 'bg-bambu-green/10' : 'hover:bg-bambu-dark'
      } ${isFocused ? 'ring-1 ring-inset ring-bambu-green/60' : ''}`}
      title={file.print_name || file.filename}
    >
      <div className={`w-4 h-4 rounded border-2 flex-shrink-0 flex items-center justify-center ${
        isSelected ? 'bg-bambu-green border-bambu-green' : 'border-bambu-gray/50'
      }`}>
        {isSelected && <div className="w-1.5 h-1.5 bg-white rounded-sm" />}
      </div>
      <div className="w-10 h-10 rounded bg-bambu-dark flex-shrink-0 overflow-hidden flex items-center justify-center">
        {file.thumbnail_path ? (
          <img
            src={`${thumbnailUrl}${thumbnailVersion ? ((thumbnailUrl.includes('?') ? '&' : '?') + `v=${thumbnailVersion}`) : ''}`}
            loading="lazy"
            alt=""
            className="w-full h-full object-cover"
          />
        ) : (
          <FileTypePlaceholderIcon fileType={file.file_type} className="w-5 h-5 text-bambu-gray/50" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-white truncate">{file.print_name || file.filename}</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-bambu-gray">
          <span className={`px-1.5 py-px rounded font-medium ${fileTypeBadgeClass(file.file_type)}`}>
            {file.file_type.toUpperCase()}
          </span>
          <span>{formatFileSize(file.file_size)}</span>
          {file.print_count > 0 && <span>{file.print_count}x</span>}
          {showModified && (
            <span className="flex items-center gap-1 truncate" title={t('fileManager.lastModified')}>
              <CalendarClock className="w-3 h-3 flex-shrink-0" />
              {formatDate(file.fs_modified_at ?? file.created_at)}
            </span>
          )}
        </div>
      </div>
      {/* Same strip as the list row. Hover-revealed with a mouse, always there
          without one (#2865) and on the focused / selected row so the keyboard
          can reach it. */}
      <div
        className={`flex-shrink-0 transition-opacity ${
          isFocused || isSelected ? '' : 'can-hover:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
        }`}
      >
        <FileActionStrip file={file} {...actionProps} tabIndex={isFocused ? 0 : -1} />
      </div>
    </div>
  );
}
