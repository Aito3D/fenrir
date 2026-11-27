import {
  Box,
  Image,
  FileText,
  FileSpreadsheet,
} from 'lucide-react';
import type { ContextMenuItem } from '../ContextMenu';
import type {
  LibraryFileListItem,
} from '../../api/client';
import { isSlicedLibraryFile } from '../../utils/libraryFiles';

export type TFunction = (key: string, options?: Record<string, unknown>) => string;

export function isSpreadsheetType(fileType: string): boolean {
  return fileType === 'csv' || fileType === 'xlsx' || fileType === 'ods';
}

export function isStepType(fileType: string): boolean {
  return fileType === 'step' || fileType === 'stp';
}

// Mirrors IMAGE_EXTENSIONS in routes/library.py — the types the server both
// stores and renders a thumbnail for, and so the ones that get an image icon.
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif']);

// The subset ImagePreviewModal can actually show: it hands the bytes to an
// <img>, and outside Safari no browser decodes TIFF. Offering the preview
// would download up to 50 MB only to report "cannot be previewed", so TIFF
// keeps its server-rendered thumbnail and no preview (#2976).
const PREVIEWABLE_IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

export function isImageType(fileType: string): boolean {
  return IMAGE_TYPES.has(fileType.toLowerCase());
}

export function isPreviewableImageType(fileType: string): boolean {
  return PREVIEWABLE_IMAGE_TYPES.has(fileType.toLowerCase());
}

// Which files have a preview at all: what a double-click opens, and what the
// toolbar's Preview button appears for (#2976). Sliced files go to the
// full-page gcode viewer, everything else to a modal.
export function isPreviewableLibraryFile(file: LibraryFileListItem): boolean {
  const type = file.file_type;
  return (
    isSlicedLibraryFile(file) ||
    type === '3mf' ||
    type === 'stl' ||
    isStepType(type) ||
    type === 'pdf' ||
    isSpreadsheetType(type) ||
    isPreviewableImageType(type)
  );
}

// Spread onto a card/row subtree that is not "the row": its own controls must
// neither toggle the selection nor open the preview. `dblclick` is a separate
// native event from `click`, so stopping the click alone still lets the second
// click of a double-click reach the row's onDoubleClick (#2976).
export const stopRowActivation = {
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
};

// Whether the preview is the 3D one, which has its own menu label.
export function isModelPreview(file: LibraryFileListItem): boolean {
  return isSlicedLibraryFile(file) || file.file_type === '3mf' || file.file_type === 'stl' || isStepType(file.file_type);
}

export function documentPreviewIcon(fileType: string) {
  if (fileType === 'pdf') return <FileText className="w-4 h-4" />;
  if (isSpreadsheetType(fileType)) return <FileSpreadsheet className="w-4 h-4" />;
  return <Image className="w-4 h-4" />;
}

// The "Preview" entry of a file's menu, or null for a file with no preview.
// Shared by the card and by a version line of a group (#3628).
export function previewMenuItem(
  file: LibraryFileListItem,
  onPreview: (file: LibraryFileListItem) => void,
  canRead: boolean,
  t: TFunction,
): ContextMenuItem | null {
  if (!isPreviewableLibraryFile(file)) return null;
  const modelPreview = isModelPreview(file);
  return {
    label: modelPreview ? t('fileManager.preview3d') : t('fileManager.preview.open'),
    icon: modelPreview ? <Box className="w-4 h-4" /> : documentPreviewIcon(file.file_type),
    onClick: () => onPreview(file),
    disabled: !canRead,
    title: !canRead ? t('fileManager.noPermissionPreview') : undefined,
  };
}

// Types the server renders a thumbnail for on request, STL through trimesh
// and PDF through PDFium (#2976), so the per-file "Generate thumbnail" action
// applies to them. Mirrors the file types batch_generate_stl_thumbnails in
// routes/library.py selects.
export function hasServerThumbnail(fileType: string): boolean {
  return fileType === 'stl' || fileType === 'pdf';
}

// Type badge colours shared by the list row and the columns view. Sliced
// output shares the gcode blue so users see at a glance that the file is
// already sliced and ready to print (#1543).
export function fileTypeBadgeClass(fileType: string): string {
  if (fileType === '3mf') return 'bg-bambu-green/20 text-bambu-green';
  if (fileType === 'gcode' || fileType === 'gcode.3mf') return 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400';
  if (fileType === 'stl') return 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400';
  if (isStepType(fileType)) return 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400';
  if (fileType === 'pdf') return 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400';
  if (isSpreadsheetType(fileType)) return 'bg-teal-100 dark:bg-teal-500/20 text-teal-700 dark:text-teal-400';
  return 'bg-bambu-gray/20 text-bambu-gray';
}
