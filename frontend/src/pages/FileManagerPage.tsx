import { useState, useRef, useCallback, useMemo, useEffect, lazy, Suspense } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueries, useMutation, useQueryClient, useInfiniteQuery, keepPreviousData, type UseQueryResult } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  FolderOpen,
  Loader2,
  Plus,
  Upload,
  Trash2,
  FolderPlus,
  FileBox,
  CalendarClock,
  HardDrive,
  File,
  MoveRight,
  CheckSquare,
  Square,
  Layers,
  LayoutGrid,
  List,
  Search,
  SortAsc,
  SortDesc,
  AlertTriangle,
  Filter,
  X,
  Link2,
  Printer,
  Package,
  Image,
  User,
  RefreshCw,
  Lock,
  FolderSymlink,
  Tag as TagIcon,
  Globe,
  Users,
  StickyNote,
  Camera,
  Eye,
  Combine,
  Columns,
  ChevronRight as ChevronRightIcon,
  FolderInput, // Fenrir: Move to project (projects PDM phase 5)
} from 'lucide-react';
import { api } from '../api/client';
import { calculatorPrefillUrl, type CalcConfig } from '../utils/archivePricing';
import type {
  LibraryFolderTree,
  LibraryFileListItem,
  LibraryFolderCreate,
  LibraryFolderUpdate,
  ExternalFolderCreate,
  LibraryFileUploadResponse, // Fenrir: projects PDM phase 5
} from '../api/client';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/ConfirmModal';
import { LibraryTagFilterRail } from '../components/LibraryTagFilterRail';
import { PrintModal, SliceModal } from '../components/LazyPrintSliceModals';
import type { SeparateJobsProgress } from '../components/PrintModal/separateJobs';
import { PartViewerModal } from '../components/viewer/LazyPartViewerModal';
import { CombineFilesModal } from '../components/CombineFilesModal';
import { RunWithPipelineModal } from '../components/RunWithPipelineModal';
import { BulkTagsPickerModal } from '../components/BulkTagsPickerModal';
import { FileUploadModal } from '../components/FileUploadModal';
import { FolderReadmePanel } from '../components/FolderReadmePanel';
import { LibraryTagsModal } from '../components/LibraryTagsModal';
import { FileHistoryModal } from '../components/FileHistoryModal';
import { LibraryFileDetailsModal } from '../components/LazyLibraryFileDetailsModal';
import { PurgeOldFilesModal } from '../components/PurgeOldFilesModal';
import { libraryTagsQueryKey } from '../utils/libraryTagsQuery';
import { useToast } from '../contexts/ToastContext';
import { usePageFileDrop } from '../hooks/usePageFileDrop';
import { useFlipReorder } from '../hooks/useFlipReorder';
import { useLibraryViewSettings } from '../hooks/useLibraryViewSettings';
import { useInfiniteScrollSentinel } from '../hooks/useInfiniteScrollSentinel';
import type { LibrarySortField as SortField, LibrarySortDirection as SortDirection } from '../hooks/useLibraryViewSettings';
import { useAuth } from '../contexts/AuthContext';
import { parseUTCDate, formatDate } from '../utils/date';
import { formatFileSize } from '../utils/file';
import { openInSlicer, resolveDesktopSlicer, type SlicerType } from '../utils/slicer';
import { isSlicedLibraryFile, isSliceableLibraryFile } from '../utils/libraryFiles';
// Fenrir: File Manager → project bridge (projects PDM phase 5)
import { MoveToProjectModal } from '../components/projects/filing/MoveToProjectModal';
import { catalogKeys } from '../components/projects/catalog/useProjectCatalog';
import { projectKeys } from '../components/projects/projectQueries';
import { useUiSettings } from '../hooks/useUiSettings';
import { FOLDER_DRAG_TYPE, isValidFolderMove } from '../utils/libraryFolders';
import { PendingUploadsPanel } from '../components/PendingUploadsPanel';
import { type FolderDragProps, FolderDropZone, FolderTreeItem, FolderActionsMenu } from '../components/fileManager/FolderTree';
import { isStepType, isSpreadsheetType, isPreviewableImageType, isPreviewableLibraryFile, stopRowActivation, fileTypeBadgeClass } from '../components/fileManager/fileTypes';
import { ColumnFileRow, FileCard, HIGHLIGHT_ROW_STYLE, FileActionStrip, FileTypePlaceholderIcon } from '../components/fileManager/FileItems';
import { NewFolderModal, ExternalFolderModal, MoveFilesModal, MoveFolderModal, LinkFolderModal, RenameModal } from '../components/fileManager/FolderModals';

// Rows per request. 100 keeps the first paint under a screenful of cards on
// a wide monitor while the look-ahead sentinel fetches the next page before
// the user reaches the last row.
const FILES_PAGE_SIZE = 100;
// How long the folder tree and the file list stay in memory after leaving the
// page. Coming back within it paints the last list at once and refreshes it
// in the background, instead of starting from a spinner (the default is 5 min).
const LIBRARY_KEEP_MS = 30 * 60 * 1000;
// Document previews (#2976) are code-split: pdf.js and the spreadsheet
// parsers only load when a preview is actually opened.
const PdfPreviewModal = lazy(() =>
  import('../components/PdfPreviewModal').then((m) => ({ default: m.PdfPreviewModal }))
);
const SpreadsheetPreviewModal = lazy(() =>
  import('../components/SpreadsheetPreviewModal').then((m) => ({ default: m.SpreadsheetPreviewModal }))
);
const ImagePreviewModal = lazy(() =>
  import('../components/ImagePreviewModal').then((m) => ({ default: m.ImagePreviewModal }))
);

/**
 * The columns view's per-level file queries, plus every file they hold — the
 * files a tick in an earlier column can point at (#3020). Module-level, so its
 * reference is stable and useQueries hands back the same value until a query
 * actually changes.
 */
function combineColumnFileQueries(results: UseQueryResult<LibraryFileListItem[]>[]) {
  return { results, files: results.flatMap((result) => result.data ?? []) };
}

// Search / type / user filtering plus the sort, shared by the main listing and
// by each Miller column's file list so a column never sorts differently from
// the pane beside it. `query` matches the filename and the embedded print name.
function filterAndSortFiles(
  files: LibraryFileListItem[],
  opts: {
    query?: string;
    filterType: string;
    filterUsername: string;
    sortField: SortField;
    sortDirection: SortDirection;
  },
): LibraryFileListItem[] {
  let result = [...files];

  const query = opts.query?.trim().toLowerCase();
  if (query) {
    result = result.filter(
      (f) =>
        f.filename.toLowerCase().includes(query) ||
        (f.print_name && f.print_name.toLowerCase().includes(query))
    );
  }

  if (opts.filterType !== 'all') {
    result = result.filter((f) => f.file_type === opts.filterType);
  }

  const userQuery = opts.filterUsername.trim().toLowerCase();
  if (userQuery) {
    result = result.filter(
      (f) => f.created_by_username && f.created_by_username.toLowerCase().includes(userQuery)
    );
  }

  result.sort((a, b) => {
    let comparison = 0;
    switch (opts.sortField) {
      case 'name':
        comparison = (a.print_name || a.filename).localeCompare(b.print_name || b.filename);
        break;
      case 'date':
        // #2680: sort by real on-disk mtime (matches `ls -t`), falling back to
        // the DB created_at for managed uploads that have no filesystem mtime.
        comparison =
          (parseUTCDate(a.fs_modified_at ?? a.created_at)?.getTime() ?? 0) -
          (parseUTCDate(b.fs_modified_at ?? b.created_at)?.getTime() ?? 0);
        break;
      case 'size':
        comparison = a.file_size - b.file_size;
        break;
      case 'type':
        comparison = a.file_type.localeCompare(b.file_type);
        break;
      case 'prints':
        comparison = a.print_count - b.print_count;
        break;
    }
    return opts.sortDirection === 'asc' ? comparison : -comparison;
  });

  return result;
}

// Keep the filename useful when fixed columns consume the available width,
// and give the header spacer and row checkbox one shared track so every later
// column stays aligned. min-w-min lets each auth variant size itself to its
// intrinsic grid width inside the overflow-x-auto wrapper (#3105). Tags get a
// floor too: with a 0 minimum they took the squeeze the filename used to take,
// hitting 0px right where the wrapper starts scrolling.
const fileListGridColumns = (authEnabled: boolean) => authEnabled
  ? 'grid-cols-[24px_minmax(240px,1fr)_120px_100px_100px_100px_minmax(96px,200px)_220px]'
  : 'grid-cols-[24px_minmax(240px,1fr)_100px_100px_100px_minmax(96px,200px)_220px]';
const fileListGridMinWidth = 'min-w-min';

export function FileManagerPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission, hasAnyPermission, canModify, authEnabled } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Read folder ID from URL query parameter
  const folderIdFromUrl = searchParams.get('folder');
  const initialFolderId = folderIdFromUrl ? parseInt(folderIdFromUrl, 10) : null;

  // State
  const { settings: viewSettings, update: updateViewSettings } = useLibraryViewSettings();
  // A ?folder= param wins on the first render, before the URL-sync effect
  // below has written it into the remembered settings; after that the
  // settings are the single source, so sidebar clicks still navigate.
  const [pendingUrlFolderId, setPendingUrlFolderId] = useState<number | null>(initialFolderId);
  const selectedFolderId = pendingUrlFolderId ?? viewSettings.selectedFolderId;
  const setSelectedFolderId = useCallback(
    (id: number | null) => updateViewSettings({ selectedFolderId: id }),
    [updateViewSettings],
  );
  // The folder restored from settings at mount (only when no ?folder= param
  // chose one). It is judged once, against the first loaded folder tree; a
  // folder selected after that (e.g. a just-linked external folder the stale
  // tree does not list yet) is never second-guessed. The listing waits for
  // that check so it never requests a folder that no longer exists.
  const [restoredFolderId] = useState<number | null>(() =>
    initialFolderId === null ? viewSettings.selectedFolderId : null,
  );
  const [restoredFolderChecked, setRestoredFolderChecked] = useState(restoredFolderId === null);
  // Whether the restored folder was judged against a fresh tree (the effect below).
  const restoredFolderVerified = useRef(restoredFolderId === null);
  // Which top-level pseudo-view the sidebar shows when no specific folder is
  // selected: "internal" = files in Fenrir's managed storage, "external" =
  // combined view across every linked external folder (#1621). Per-folder
  // selection bypasses this (selectedFolderId !== null disables the filter).
  const topLevelView = viewSettings.topLevelView;
  const setTopLevelView = useCallback(
    (view: 'internal' | 'external') => updateViewSettings({ topLevelView: view }),
    [updateViewSettings],
  );
  const [selectedFiles, setSelectedFiles] = useState<number[]>([]);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [showExternalFolderModal, setShowExternalFolderModal] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  // Fenrir: files headed for a project (projects PDM phase 5); null = closed.
  const [moveToProjectIds, setMoveToProjectIds] = useState<number[] | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [showPurgeModal, setShowPurgeModal] = useState(false);
  // Tag UI state (#1268). selectedTagIds is the AND-style filter applied to
  // the listing; setting it bypasses folder scoping on the server so
  // "every toy" works regardless of which folder is currently selected.
  const [showTagsModal, setShowTagsModal] = useState(false);
  const [showBulkTagsModal, setShowBulkTagsModal] = useState(false);
  const [singleTagFile, setSingleTagFile] = useState<LibraryFileListItem | null>(null);
  // Persisted per-browser like the Archives filters (archiveFilterTag et al.)
  // so a tag-scoped view survives a reload. Stale ids are pruned against the
  // catalog by the effect below once the catalog query settles.
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem('libraryFilterTagIds');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'number') : [];
    } catch {
      return [];
    }
  });
  const [linkFolder, setLinkFolder] = useState<LibraryFolderTree | null>(null);
  // Folder being moved via the context menu picker / by drag (#3305).
  const [moveFolder, setMoveFolder] = useState<LibraryFolderTree | null>(null);
  const [draggingFolder, setDraggingFolder] = useState<LibraryFolderTree | null>(null);
  // The one folder drop target under the pointer. A single page-level value
  // (not one flag per target) so a column can never stay lit after a row
  // inside it took the drag or the drop (#3305 review).
  const [folderDropTarget, setFolderDropTarget] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'file' | 'folder' | 'bulk'; id: number; count?: number } | null>(null);
  const [printFile, setPrintFile] = useState<LibraryFileListItem | null>(null);
  // A separate-jobs run (#3462) that was partly queued: what is in the queue,
  // so closing the dialog after a refusal doesn't queue it again on the next
  // Print (#3471 review). Kept while the selection is exactly the files left.
  const [separateJobsRun, setSeparateJobsRun] = useState<SeparateJobsProgress | null>(null);
  const [sliceFile, setSliceFile] = useState<LibraryFileListItem | null>(null);
  const [showCombineModal, setShowCombineModal] = useState(false);
  // A file just built by "Combine to 3MF", handed straight to the SliceModal.
  const [sliceCombined, setSliceCombined] = useState<{ id: number; filename: string } | null>(null);
  // Slicer Pipelines (#1425 PR B) — file gets "Run with pipeline" action.
  const [runPipelineFile, setRunPipelineFile] = useState<LibraryFileListItem | null>(null);
  const [renameItem, setRenameItem] = useState<{ type: 'file' | 'folder'; id: number; name: string } | null>(null);
  const [thumbnailVersions, setThumbnailVersions] = useState<Record<number, number>>({});
  const [viewerFile, setViewerFile] = useState<LibraryFileListItem | null>(null);
  const [historyFile, setHistoryFile] = useState<LibraryFileListItem | null>(null);
  const [pdfPreviewFile, setPdfPreviewFile] = useState<LibraryFileListItem | null>(null);
  const [sheetPreviewFile, setSheetPreviewFile] = useState<LibraryFileListItem | null>(null);
  const [detailsFile, setDetailsFile] = useState<LibraryFileListItem | null>(null);
  const [imagePreviewFile, setImagePreviewFile] = useState<LibraryFileListItem | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list' | 'columns'>(() => {
    return (localStorage.getItem('library-view-mode') as 'grid' | 'list' | 'columns') || 'grid';
  });
  // Miller-columns keyboard navigation (#3020): the pane itself is focusable
  // and arrow keys walk the hierarchy. The focused file is tracked separately
  // from the checkbox selection so Space can toggle a file without the arrow
  // keys hijacking multi-select.
  const columnsViewRef = useRef<HTMLDivElement>(null);
  const [columnsFocusedFileId, setColumnsFocusedFileId] = useState<number | null>(null);
  const [wrapFolderNames, setWrapFolderNames] = useState(() => {
    return localStorage.getItem('library-wrap-folders') === 'true';
  });
  const [collapseFoldersByDefault, setCollapseFoldersByDefault] = useState(() => {
    return localStorage.getItem('library-collapse-folders') === 'true';
  });
  // Folder tree sort (#1770). 'name' = alphabetical (the prior behaviour);
  // 'activity' = most recent file activity inside the folder first. Persisted
  // independently from the file-side sort so each can be tuned to taste.
  const [folderSortField, setFolderSortField] = useState<'name' | 'activity'>(() => {
    const saved = localStorage.getItem('library-folder-sort-field');
    return saved === 'activity' ? 'activity' : 'name';
  });
  const [folderSortDirection, setFolderSortDirection] = useState<'asc' | 'desc'>(() => {
    const saved = localStorage.getItem('library-folder-sort-direction');
    return saved === 'desc' ? 'desc' : 'asc';
  });

  // Resizable sidebar state
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('library-sidebar-width');
    return saved ? parseInt(saved, 10) : 256; // Default w-64 = 256px
  });
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Handle sidebar resize
  useEffect(() => {
    if (!isResizing) return;

    // Prevent text selection during resize
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const handleMouseMove = (e: MouseEvent) => {
      if (!sidebarRef.current) return;
      const containerRect = sidebarRef.current.parentElement?.getBoundingClientRect();
      if (!containerRect) return;
      // Calculate new width based on mouse position relative to container
      const newWidth = e.clientX - containerRect.left;
      // Clamp between 200px and 500px
      const clampedWidth = Math.min(500, Math.max(200, newWidth));
      setSidebarWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      // Save to localStorage
      localStorage.setItem('library-sidebar-width', String(sidebarWidth));
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, sidebarWidth]);

  // Filter and sort state — all remembered per browser by useLibraryViewSettings.
  const searchQuery = viewSettings.search;
  const filterType = viewSettings.filterType;
  const filterUsername = viewSettings.filterUsername;
  const sortField = viewSettings.sortField;
  const sortDirection = viewSettings.sortDirection;
  const setSearchQuery = useCallback((v: string) => updateViewSettings({ search: v }), [updateViewSettings]);
  const setFilterType = useCallback((v: string) => updateViewSettings({ filterType: v }), [updateViewSettings]);
  const setFilterUsername = useCallback((v: string) => updateViewSettings({ filterUsername: v }), [updateViewSettings]);
  // The server searches, so the query key waits for typing to settle.
  const [debouncedSearch, setDebouncedSearch] = useState(searchQuery);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchQuery), 250);
    return () => clearTimeout(id);
  }, [searchQuery]);
  // Includes the debounced search: `files` lags the input by the debounce
  // (and keepPreviousData), so the gates must stay "filtered" until the
  // unfiltered rows have actually landed.
  const hasActiveFilters = Boolean(searchQuery || debouncedSearch || filterType !== 'all' || filterUsername);
  // Show/hide the last-modified date on each file card (#2680). Persisted.
  const [showModified, setShowModified] = useState<boolean>(
    () => localStorage.getItem('library-show-modified') === 'true'
  );

  // Update selectedFolderId when URL parameter changes (e.g., navigating from Project or Archive page)
  useEffect(() => {
    const folderParam = searchParams.get('folder');
    if (folderParam) {
      const newFolderId = parseInt(folderParam, 10);
      setSelectedFolderId(newFolderId);
    }
    setPendingUrlFolderId(null);
  }, [searchParams, setSelectedFolderId]);

  // ?highlight=<file id> points at one file (the queue card's "View in File
  // Manager"). The link carries only the id: the folder is looked up here, so
  // a file moved since it was queued is still found. The folder's listing is
  // refetched before the file is looked for in it, since a cached one may
  // predate the move.
  const highlightParam = searchParams.get('highlight');
  const [pendingHighlight, setPendingHighlight] = useState<{ fileId: number; folderId: number | null; requestedAt: number } | null>(null);
  const [highlightedFileId, setHighlightedFileId] = useState<number | null>(null);
  const selectedFolderIdRef = useRef(selectedFolderId);
  selectedFolderIdRef.current = selectedFolderId;
  useEffect(() => {
    const fileId = highlightParam ? parseInt(highlightParam, 10) : NaN;
    if (!Number.isFinite(fileId)) return;
    let cancelled = false;
    const folderAtRequest = selectedFolderIdRef.current;
    api.getLibraryFile(fileId).then(
      (file) => {
        // Someone who opened another folder meanwhile is not pulled back.
        if (cancelled || selectedFolderIdRef.current !== folderAtRequest) return;
        const requestedAt = Date.now();
        queryClient.invalidateQueries({ queryKey: ['library-files'] });
        setSelectedFolderId(file.folder_id);
        setPendingHighlight({ fileId, folderId: file.folder_id, requestedAt });
      },
      () => {
        if (!cancelled) showToast(t('fileManager.highlightedFileNotFound'), 'warning');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [highlightParam, queryClient, showToast, t]);

  // Queries
  const { data: settings } = useUiSettings();

  const preferredSlicer: SlicerType = resolveDesktopSlicer(settings?.open_in_slicer, settings?.preferred_slicer);

  const handleOpenInSlicer = useCallback(async (file: LibraryFileListItem) => {
    try {
      const { token } = await api.createLibrarySlicerToken(file.id);
      const path = api.getLibrarySlicerDownloadUrl(file.id, token, file.filename);
      openInSlicer(`${window.location.origin}${path}`, preferredSlicer);
    } catch {
      // Fallback to direct URL (works when auth is disabled). With auth on the
      // slicer may then hit a 401, so surface the failure instead of making a
      // permission denial look identical to "no slicer installed".
      showToast(t('fileManager.toast.openInSlicerFailed'), 'error');
      const path = api.getLibraryFileDownloadUrl(file.id);
      openInSlicer(`${window.location.origin}${path}`, preferredSlicer);
    }
  }, [preferredSlicer, showToast, t]);

  // Slice permission: API mode needs upload rights, the desktop handoff is a
  // download. Each mirrors what the backend enforces on the endpoint that
  // branch actually calls, so the UI never offers an action the server refuses.
  //
  // Deliberately NOT accepting the legacy `library:read` on the handoff branch.
  // It looks like the safe back-compat term to include, but the slicer-token
  // endpoint gates on require_ownership_permission(LIBRARY_READ_ALL,
  // LIBRARY_READ_OWN), and neither that dependency nor User.has_permission
  // expands the legacy name — so a group holding only `library:read` gets a 403
  // there. It cannot reach this page to find out either: GET /library/folders
  // gates on the same pair. Accepting it here would only enable a menu item
  // that fails, and the `library:read` -> `library:read_own` migration in
  // core/database.py runs only over the groups named in DEFAULT_GROUPS, so a
  // custom role that still carries it is genuinely stuck rather than silently
  // upgraded.
  const canSlice = useCallback(() => {
    if (settings?.use_slicer_api) {
      return hasPermission('library:upload');
    }
    return hasAnyPermission('library:read_all', 'library:read_own');
  }, [settings?.use_slicer_api, hasPermission, hasAnyPermission]);
  const {
    data: folders,
    isLoading: foldersLoading,
    isFetching: foldersFetching,
    isError: foldersError,
  } = useQuery({
    queryKey: ['library-folders'],
    queryFn: () => api.getLibraryFolders(),
    gcTime: LIBRARY_KEEP_MS,
  });

  // Recursive folder tree sort (#1770). Applies the same comparator to the
  // top-level list AND to each level of `children`, so sort order is uniform
  // at every depth of nesting. When sorting by activity, the comparator falls
  // back to a created-at fallback for folders with no files (`latest_activity_at`
  // is null) so they stay grouped at the end / start of the bucket instead of
  // randomly interspersed.
  const sortedFolders = useMemo(() => {
    if (!folders) return folders;
    const sortLevel = (items: LibraryFolderTree[]): LibraryFolderTree[] => {
      const sorted = [...items].sort((a, b) => {
        let comparison = 0;
        if (folderSortField === 'name') {
          comparison = a.name.localeCompare(b.name);
        } else {
          // activity: newest first on 'desc', oldest first on 'asc'.
          // Folders with no activity timestamp sort to the end regardless
          // of direction so an empty folder doesn't elbow a recently-used one.
          const aTs = a.latest_activity_at ? new Date(a.latest_activity_at).getTime() : null;
          const bTs = b.latest_activity_at ? new Date(b.latest_activity_at).getTime() : null;
          if (aTs === null && bTs === null) {
            comparison = a.name.localeCompare(b.name);
          } else if (aTs === null) {
            return 1;
          } else if (bTs === null) {
            return -1;
          } else {
            comparison = aTs - bTs;
          }
        }
        return folderSortDirection === 'asc' ? comparison : -comparison;
      });
      return sorted.map((f) => ({ ...f, children: sortLevel(f.children) }));
    };
    return sortLevel(folders);
  }, [folders, folderSortField, folderSortDirection]);

  // A remembered folder can have been deleted or unlinked since the last
  // visit; fall back to "All files" rather than showing an empty pane. Runs
  // once, on the first settled folder tree (a failed tree keeps the folder).
  useEffect(() => {
    if (restoredFolderVerified.current) return;
    if (foldersError) {
      restoredFolderVerified.current = true;
      setRestoredFolderChecked(true);
      return;
    }
    if (!folders) return;
    const exists = (items: LibraryFolderTree[]): boolean =>
      items.some((f) => f.id === restoredFolderId || exists(f.children));
    const found = exists(folders);
    // A tree kept from the last visit that knows the folder is enough to
    // start listing it; the fresh tree below still gets the final say.
    if (found) setRestoredFolderChecked(true);
    if (foldersFetching) return;
    restoredFolderVerified.current = true;
    if (selectedFolderId === restoredFolderId && !found) setSelectedFolderId(null);
    setRestoredFolderChecked(true);
  }, [
    foldersError,
    folders,
    foldersFetching,
    restoredFolderId,
    selectedFolderId,
    setSelectedFolderId,
  ]);

  // Trash count for the header badge (#1008). Empty/error are silently treated
  // as zero so a broken trash endpoint doesn't break the File Manager.
  const { data: trashCount } = useQuery({
    queryKey: ['library-trash-count'],
    queryFn: async () => {
      try {
        const res = await api.listLibraryTrash(1, 0);
        return res.total;
      } catch {
        return 0;
      }
    },
    staleTime: 30_000,
  });

  // #1268: when a folder is selected and the user has typed a search query,
  // ask the server to expand the result to every descendant folder so the
  // client-side filter can match files in subfolders too. Without this the
  // listing is just the immediate children and "robot.3mf" two levels deep
  // is invisible from the parent. Only kicks in for folder-scoped views —
  // root and the internal/external pseudo-nodes already return the union.
  const searchExpandsSubfolders = selectedFolderId !== null && debouncedSearch.trim().length > 0;
  // The tag filter overrides folder scoping server-side (#1268 design call),
  // so the FE query key includes it as a peer of folder/topLevelView. Sorted
  // so the cache hits regardless of the order tags were toggled.
  const tagFilterKey = useMemo(() => [...selectedTagIds].sort((a, b) => a - b), [selectedTagIds]);
  // Tag catalog — needed to resolve names for the active-filter chip bar.
  // Cheap query, shared with LibraryTagsModal / BulkTagsPickerModal via the
  // same queryKey so they all invalidate together on tag CRUD.
  const { data: tagCatalog = [] } = useQuery({
    queryKey: libraryTagsQueryKey,
    queryFn: api.getLibraryTags,
  });
  const tagsById = useMemo(() => {
    const map = new Map<number, string>();
    for (const t of tagCatalog) map.set(t.id, t.name);
    return map;
  }, [tagCatalog]);
  // Prune the active filter when a tag is removed from the catalog so the
  // listing never stalls on a phantom id. Skipped while the catalog query is
  // still settling (empty array on first paint) — otherwise the user's filter
  // gets cleared the moment the page mounts.
  useEffect(() => {
    if (tagCatalog.length === 0) return;
    setSelectedTagIds((prev) => {
      const next = prev.filter((id) => tagsById.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [tagCatalog.length, tagsById]);

  const toggleTagFilter = useCallback((tagId: number) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  }, []);

  const clearTagFilter = useCallback(() => setSelectedTagIds([]), []);

  useEffect(() => {
    try {
      localStorage.setItem('libraryFilterTagIds', JSON.stringify(selectedTagIds));
    } catch {
      /* ignore quota/private-mode failures */
    }
  }, [selectedTagIds]);

  // While a search or tag filter is active the file list spans every matching
  // descendant folder, so per-level folder columns would lie about scope —
  // hide them and let the files pane take the full width.
  const columnsFilterActive = searchQuery.trim().length > 0 || selectedTagIds.length > 0;

  // In the columns view the pane beside the root column is that level's own
  // list, the files in no folder, like every other column's. Grid and list keep
  // "All Files", and so does a search or tag filter, whose results span every
  // folder.
  const paneRootOnly = viewMode === 'columns' && selectedFolderId === null && !columnsFilterActive;

  const scope = useMemo(
    () => ({
      folderId: selectedFolderId,
      // include_root is false outside the columns view's root level, so
      // "All Files" still descends into subfolders (regression guard #1499).
      includeRoot: paneRootOnly,
      scope: selectedFolderId === null ? topLevelView : undefined,
      recursive: searchExpandsSubfolders,
      tagIds: tagFilterKey,
    }),
    [selectedFolderId, topLevelView, searchExpandsSubfolders, tagFilterKey, paneRootOnly],
  );

  // Paged listing (server-side search/filter/sort). The key keeps the
  // 'library-files' prefix so every existing invalidation still hits it.
  // keepPreviousData holds the old rows on screen while a changed filter or
  // sort fetches its first page, so the grid never blanks between states.
  const {
    data: filePages,
    isLoading: filesLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isPlaceholderData: filesArePlaceholder,
    dataUpdatedAt: filesUpdatedAt,
  } = useInfiniteQuery({
    queryKey: [
      'library-files',
      'paged',
      scope,
      debouncedSearch.trim(),
      filterType,
      filterUsername.trim(),
      sortField,
      sortDirection,
    ],
    queryFn: ({ pageParam }) =>
      api.getLibraryFilesPage({
        ...scope,
        search: debouncedSearch,
        fileType: filterType,
        createdBy: filterUsername,
        sort: sortField,
        direction: sortDirection,
        limit: FILES_PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return lastPage.items.length > 0 && loaded < lastPage.total ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
    enabled: restoredFolderChecked,
    gcTime: LIBRARY_KEEP_MS,
  });
  // Offset paging over a live table can hand back a row twice (a file added
  // or re-sorted between page fetches shifts the window), so keep the first
  // copy of each id — duplicate React keys would otherwise misrender cards.
  const files = useMemo(() => {
    const seen = new Set<number>();
    return (filePages?.pages.flatMap((p) => p.items) ?? []).filter((file) => {
      if (seen.has(file.id)) return false;
      seen.add(file.id);
      return true;
    });
  }, [filePages]);
  const totalFiles = filePages?.pages[filePages.pages.length - 1]?.total ?? files.length;

  // Type dropdown options come from the facet endpoint; until it answers (or
  // if it fails) the types seen in the loaded rows stand in. The key sits
  // under 'library-files' so uploads/deletes that invalidate the listing
  // refresh the facet too.
  const { data: facetTypes } = useQuery({
    queryKey: ['library-files', 'file-types', scope],
    queryFn: () => api.getLibraryFileTypes(scope),
    retry: false,
  });

  // Held off while placeholder rows from the previous filter are on screen:
  // their hasNextPage belongs to the old query, not the one being fetched.
  const sentinelRef = useInfiniteScrollSentinel({
    enabled: Boolean(hasNextPage) && !isFetchingNextPage && !isFetchNextPageError && !filesArePlaceholder,
    onReach: () => void fetchNextPage(),
  });

  const { data: stats } = useQuery({
    queryKey: ['library-stats'],
    queryFn: () => api.getLibraryStats(),
  });

  // Get users for the username filter autocomplete -- names only (#1894)
  const { data: users } = useQuery({
    queryKey: ['users', 'slim'],
    queryFn: () => api.getUsersSlim(),
  });

  // Calculator configuration for the card menu's "Open in calculator" entry.
  // Shares query keys (and cache) with CalculatorPage and ArchivesPage; stays
  // null when the user lacks calculator access or nothing is configured yet, in
  // which case the prefill URL simply carries weight/time and no ID matches.
  const canUseCalculator = hasPermission('calculator:read');
  const { data: calcFilaments } = useQuery({
    queryKey: ['calculatorFilaments'],
    queryFn: api.getCalculatorFilaments,
    enabled: canUseCalculator,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const { data: calcPrinters } = useQuery({
    queryKey: ['calculatorPrinters'],
    queryFn: api.getCalculatorPrinters,
    enabled: canUseCalculator,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const { data: calcDefaults } = useQuery({
    queryKey: ['calculatorDefaults'],
    queryFn: api.getCalculatorDefaults,
    enabled: canUseCalculator,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const calcConfig = useMemo<CalcConfig | null>(
    () =>
      calcFilaments?.length && calcPrinters?.length && calcDefaults
        ? { filaments: calcFilaments, printers: calcPrinters, defaults: calcDefaults }
        : null,
    [calcFilaments, calcPrinters, calcDefaults],
  );
  // Every card's cost and price is computed from the calculator's current settings, so a
  // refresh re-reads those settings and the files' facts; nothing is stored per file.
  const refreshPrices = useMutation({
    mutationFn: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['calculatorFilaments'] }),
        queryClient.invalidateQueries({ queryKey: ['calculatorPrinters'] }),
        queryClient.invalidateQueries({ queryKey: ['calculatorDefaults'] }),
        queryClient.invalidateQueries({ queryKey: ['library-files'] }),
      ]);
    },
    onSuccess: () => showToast(t('fileManager.refreshPricesDone'), 'success'),
    onError: () => showToast(t('common.error'), 'error'),
  });

  // Get unique file types for filter dropdown
  const fileTypes = useMemo(() => {
    const types = new Set<string>(facetTypes ?? files.map((f) => f.file_type));
    if (filterType !== 'all') types.add(filterType);
    return Array.from(types).sort();
  }, [facetTypes, files, filterType]);

  // Search, filters and sort are applied by the server now; `files` is the
  // rows loaded so far in the order the server returned them.
  const filteredAndSortedFiles = files;

  // FLIP reorder for the file card grid: on search/filter/sort, persisting
  // cards slide to their new slots; newly-entering cards play `animate-rise`.
  const fileGridRef = useRef<HTMLDivElement>(null);
  const fileOrderKey = filteredAndSortedFiles.map((f) => f.id).join(',');
  useFlipReorder(fileGridRef, fileOrderKey);

  // Once the file's folder is listed afresh, mark the file; then scroll to it
  // and drop the mark after a few seconds, as the Archives page does.
  useEffect(() => {
    if (!pendingHighlight || filesLoading || !files || selectedFolderId !== pendingHighlight.folderId) return;
    if (filesUpdatedAt < pendingHighlight.requestedAt) return;
    if (filteredAndSortedFiles.some((f) => f.id === pendingHighlight.fileId)) {
      setHighlightedFileId(pendingHighlight.fileId);
      if (viewMode === 'columns') setColumnsFocusedFileId(pendingHighlight.fileId);
    } else {
      showToast(t('fileManager.highlightedFileNotFound'), 'warning');
    }
    setPendingHighlight(null);
  }, [pendingHighlight, filesLoading, files, filesUpdatedAt, selectedFolderId, filteredAndSortedFiles, viewMode, showToast, t]);
  useEffect(() => {
    if (highlightedFileId === null) return;
    const scrollTimer = setTimeout(() => {
      document.querySelector(`[data-file-id="${highlightedFileId}"]`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, 100);
    const clearTimer = setTimeout(() => setHighlightedFileId(null), 5000);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(clearTimer);
    };
  }, [highlightedFileId]);

  // Check if disk space is low
  const isDiskSpaceLow = useMemo(() => {
    if (!stats || !settings) return false;
    const thresholdBytes = (settings.library_disk_warning_gb || 5) * 1024 * 1024 * 1024;
    return stats.disk_free_bytes < thresholdBytes;
  }, [stats, settings]);

  // Mutations
  const createFolderMutation = useMutation({
    mutationFn: (data: LibraryFolderCreate) => api.createLibraryFolder(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      setShowNewFolderModal(false);
      showToast(t('fileManager.toast.folderCreated'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const createExternalFolderMutation = useMutation({
    mutationFn: async (data: ExternalFolderCreate) => {
      const folder = await api.createExternalFolder(data);
      // Auto-scan after creation
      await api.scanExternalFolder(folder.id);
      return folder;
    },
    onSuccess: (folder) => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      setShowExternalFolderModal(false);
      setSelectedFolderId(folder.id);
      showToast(t('fileManager.toast.externalFolderLinked'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const scanExternalFolderMutation = useMutation({
    mutationFn: (folderId: number) => api.scanExternalFolder(folderId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      showToast(t('fileManager.toast.folderScanned', { added: result.added, removed: result.removed }), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const deleteFolderMutation = useMutation({
    mutationFn: (id: number) => api.deleteLibraryFolder(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      // A deleted folder may have been an archive's linked folder (card badge).
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      if (selectedFolderId === deleteConfirm?.id) {
        setSelectedFolderId(null);
      }
      setDeleteConfirm(null);
      showToast(t('fileManager.toast.folderDeleted'), 'success');
    },
    onError: (error: Error) => {
      setDeleteConfirm(null);
      showToast(error.message, 'error');
    },
  });

  const deleteFileMutation = useMutation({
    mutationFn: (id: number) => api.deleteLibraryFile(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash-count'] });
      setSelectedFiles((prev) => prev.filter((id) => id !== deleteConfirm?.id));
      setDeleteConfirm(null);
      showToast(t('fileManager.toast.fileDeleted'), 'success');
    },
    onError: (error: Error) => {
      setDeleteConfirm(null);
      showToast(error.message, 'error');
    },
  });

  // "These files are the same job for different printers" (#671 / #2570).
  // Durable, unlike the ad-hoc selection the Print button uses: once grouped,
  // printing any member offers the others without re-selecting them.
  const groupAsVersionsMutation = useMutation({
    mutationFn: (fileIds: number[]) =>
      api.createVariantGroup(fileIds.map((id) => ({ library_file_id: id }))),
    onSuccess: (group) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      showToast(t('fileManager.variants.grouped', { count: group.members.length }), 'success');
      setSelectedFiles([]);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (fileIds: number[]) => api.bulkDeleteLibrary(fileIds, []),
    onSuccess: (_, fileIds) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-stats'] });
      queryClient.invalidateQueries({ queryKey: ['library-trash-count'] });
      showToast(t('fileManager.toast.filesDeleted', { count: fileIds.length }), 'success');
      setSelectedFiles([]);
      setDeleteConfirm(null);
    },
    onError: (error: Error) => {
      setDeleteConfirm(null);
      showToast(error.message, 'error');
    },
  });

  const moveFilesMutation = useMutation({
    mutationFn: ({ fileIds, folderId }: { fileIds: number[]; folderId: number | null }) =>
      api.moveLibraryFiles(fileIds, folderId),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      setSelectedFiles([]);
      setShowMoveModal(false);
      if (response.skipped > 0) {
        const counts = new Map<string, number>();
        for (const { code } of response.skipped_reasons) {
          counts.set(code, (counts.get(code) ?? 0) + 1);
        }
        const reasons = [...counts.entries()]
          .map(([code, count]) => `${count} ${t(`fileManager.toast.moveSkipReason.${code}`)}`)
          .join(', ');
        showToast(
          t('fileManager.toast.moveSkipped', { moved: response.moved, skipped: response.skipped, reasons }),
          'warning'
        );
      } else {
        showToast(t('fileManager.toast.filesMoved'), 'success');
      }
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const updateFolderMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: LibraryFolderUpdate }) =>
      api.updateLibraryFolder(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      // Invalidate project/archive folder queries so other pages see the update
      queryClient.invalidateQueries({ queryKey: catalogKeys.folders() });
      queryClient.invalidateQueries({ queryKey: projectKeys.allLinkedFolders() });
      queryClient.invalidateQueries({ queryKey: ['archive-folders'] });
      // Archive rows carry their linked folder (the card's folder badge).
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      setLinkFolder(null);
      const isUnlink = variables.data.project_id === 0 && variables.data.archive_id === 0;
      showToast(isUnlink ? t('fileManager.toast.folderUnlinked') : t('fileManager.toast.folderLinked'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  // Move a folder to root (parent_id 0) or under another folder (#3305). The
  // server repeats the cycle check and 400s a move into the folder's own
  // subtree, which the toast then shows verbatim.
  const moveFolderMutation = useMutation({
    mutationFn: ({ id, parentId }: { id: number; parentId: number | null }) =>
      api.updateLibraryFolder(id, { parent_id: parentId ?? 0 }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: catalogKeys.folders() });
      queryClient.invalidateQueries({ queryKey: projectKeys.allLinkedFolders() });
      queryClient.invalidateQueries({ queryKey: ['archive-folders'] });
      setMoveFolder(null);
      showToast(t('fileManager.toast.folderMoved'), 'success');
    },
    onError: (error: Error) => {
      setMoveFolder(null);
      showToast(error.message, 'error');
    },
  });

  // Drag a folder onto another folder row, a column, or "All Files" (= root).
  // Drops that would change nothing or that the server would refuse are not
  // accepted, so no request leaves for them.
  const folderDrag: FolderDragProps = {
    canDrag: (folder) => !folder.is_external && (folder.can_rename ?? hasPermission('library:update_all')),
    onDragStart: (folder, e) => {
      e.dataTransfer.setData(FOLDER_DRAG_TYPE, String(folder.id));
      e.dataTransfer.effectAllowed = 'move';
      setDraggingFolder(folder);
    },
    onDragEnd: () => {
      setDraggingFolder(null);
      setFolderDropTarget(null);
    },
    canDropOn: (destinationId) =>
      draggingFolder !== null && !!folders && isValidFolderMove(folders, draggingFolder, destinationId),
    onDrop: (destinationId) => {
      if (!draggingFolder || !folders || !isValidFolderMove(folders, draggingFolder, destinationId)) return;
      moveFolderMutation.mutate({ id: draggingFolder.id, parentId: destinationId });
      setDraggingFolder(null);
    },
    activeTarget: folderDropTarget,
    setActiveTarget: setFolderDropTarget,
  };

  const renameFileMutation = useMutation({
    mutationFn: ({ id, filename }: { id: number; filename: string }) =>
      api.updateLibraryFile(id, { filename }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      setRenameItem(null);
      showToast(t('fileManager.toast.fileRenamed'), 'success');
    },
    onError: (error: Error) => {
      setRenameItem(null);
      showToast(error.message, 'error');
    },
  });

  const renameFolderMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.updateLibraryFolder(id, { name }),
    onSuccess: () => {
      // Invalidate both folders and files - files may display folder info
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      setRenameItem(null);
      showToast(t('fileManager.toast.folderRenamed'), 'success');
    },
    onError: (error: Error) => {
      setRenameItem(null);
      showToast(error.message, 'error');
    },
  });

  const shareFolderMutation = useMutation({
    mutationFn: ({ id, shared }: { id: number; shared: boolean }) => api.updateLibraryFolder(id, { shared }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      queryClient.invalidateQueries({ queryKey: catalogKeys.folders() });
      queryClient.invalidateQueries({ queryKey: projectKeys.allLinkedFolders() });
      queryClient.invalidateQueries({ queryKey: ['archive-folders'] });
      showToast(variables.shared ? t('fileManager.toast.folderShared') : t('fileManager.toast.folderUnshared'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const toggleFolderShared = (folder: LibraryFolderTree) =>
    shareFolderMutation.mutate({ id: folder.id, shared: !folder.shared });

  const batchThumbnailMutation = useMutation({
    mutationFn: () => api.batchGenerateStlThumbnails({ all_missing: true }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      // Update thumbnail versions for cache busting
      if (result.succeeded > 0) {
        const now = Date.now();
        const newVersions: Record<number, number> = {};
        result.results.forEach((r) => {
          if (r.success) {
            newVersions[r.file_id] = now;
          }
        });
        setThumbnailVersions((prev) => ({ ...prev, ...newVersions }));
      }
      if (result.succeeded > 0 && result.failed === 0) {
        showToast(t('fileManager.toast.thumbnailsGenerated', { count: result.succeeded }), 'success');
      } else if (result.succeeded > 0 && result.failed > 0) {
        showToast(t('fileManager.toast.thumbnailsGeneratedPartial', { succeeded: result.succeeded, failed: result.failed }), 'success');
      } else if (result.processed === 0) {
        showToast(t('fileManager.toast.noStlMissingThumbnails'), 'info');
      } else {
        showToast(t('fileManager.toast.failedToGenerateThumbnails', { error: result.results[0]?.error || 'Unknown error' }), 'error');
      }
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const singleThumbnailMutation = useMutation({
    mutationFn: (fileId: number) => api.batchGenerateStlThumbnails({ file_ids: [fileId] }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      // Update thumbnail version for cache busting
      if (result.succeeded > 0) {
        const fileId = result.results[0]?.file_id;
        if (fileId) {
          setThumbnailVersions((prev) => ({ ...prev, [fileId]: Date.now() }));
        }
        showToast(t('fileManager.toast.thumbnailGenerated'), 'success');
      } else {
        showToast(t('fileManager.toast.failedToGenerateThumbnail', { error: result.results[0]?.error || 'Unknown error' }), 'error');
      }
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  // The one way into a preview (#2976): the kebab entry, the action-strip
  // icon, a double-click on the card or row, and the toolbar button all end
  // up here. Sliced files open the full-page gcode viewer the archive card
  // uses; everything else opens the modal for its type. A file with no
  // preview does nothing.
  const openPreview = useCallback((file: LibraryFileListItem) => {
    if (!hasPermission('library:read')) return;
    // A sliced file opens in the same part viewer as the project cards use: its Model
    // tab from the embedded mesh, its Toolpath tab from the G-code.
    if (isSlicedLibraryFile(file) || file.file_type === '3mf' || file.file_type === 'stl' || isStepType(file.file_type)) {
      setViewerFile(file);
    } else if (file.file_type === 'pdf') {
      setPdfPreviewFile(file);
    } else if (isSpreadsheetType(file.file_type)) {
      setSheetPreviewFile(file);
    } else if (isPreviewableImageType(file.file_type)) {
      setImagePreviewFile(file);
    }
  }, [hasPermission]);

  // Handlers
  const handleFileSelect = useCallback((id: number) => {
    // Always toggle selection (multi-select by default)
    setSelectedFiles((prev) => {
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
  }, []);

  // In the columns view Select all adds the pane's files to what is ticked, so
  // a file ticked in an earlier column (still on screen) stays ticked (#3020).
  // Grid and list replace the selection: a file a search has hidden must not
  // stay ticked behind the user's back, or a bulk Delete would remove it.
  const handleSelectAll = useCallback(() => {
    if (filteredAndSortedFiles.length > 0) {
      const paneIds = filteredAndSortedFiles.map((f) => f.id);
      setSelectedFiles((prev) => (viewMode === 'columns' ? [...new Set([...prev, ...paneIds])] : paneIds));
    }
  }, [filteredAndSortedFiles, viewMode]);

  // "Deselect all" once every file of the pane is ticked. The pane's own ids,
  // not a count: ticks in earlier columns count towards the selection too.
  const allPaneFilesSelected =
    filteredAndSortedFiles.length > 0 && filteredAndSortedFiles.every((f) => selectedFiles.includes(f.id));

  const handleDeselectAll = useCallback(() => {
    setSelectedFiles([]);
  }, []);

  const handleUploadComplete = () => {
    queryClient.invalidateQueries({ queryKey: ['library-files'] });
    queryClient.invalidateQueries({ queryKey: ['library-folders'] });
    queryClient.invalidateQueries({ queryKey: ['library-stats'] });
  };

  // Fenrir: say where an upload named after a project code was filed (projects PDM phase 5).
  const handleFileUploaded = (result: LibraryFileUploadResponse) => {
    const filed = result.filed_to_project;
    if (!filed) return;
    queryClient.invalidateQueries({ queryKey: ['project-tree', filed.project_id] });
    showToast(
      t('projectsPdm.filing.filedToProject', { code: filed.code, item: filed.item_name, revision: filed.revision_number }),
      'success',
    );
  };

  // Page-wide drag-and-drop upload (#1510). Disabled when the user lacks
  // library:upload so a non-uploader can't accidentally show the overlay,
  // and also disabled while the upload modal itself is open so drags into
  // the modal's own drop zone don't bubble up and flash the page overlay
  // behind it.
  // Find the selected folder in the tree to check external status
  const selectedFolder = useMemo(() => {
    if (!selectedFolderId || !folders) return null;
    const findFolder = (items: LibraryFolderTree[]): LibraryFolderTree | null => {
      for (const item of items) {
        if (item.id === selectedFolderId) return item;
        const found = findFolder(item.children);
        if (found) return found;
      }
      return null;
    };
    return findFolder(folders);
  }, [selectedFolderId, folders]);

  // A library:read_own user may add only to their own folders and shared
  // ones (#3201); a folder they merely pass through is read-only for them.
  const canWriteHere = selectedFolder?.can_write !== false;
  const canUpload = hasPermission('library:upload') && canWriteHere;
  const addDisabledTitle = !hasPermission('library:upload')
    ? undefined
    : !canWriteHere
      ? t('fileManager.folderNotWritable')
      : undefined;
  const { isDraggingOver, dragHandlers } = usePageFileDrop({
    disabled: !canUpload || showUploadModal,
    onFiles: (files) => {
      setDroppedFiles(files);
      setShowUploadModal(true);
    },
  });

  // Returns the snapshot callback the preview components call with their
  // first render, or undefined when nothing should be persisted — the file
  // already has a thumbnail, or the user may not update it (#2976).
  const previewSnapshotHandler = useCallback(
    (file: LibraryFileListItem): ((blob: Blob) => void) | undefined => {
      if (file.thumbnail_path) return undefined;
      if (!canModify('library', 'update', file.created_by_id)) return undefined;
      return (blob: Blob) => {
        api
          .uploadLibraryPreviewThumbnail(file.id, blob)
          .then((res) => {
            if (res.updated) {
              setThumbnailVersions((prev) => ({ ...prev, [file.id]: (prev[file.id] || 0) + 1 }));
              queryClient.invalidateQueries({ queryKey: ['library-files'] });
            }
          })
          .catch(() => {
            // Thumbnail persistence is best-effort; the preview already rendered.
          });
      };
    },
    [canModify, queryClient]
  );

  const handleDownload = (id: number) => {
    api.downloadLibraryFile(id).catch((err) => {
      console.error('Library file download failed:', err);
    });
  };

  const handleDeleteConfirm = () => {
    if (!deleteConfirm) return;
    if (deleteConfirm.type === 'file') {
      deleteFileMutation.mutate(deleteConfirm.id);
    } else if (deleteConfirm.type === 'folder') {
      deleteFolderMutation.mutate(deleteConfirm.id);
    } else if (deleteConfirm.type === 'bulk') {
      bulkDeleteMutation.mutate(selectedFiles);
    }
  };

  const isDeleting = deleteFolderMutation.isPending || deleteFileMutation.isPending || bulkDeleteMutation.isPending;

  const handleViewModeChange = (mode: 'grid' | 'list' | 'columns') => {
    setViewMode(mode);
    localStorage.setItem('library-view-mode', mode);
  };

  // Shared by the list row and the columns view (see FileActionStrip).
  const fileActionProps = {
    onPrint: setPrintFile,
    onSlice: setSliceFile,
    onOpenInSlicer: handleOpenInSlicer,
    onRunPipeline: setRunPipelineFile,
    useSlicerApi: settings?.use_slicer_api ?? false,
    desktopSlicer: preferredSlicer,
    canSlice: canSlice(),
    onPreview: openPreview,
    onDetails: setDetailsFile,
    onDownload: handleDownload,
    onRename: (f: LibraryFileListItem) => setRenameItem({ type: 'file', id: f.id, name: f.filename }),
    onGenerateThumbnail: (f: LibraryFileListItem) => singleThumbnailMutation.mutate(f.id),
    thumbnailPending: singleThumbnailMutation.isPending,
    onDelete: (id: number) => setDeleteConfirm({ type: 'file', id }),
    onMoveToProject: (f: LibraryFileListItem) => setMoveToProjectIds([f.id]), // Fenrir: projects PDM phase 5
    hasPermission,
    canModify,
    t,
  };

  const isLoading = foldersLoading || filesLoading || !restoredFolderChecked;

  // The chain of folders from a top-level folder down to the selected one.
  // Selection is the single source of truth — clicking a folder anywhere just
  // moves selectedFolderId, and the path (and with it the path bar and the set
  // of visible columns) is re-derived from the sorted tree.
  const folderPath = useMemo(() => {
    if (!sortedFolders || selectedFolderId === null) return [] as LibraryFolderTree[];
    const path: LibraryFolderTree[] = [];
    const walk = (items: LibraryFolderTree[]): boolean => {
      for (const item of items) {
        path.push(item);
        if (item.id === selectedFolderId) return true;
        if (walk(item.children)) return true;
        path.pop();
      }
      return false;
    };
    walk(sortedFolders);
    return path;
  }, [sortedFolders, selectedFolderId]);

  // Which half of the tree the current location lives in: the selected path's
  // bucket when there is one, otherwise the sidebar's top-level choice. Drives
  // both the path bar's root crumb and the columns view's first column.
  const currentBucketIsExternal =
    folderPath.length > 0 ? Boolean(folderPath[0].is_external) : topLevelView === 'external';

  // One column per level: the top-level bucket, then the children of each
  // folder along the path. `folderId` is the folder the column is the inside
  // of (null = the library root), which is what its file list is keyed on.
  // Leaf folders contribute no column — the files pane to the right is their
  // content.
  const folderColumns = useMemo(() => {
    const rootItems = (sortedFolders ?? []).filter((f) => Boolean(f.is_external) === currentBucketIsExternal);
    const cols: { key: string; folderId: number | null; items: LibraryFolderTree[]; activeId: number | null }[] = [
      { key: 'root', folderId: null, items: rootItems, activeId: folderPath[0]?.id ?? null },
    ];
    folderPath.forEach((node, i) => {
      if (node.children.length > 0) {
        cols.push({
          key: `folder-${node.id}`,
          folderId: node.id,
          items: node.children,
          activeId: folderPath[i + 1]?.id ?? null,
        });
      }
    });
    return cols;
  }, [sortedFolders, folderPath, currentBucketIsExternal]);

  // Every column lists its own level's files, not just the rightmost pane: a
  // folder that holds files and no subfolders used to look empty until it was
  // the selection. One query per rendered level, keyed on that level's folder
  // id so walking back up a path is instant. Only levels the view actually
  // renders are fetched, and the level that IS the current selection is
  // skipped — the pane on the right already lists exactly those files.
  const columnFileLevels = useMemo(() => {
    if (viewMode !== 'columns' || columnsFilterActive) return [];
    return folderColumns
      .filter((col) => col.folderId !== selectedFolderId)
      .map((col) => ({
        key: col.key,
        folderId: col.folderId,
        scope:
          col.folderId === null
            ? currentBucketIsExternal
              ? ('external' as const)
              : ('internal' as const)
            : undefined,
      }));
  }, [viewMode, columnsFilterActive, folderColumns, selectedFolderId, currentBucketIsExternal]);

  const columnFileQueries = useQueries({
    combine: combineColumnFileQueries,
    queries: columnFileLevels.map((level) => ({
      queryKey: ['library-files', 'column', level.folderId, level.scope ?? null],
      // include_root only means anything for the root column, where "this
      // level's files" are the ones that sit in no folder at all. Under a
      // folder id the server already answers with that folder's own files.
      queryFn: () =>
        api.getLibraryFiles(level.folderId, level.folderId === null, undefined, level.scope, false, []),
    })),
  });

  // Keyed by column so the render stays a lookup. Deliberately not memoised:
  // useQueries hands back a fresh array every render, so a memo would recompute
  // anyway.
  const columnFiles = new Map<string, { files: LibraryFileListItem[]; loading: boolean }>();
  columnFileLevels.forEach((level, i) => {
    const query = columnFileQueries.results[i];
    columnFiles.set(level.key, {
      files: filterAndSortFiles(query?.data ?? [], { filterType, filterUsername, sortField, sortDirection }),
      loading: Boolean(query?.isPending),
    });
  });

  // Every file a tick can point at: the pane plus the files of every column
  // the view has loaded, since a file can be ticked in an earlier column
  // (#3020). The toolbar's actions resolve the selection against this.
  const selectableFiles = useMemo(() => {
    const byId = new Map<number, LibraryFileListItem>();
    for (const file of [...(files ?? []), ...columnFileQueries.files]) byId.set(file.id, file);
    return byId;
  }, [files, columnFileQueries.files]);

  // The toolbar's Preview button acts on one file, so it is offered only for
  // a single previewable selection.
  const previewSelection = useMemo(() => {
    if (selectedFiles.length !== 1) return null;
    const file = selectableFiles.get(selectedFiles[0]);
    return file && isPreviewableLibraryFile(file) ? file : null;
  }, [selectableFiles, selectedFiles]);

  // The sliced files among the selection, in the order they were ticked.
  const selectedSlicedFiles = useMemo(
    () =>
      selectedFiles
        .map((id) => selectableFiles.get(id))
        .filter((f): f is LibraryFileListItem => !!f && isSlicedLibraryFile(f)),
    [selectableFiles, selectedFiles],
  );

  // "Combine to 3MF" is offered only when every selected file is an STL, so
  // the action never silently drops part of the selection. Resolved like the
  // rest, so an STL ticked in an earlier column counts too.
  const selectedStlFiles = useMemo(() => {
    const stls = selectedFiles
      .map((id) => selectableFiles.get(id))
      .filter((f): f is LibraryFileListItem => !!f && f.filename.toLowerCase().endsWith('.stl'));
    return stls.length === selectedFiles.length ? stls : [];
  }, [selectableFiles, selectedFiles]);

  // The clicked file's variant group, so printing one member offers the rest
  // without the user re-selecting them (#2570).
  const { data: printFileGroup } = useQuery({
    queryKey: ['variant-group', printFile?.variant_group_id],
    queryFn: () => api.getVariantGroup(printFile!.variant_group_id!),
    enabled: !!printFile?.variant_group_id,
  });

  // The selection is the rest of a partly queued run: the files it left, and
  // nothing else. Any other selection is a new print.
  const selectionIsRunRest = useMemo(() => {
    if (!separateJobsRun) return false;
    const left = separateJobsRun.remainingFileIds;
    return (
      left.length > 0 &&
      selectedSlicedFiles.length === left.length &&
      selectedSlicedFiles.every((f) => left.includes(f.id))
    );
  }, [separateJobsRun, selectedSlicedFiles]);
  // With several files selected the dialog shows the selection whichever
  // file's Print was clicked, so it is the run's rest then too; otherwise a
  // card's Print would start it as a new run and queue again what a printer
  // already has (#3471 review). One file left resumes only from that file.
  const resumeRun =
    selectionIsRunRest &&
    !!printFile &&
    (selectedSlicedFiles.length > 1 || separateJobsRun!.remainingFileIds.includes(printFile.id));

  // A run whose rest is no longer selected is over; a later selection of the
  // same files is a new print.
  useEffect(() => {
    if (separateJobsRun && !printFile && !selectionIsRunRest) setSeparateJobsRun(null);
  }, [separateJobsRun, printFile, selectionIsRunRest]);

  // Candidates for a cross-model print (#671), or undefined for an ordinary one.
  // An explicit multi-selection wins over the group: the user just said, in this
  // action, which files they meant. The rest of a partly queued run stays a
  // list even with one file left: a printer may already have it.
  const printVariantFiles = useMemo(() => {
    if (!printFile) return undefined;
    if (selectedSlicedFiles.length > 1 || resumeRun) {
      // The rest of a run keeps the order the run had in its dialog, not the
      // order the files were ticked in.
      const order = resumeRun ? separateJobsRun!.remainingFileIds : null;
      const files = order
        ? [...selectedSlicedFiles].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
        : selectedSlicedFiles;
      return files.map(f => ({
        id: f.id,
        filename: f.filename,
        sliced_for_model: f.sliced_for_model,
      }));
    }
    if (printFileGroup && printFileGroup.members.length > 1) {
      return printFileGroup.members.map(m => ({
        id: m.library_file_id,
        filename: m.filename,
        sliced_for_model: m.target_model,
      }));
    }
    return undefined;
  }, [resumeRun, separateJobsRun, printFile, selectedSlicedFiles, printFileGroup]);

  // The list the arrow keys walk: the one that actually holds the focused
  // file, which may be an intermediate column rather than the selected
  // folder's pane.
  const focusedFileColumnList =
    columnsFocusedFileId === null
      ? undefined
      : columnFileLevels
          .map((level) => columnFiles.get(level.key)?.files)
          .find((list) => list?.some((f) => f.id === columnsFocusedFileId));
  const focusedFileList = focusedFileColumnList ?? filteredAndSortedFiles;

  // Focus the columns pane when the view opens so arrow keys work right away,
  // and drop the file focus whenever the folder (and with it the file list)
  // changes. A modal or the search box taking focus naturally mutes the
  // pane's key handling — no explicit guards needed.
  useEffect(() => {
    if (viewMode === 'columns') columnsViewRef.current?.focus({ preventScroll: true });
  }, [viewMode]);
  useEffect(() => {
    setColumnsFocusedFileId(null);
  }, [selectedFolderId, viewMode]);
  // A selection belongs to the folder it was made in. Every column can tick a
  // file, so a selection that survived a folder change would leave Move and
  // Delete pointing at rows that are no longer anywhere on screen (#3020).
  useEffect(() => {
    setSelectedFiles([]);
  }, [selectedFolderId]);
  // Keep the keyboard-driven selection scrolled into view. Deliberately an
  // effect keyed on the ids, NOT per-render ref callbacks: those re-run on
  // every commit and would snap a manually scrolled column back to the
  // highlighted row whenever anything re-renders. scrollIntoView is guarded
  // because jsdom doesn't implement it.
  useEffect(() => {
    if (viewMode !== 'columns' || selectedFolderId === null) return;
    columnsViewRef.current?.querySelector(`[data-folder-id="${selectedFolderId}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedFolderId, viewMode]);
  useEffect(() => {
    if (viewMode !== 'columns' || columnsFocusedFileId === null) return;
    columnsViewRef.current?.querySelector(`[data-file-id="${columnsFocusedFileId}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [columnsFocusedFileId, viewMode]);

  // Finder-style keys: Up/Down move within the current column, Right descends
  // (into the first child folder, then into the files), Left ascends, Enter
  // opens the focused file's preview, Space toggles its selection.
  //
  // Actions: the focused file's icon strip is the only one in the Tab order
  // (roving tabindex), so Tab from the pane lands on it; the context-menu
  // key (or Shift+F10) jumps there directly, or opens the selected folder's
  // kebab while no file is focused. Inside a strip Left/Right walk the
  // buttons, Enter/Space activate one natively and Escape returns to the pane.
  const focusColumnsActions = () => {
    const root = columnsViewRef.current;
    if (!root) return;
    if (columnsFocusedFileId !== null) {
      root
        .querySelector<HTMLButtonElement>(`[data-file-id="${columnsFocusedFileId}"] [data-file-actions] button:not([disabled])`)
        ?.focus();
    } else if (selectedFolderId !== null) {
      const kebab = root.querySelector<HTMLButtonElement>(`[data-folder-id="${selectedFolderId}"] [data-folder-actions] button`);
      // Focus first so Tab continues into the menu that the click opens.
      kebab?.focus();
      kebab?.click();
    }
  };
  const handleColumnsKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return;
    if (target.closest('[data-folder-actions]')) {
      // A folder kebab (and the menu it opens) handles its own keys, except
      // that Escape and Up/Down hand focus back to the pane — otherwise the
      // arrows are dead until the user clicks or Shift+Tabs out of the kebab.
      if (e.key === 'Escape') {
        e.preventDefault();
        columnsViewRef.current?.focus({ preventScroll: true });
        return;
      }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      columnsViewRef.current?.focus({ preventScroll: true });
    }
    const strip = target.closest<HTMLElement>('[data-file-actions]');
    if (strip) {
      if (e.key === 'Enter' || e.key === ' ') return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const buttons = Array.from(strip.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
        buttons[buttons.indexOf(target as HTMLButtonElement) + (e.key === 'ArrowRight' ? 1 : -1)]?.focus();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        columnsViewRef.current?.focus({ preventScroll: true });
        return;
      }
      // Up/Down move the row focus below; DOM focus must leave the old row's
      // strip with it, or the next Enter would fire that row's button.
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') columnsViewRef.current?.focus({ preventScroll: true });
    }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      focusColumnsActions();
      return;
    }
    const inFiles = columnsFocusedFileId !== null;
    const selectedNode = folderPath[folderPath.length - 1];
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        if (inFiles || columnsFilterActive) {
          // findIndex yields -1 for a vanished focus id — ArrowDown then
          // lands on index 0, ArrowUp on -2 → no-op, both intended.
          const idx = focusedFileList.findIndex((f) => f.id === columnsFocusedFileId);
          const next = focusedFileList[idx + dir];
          if (next) setColumnsFocusedFileId(next.id);
          else if (dir === -1 && idx === 0 && focusedFileColumnList) {
            // Off the top of a column's files: back onto that same column's
            // folders, which is where ArrowDown came from.
            setColumnsFocusedFileId(null);
          }
        } else if (selectedFolderId === null) {
          if (dir === 1 && folderColumns[0].items.length > 0) {
            setSelectedFolderId(folderColumns[0].items[0].id);
          }
        } else {
          const col = folderColumns[folderPath.length - 1];
          const idx = col ? col.items.findIndex((f) => f.id === selectedFolderId) : -1;
          const next = idx === -1 ? undefined : col.items[idx + dir];
          if (next) setSelectedFolderId(next.id);
          else if (dir === 1 && idx !== -1) {
            // Past the last folder the column's own files continue the list,
            // exactly as they read on screen: the only way a keyboard
            // reaches an intermediate column's rows at all.
            const colFiles = col ? columnFiles.get(col.key)?.files : undefined;
            if (colFiles?.length) setColumnsFocusedFileId(colFiles[0].id);
          }
        }
        break;
      }
      case 'ArrowRight': {
        e.preventDefault();
        if (inFiles) break;
        if (!columnsFilterActive && selectedNode && selectedNode.children.length > 0) {
          setSelectedFolderId(selectedNode.children[0].id);
        } else if (filteredAndSortedFiles.length > 0) {
          setColumnsFocusedFileId(filteredAndSortedFiles[0].id);
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (inFiles) {
          setColumnsFocusedFileId(null);
          break;
        }
        // With a filter active the folder columns are hidden — don't move a
        // selection the user can't see.
        if (columnsFilterActive) break;
        if (folderPath.length > 1) {
          setSelectedFolderId(folderPath[folderPath.length - 2].id);
        } else if (folderPath.length === 1) {
          // Ascending past the top level: keep the bucket the user was
          // navigating — the tree can select a folder from either bucket
          // without touching topLevelView, and falling back to a stale one
          // would teleport the root column to the other folder set.
          setTopLevelView(folderPath[0].is_external ? 'external' : 'internal');
          setSelectedFolderId(null);
        } else if (selectedFolderId !== null) {
          // Selection not in the tree (e.g. a deep link to a deleted
          // folder): give the keyboard an escape hatch back to the root.
          setSelectedFolderId(null);
        }
        break;
      }
      // Enter and Space preventDefault BEFORE the inFiles check: DOM focus
      // may still sit on the last-clicked folder button, and the browser's
      // default activation would re-click it — snapping the selection back
      // to a folder the arrows have long left (Space would scroll the page).
      case 'Enter': {
        e.preventDefault();
        if (!inFiles) {
          // Enter means "open the selected thing": on a folder that is
          // descending, exactly like ArrowRight.
          if (!columnsFilterActive && selectedNode && selectedNode.children.length > 0) {
            setSelectedFolderId(selectedNode.children[0].id);
          } else if (filteredAndSortedFiles.length > 0) {
            setColumnsFocusedFileId(filteredAndSortedFiles[0].id);
          }
          break;
        }
        const file = focusedFileList.find((f) => f.id === columnsFocusedFileId);
        if (file) openPreview(file);
        break;
      }
      case ' ': {
        e.preventDefault();
        if (!inFiles) break;
        if (columnsFocusedFileId !== null) handleFileSelect(columnsFocusedFileId);
        break;
      }
    }
  };

  return (
    <div
      className="p-4 md:p-8 min-h-[calc(100vh-64px)] lg:h-screen flex flex-col relative"
      {...dragHandlers}
    >
      {/* Drag & Drop Overlay — page-wide file upload (#1510) */}
      {isDraggingOver && (
        <div className="animate-overlay-in fixed inset-0 z-50 bg-bambu-dark/90 flex items-center justify-center pointer-events-none">
          <div className="border-4 border-dashed border-bambu-green rounded-xl p-12 text-center">
            <Upload className="w-16 h-16 mx-auto mb-4 text-bambu-green" />
            <p className="text-2xl font-semibold text-white mb-2">{t('fileManager.dropFilesHere')}</p>
            <p className="text-bambu-gray">{t('fileManager.releaseToUpload')}</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 animate-rise-lg vt-page-title">
        <div className="max-md:hidden">
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <FolderOpen className="w-7 h-7 text-bambu-green" />
            {t('fileManager.title')}
          </h1>
          <p className="text-bambu-gray mt-1">
            {t('fileManager.subtitle')}
          </p>
        </div>
        {/* Wraps: up to nine controls, which pushed the page sideways on a
            phone (#3295). Next to the title it takes only the room left over
            (flex-1 from zero), so the title is not squeezed to fit it. */}
        <div className="flex flex-wrap items-center sm:justify-end sm:flex-1 gap-2 min-w-0">
          {/* View mode toggle */}
          <div className="flex items-center bg-bambu-dark rounded-lg p-1">
            <button
              onClick={() => handleViewModeChange('grid')}
              className={`p-1.5 rounded transition-colors ${
                viewMode === 'grid' ? 'bg-bambu-dark-secondary text-white' : 'text-bambu-gray hover:text-white'
              }`}
              title={t('fileManager.gridView')}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleViewModeChange('list')}
              className={`p-1.5 rounded transition-colors ${
                viewMode === 'list' ? 'bg-bambu-dark-secondary text-white' : 'text-bambu-gray hover:text-white'
              }`}
              title={t('fileManager.listView')}
            >
              <List className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleViewModeChange('columns')}
              className={`p-1.5 rounded transition-colors ${
                viewMode === 'columns' ? 'bg-bambu-dark-secondary text-white' : 'text-bambu-gray hover:text-white'
              }`}
              title={t('fileManager.columnsView')}
            >
              <Columns className="w-4 h-4" />
            </button>
          </div>
          <Button
            variant="secondary"
            onClick={() => batchThumbnailMutation.mutate()}
            disabled={batchThumbnailMutation.isPending || !hasAnyPermission('library:update_own', 'library:update_all')}
            title={!hasAnyPermission('library:update_own', 'library:update_all') ? t('fileManager.noPermissionGenerateThumbnail') : t('fileManager.generateThumbnailsForMissing')}
          >
            {batchThumbnailMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Image className="w-4 h-4 mr-2" />
            )}
            {t('fileManager.generateThumbnails')}
          </Button>
          {canUseCalculator && (
            <Button
              variant="secondary"
              onClick={() => refreshPrices.mutate()}
              disabled={refreshPrices.isPending}
              title={t('fileManager.refreshPricesTitle')}
              data-testid="refresh-prices"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${refreshPrices.isPending ? 'animate-spin' : ''}`} />
              {t('fileManager.refreshPrices')}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => setShowExternalFolderModal(true)}
            disabled={!hasPermission('library:upload')}
            title={!hasPermission('library:upload') ? t('fileManager.noPermissionCreateFolder') : t('fileManager.linkExternalFolder')}
          >
            <FolderSymlink className="w-4 h-4 mr-2" />
            {t('fileManager.linkExternal')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setShowNewFolderModal(true)}
            disabled={!canUpload}
            title={!hasPermission('library:upload') ? t('fileManager.noPermissionCreateFolder') : addDisabledTitle}
          >
            <FolderPlus className="w-4 h-4 mr-2" />
            {t('fileManager.newFolder')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setShowTagsModal(true)}
            title={t('fileManager.tags.manageTitle')}
          >
            <TagIcon className="w-4 h-4 mr-2" />
            {t('fileManager.tags.manage')}
          </Button>
          {hasPermission('library:purge') && (
            <Button
              variant="secondary"
              onClick={() => setShowPurgeModal(true)}
              title={t('libraryPurge.headerTooltip')}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {t('libraryPurge.headerButton')}
            </Button>
          )}
          {(hasAnyPermission('library:delete_own', 'library:delete_all')) && (
            <Link
              to="/files/trash"
              className="inline-flex items-center px-3 py-1.5 text-sm rounded bg-bambu-dark-secondary text-bambu-gray hover:text-white hover:bg-bambu-dark transition-colors"
              title={t('libraryTrash.headerTooltip')}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {t('libraryTrash.headerButton')}
              {typeof trashCount === 'number' && trashCount > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-bambu-green/20 text-bambu-green">
                  {trashCount}
                </span>
              )}
            </Link>
          )}
          <Button
            onClick={() => setShowUploadModal(true)}
            disabled={!canUpload}
            title={!hasPermission('library:upload') ? t('fileManager.noPermissionUpload') : addDisabledTitle}
          >
            <Upload className="w-4 h-4 mr-2" />
            {t('common.upload')}
          </Button>
        </div>
      </div>

      {/* Disk space warning */}
      {isDiskSpaceLow && stats && settings && (
        <div className="flex items-center gap-3 mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
          <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-amber-500 font-medium">{t('fileManager.lowDiskSpaceWarning')}</p>
            <p className="text-xs text-amber-500/80">
              {t('fileManager.lowDiskSpaceDetails', { free: formatFileSize(stats.disk_free_bytes), total: formatFileSize(stats.disk_total_bytes), threshold: settings.library_disk_warning_gb })}
            </p>
          </div>
        </div>
      )}

      {/* Stats bar */}
      {stats && (
        <div className="flex flex-wrap items-center gap-3 sm:gap-6 mb-6 p-3 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary">
          <div className="flex items-center gap-2 text-sm">
            <File className="w-4 h-4 text-bambu-green" />
            <span className="text-bambu-gray">{t('fileManager.files')}:</span>
            <span className="text-white font-medium">{stats.total_files}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <FolderOpen className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span className="text-bambu-gray">{t('fileManager.folders')}:</span>
            <span className="text-white font-medium">{stats.total_folders}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <HardDrive className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            <span className="text-bambu-gray">{t('fileManager.size')}:</span>
            <span className="text-white font-medium">{formatFileSize(stats.total_size_bytes)}</span>
          </div>
          <div className="flex items-center gap-2 text-sm sm:ml-auto">
            <span className="text-bambu-gray">{t('fileManager.free')}:</span>
            <span className={`font-medium ${isDiskSpaceLow ? 'text-amber-500' : 'text-white'}`}>
              {formatFileSize(stats.disk_free_bytes)}
            </span>
          </div>
        </div>
      )}

      {/* Uploads from a review-mode virtual printer, waiting for approval;
          approving stores them in the File Manager. Renders nothing when none. */}
      <PendingUploadsPanel />

      {/* Main content */}
      <div className="flex-1 flex flex-col lg:flex-row gap-4 lg:gap-6 min-h-0">
        {/* Mobile folder selector */}
        <div className="lg:hidden">
          <select
            value={selectedFolderId !== null ? String(selectedFolderId) : `__top:${topLevelView}`}
            onChange={(e) => {
              const v = e.target.value;
              if (v.startsWith('__top:')) {
                setSelectedFolderId(null);
                setTopLevelView(v.slice('__top:'.length) as 'internal' | 'external');
              } else {
                setSelectedFolderId(parseInt(v, 10));
              }
            }}
            className="w-full bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-bambu-green"
          >
            <option value="__top:internal">📁 {t('fileManager.allFiles')}</option>
            {folders?.some((f) => f.is_external) && (
              <option value="__top:external">🔗 {t('fileManager.allExternal')}</option>
            )}
            {sortedFolders && (() => {
              // Flatten folder tree for mobile selector
              const flattenFolders = (items: LibraryFolderTree[], depth = 0): { id: number; name: string; fileCount: number; depth: number }[] => {
                const result: { id: number; name: string; fileCount: number; depth: number }[] = [];
                for (const item of items) {
                  result.push({ id: item.id, name: item.name, fileCount: item.file_count, depth });
                  if (item.children.length > 0) {
                    result.push(...flattenFolders(item.children, depth + 1));
                  }
                }
                return result;
              };
              return flattenFolders(sortedFolders).map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {'│ '.repeat(folder.depth)}📂 {folder.name} {folder.fileCount > 0 ? `(${folder.fileCount})` : ''}
                </option>
              ));
            })()}
          </select>
        </div>

        {/* Folder sidebar - resizable, hidden on mobile */}
        <div
          ref={sidebarRef}
          data-testid="folder-sidebar"
          className="hidden lg:flex flex-shrink-0 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary overflow-hidden flex-col relative"
          style={{ width: `${sidebarWidth}px` }}
        >
          {/* Resize handle - drag to resize, double-click to reset */}
          <div
            className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 group/resize flex items-center justify-center transition-colors ${
              isResizing ? 'bg-bambu-green' : 'hover:bg-bambu-green/50'
            }`}
            onMouseDown={(e) => {
              e.preventDefault();
              setIsResizing(true);
            }}
            onDoubleClick={() => {
              setSidebarWidth(256); // Reset to default w-64
              localStorage.setItem('library-sidebar-width', '256');
            }}
            title={t('fileManager.dragToResizeTooltip')}
          >
            {/* Grip dots */}
            <div className={`flex flex-col gap-1 opacity-0 group-hover/resize:opacity-100 transition-opacity ${isResizing ? 'opacity-100' : ''}`}>
              <div className="w-0.5 h-0.5 rounded-full bg-white/70" />
              <div className="w-0.5 h-0.5 rounded-full bg-white/70" />
              <div className="w-0.5 h-0.5 rounded-full bg-white/70" />
            </div>
          </div>
          <div className="p-3 border-b border-bambu-dark-tertiary flex items-center justify-between">
            <h2 className="text-sm font-medium text-white">{t('fileManager.folders')}</h2>
            <div className="flex items-center gap-1">
              {/* Folder tree sort (#1770). Dropdown drives the comparator;
                  direction button flips asc/desc. Both persist to localStorage
                  on change so the choice survives reloads. */}
              <select
                value={folderSortField}
                onChange={(e) => {
                  const v = e.target.value === 'activity' ? 'activity' : 'name';
                  setFolderSortField(v);
                  localStorage.setItem('library-folder-sort-field', v);
                }}
                className="text-xs px-1 py-0.5 rounded bg-bambu-dark border border-bambu-dark-tertiary text-bambu-gray focus:outline-none focus:border-bambu-green"
                title={t('fileManager.folderSort')}
                aria-label={t('fileManager.folderSort')}
              >
                <option value="name">{t('fileManager.folderSortByName')}</option>
                <option value="activity">{t('fileManager.folderSortByActivity')}</option>
              </select>
              <button
                onClick={() => {
                  const newValue = folderSortDirection === 'asc' ? 'desc' : 'asc';
                  setFolderSortDirection(newValue);
                  localStorage.setItem('library-folder-sort-direction', newValue);
                }}
                className="text-bambu-gray hover:text-white hover:bg-bambu-dark p-1 rounded transition-colors"
                title={folderSortDirection === 'asc' ? t('fileManager.ascending') : t('fileManager.descending')}
                aria-label={folderSortDirection === 'asc' ? t('fileManager.ascending') : t('fileManager.descending')}
              >
                {folderSortDirection === 'asc' ? <SortAsc className="w-3.5 h-3.5" /> : <SortDesc className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={() => {
                  const newValue = !collapseFoldersByDefault;
                  setCollapseFoldersByDefault(newValue);
                  localStorage.setItem('library-collapse-folders', String(newValue));
                }}
                className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                  collapseFoldersByDefault
                    ? 'bg-bambu-green/20 text-bambu-green'
                    : 'text-bambu-gray hover:text-white hover:bg-bambu-dark'
                }`}
                title={collapseFoldersByDefault ? t('fileManager.expandFoldersByDefault') : t('fileManager.collapseFoldersByDefault')}
              >
                {t('fileManager.collapse')}
              </button>
              <button
                onClick={() => {
                  const newValue = !wrapFolderNames;
                  setWrapFolderNames(newValue);
                  localStorage.setItem('library-wrap-folders', String(newValue));
                }}
                className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                  wrapFolderNames
                    ? 'bg-bambu-green/20 text-bambu-green'
                    : 'text-bambu-gray hover:text-white hover:bg-bambu-dark'
                }`}
                title={wrapFolderNames ? t('fileManager.disableTextWrapping') : t('fileManager.enableTextWrapping')}
              >
                {t('fileManager.wrap')}
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {/* All Files = the user's own uploaded / managed-storage files
                only. External folders are surfaced separately below to keep
                a linked NAS from drowning the user's own uploads (#1621). */}
            <FolderDropZone
              folderDrag={folderDrag}
              destinationId={null}
              className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                selectedFolderId === null && topLevelView === 'internal'
                  ? 'bg-bambu-green/20 text-bambu-green'
                  : 'hover:bg-bambu-dark text-white'
              }`}
              onClick={() => {
                setSelectedFolderId(null);
                setTopLevelView('internal');
              }}
            >
              <FileBox className="w-4 h-4" />
              <span className="text-sm">{t('fileManager.allFiles')}</span>
            </FolderDropZone>

            {/* External (combined) — only shown when at least one external
                folder is linked. Single folder users don't need a combined
                view; clicking the individual folder is just as fast. */}
            {folders?.some((f) => f.is_external) && (
              <div
                className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                  selectedFolderId === null && topLevelView === 'external'
                    ? 'bg-bambu-green/20 text-bambu-green'
                    : 'hover:bg-bambu-dark text-white'
                }`}
                onClick={() => {
                  setSelectedFolderId(null);
                  setTopLevelView('external');
                }}
              >
                <FolderSymlink className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                <span className="text-sm">{t('fileManager.allExternal')}</span>
              </div>
            )}

            {/* Folder tree — re-key on the collapse toggle so flipping it
                remounts every FolderTreeItem, which re-reads defaultExpanded
                and makes the preference take effect immediately. */}
            {sortedFolders?.map((folder) => (
              <FolderTreeItem
                key={`${folder.id}-${collapseFoldersByDefault ? 'c' : 'e'}`}
                folder={folder}
                selectedFolderId={selectedFolderId}
                onSelect={setSelectedFolderId}
                onDelete={(id) => setDeleteConfirm({ type: 'folder', id })}
                onLink={setLinkFolder}
                onRename={(f) => setRenameItem({ type: 'folder', id: f.id, name: f.name })}
                onMove={setMoveFolder}
                onToggleShared={toggleFolderShared}
                folderDrag={folderDrag}
                wrapNames={wrapFolderNames}
                defaultExpanded={!collapseFoldersByDefault}
                showModified={showModified}
                hasPermission={hasPermission}
                t={t}
              />
            ))}
          </div>
        </div>

        {/* Files area + README rail (#2520 item 2). On wide screens the
            README docks as a collapsible right-hand column (rendered after
            the files column, below) so it no longer steals vertical space
            from the file list; on narrow screens it stacks above the list
            via `order-first` and the page itself scrolls. */}
        <div className="flex-1 flex flex-col lg:flex-row min-w-0 min-h-0 gap-4 lg:gap-6">
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Tag filter rail (#1268, #3411). Hidden entirely when the
              catalog is empty so brand-new installs don't see a stray rail. */}
          {tagCatalog.length > 0 && (
            <LibraryTagFilterRail
              tags={tagCatalog}
              selectedIds={selectedTagIds}
              onToggle={toggleTagFilter}
              onClear={clearTagFilter}
            />
          )}
          {/* External folder info bar */}
          {selectedFolder?.is_external && (
            <div className="flex items-center gap-3 mb-4 p-3 bg-purple-50 dark:bg-purple-500/10 border border-purple-300 dark:border-purple-500/30 rounded-lg">
              <FolderSymlink className="w-5 h-5 text-purple-600 dark:text-purple-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-purple-700 dark:text-purple-300">{t('fileManager.externalFolder')}</span>
                  {selectedFolder.external_readonly && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 flex items-center gap-1">
                      <Lock className="w-3 h-3" />
                      {t('fileManager.readOnly')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-bambu-gray truncate font-mono" title={selectedFolder.external_path || ''}>
                  {selectedFolder.external_path}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => selectedFolderId && scanExternalFolderMutation.mutate(selectedFolderId)}
                disabled={scanExternalFolderMutation.isPending}
                title={t('fileManager.scanFolder')}
              >
                {scanExternalFolderMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                <span className="ml-1.5">{t('fileManager.scanFolder')}</span>
              </Button>
            </div>
          )}
          {/* Search, Filter, Sort toolbar - sticky on mobile for easier access */}
          {(files.length > 0 || hasActiveFilters || filesArePlaceholder) && (
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4 p-2 sm:p-3 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary sticky top-0 z-10 lg:static">
              {/* Search */}
              <div className="relative w-full sm:w-auto sm:flex-1 sm:max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bambu-gray" />
                <input
                  type="text"
                  placeholder={t('fileManager.searchFiles')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded text-sm text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
                />
                {searchExpandsSubfolders && (
                  <span
                    className="absolute -bottom-4 left-0 text-[10px] text-bambu-gray whitespace-nowrap"
                    title={t('fileManager.searchSubfoldersHint')}
                  >
                    {t('fileManager.searchSubfoldersHint')}
                  </span>
                )}
              </div>

              {/* Type filter */}
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-bambu-gray hidden sm:block" />
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                  className="bg-bambu-dark border border-bambu-dark-tertiary rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-bambu-green"
                >
                  <option value="all">{t('fileManager.allTypes')}</option>
                  {fileTypes.map((type) => (
                    <option key={type} value={type}>
                      {type.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>

              {/* Username filter with autocomplete - only show when auth is enabled */}
              {authEnabled && (
                <div className="relative">
                  <input
                    type="text"
                    placeholder={t('fileManager.filterByUser', { defaultValue: 'Filter by user' })}
                    value={filterUsername}
                    onChange={(e) => setFilterUsername(e.target.value)}
                    list="usernames-list"
                    className={`w-32 sm:w-40 px-2 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded text-sm text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green ${filterUsername ? 'pr-7' : ''}`}
                    style={filterUsername ? { WebkitAppearance: 'none', MozAppearance: 'textfield' } : undefined}
                  />
                  {filterUsername && (
                    <button
                      onClick={() => setFilterUsername('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-bambu-gray hover:text-white z-10"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                  <datalist id="usernames-list">
                    {users?.map((user) => (
                      <option key={user.id} value={user.username} />
                    ))}
                  </datalist>
                </div>
              )}

              {/* Sort */}
              <div className="flex items-center gap-2">
                <select
                  value={sortField}
                  onChange={(e) => updateViewSettings({ sortField: e.target.value as SortField })}
                  className="bg-bambu-dark border border-bambu-dark-tertiary rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-bambu-green"
                >
                  <option value="name">{t('common.name')}</option>
                  <option value="date">{t('common.date')}</option>
                  <option value="size">{t('fileManager.size')}</option>
                  <option value="type">{t('common.type')}</option>
                  <option value="prints">{t('fileManager.prints')}</option>
                </select>
                <button
                  onClick={() => updateViewSettings({ sortDirection: sortDirection === 'asc' ? 'desc' : 'asc' })}
                  className="p-1.5 rounded bg-bambu-dark border border-bambu-dark-tertiary hover:border-bambu-green transition-colors"
                  title={sortDirection === 'asc' ? t('fileManager.ascending') : t('fileManager.descending')}
                >
                  {sortDirection === 'asc' ? (
                    <SortAsc className="w-4 h-4 text-white" />
                  ) : (
                    <SortDesc className="w-4 h-4 text-white" />
                  )}
                </button>
                <button
                  onClick={() => setShowModified((v) => {
                    const next = !v;
                    localStorage.setItem('library-show-modified', String(next));
                    return next;
                  })}
                  className={`p-1.5 rounded bg-bambu-dark border transition-colors ${
                    showModified ? 'border-bambu-green text-bambu-green' : 'border-bambu-dark-tertiary text-white hover:border-bambu-green'
                  }`}
                  title={showModified ? t('fileManager.hideModified') : t('fileManager.showModified')}
                  aria-pressed={showModified}
                >
                  <CalendarClock className="w-4 h-4" />
                </button>
              </div>

              {/* Results count */}
              <span className="text-sm text-bambu-gray hidden sm:inline" data-testid="files-count">
                {t('fileManager.resultsCount', { showing: files.length, total: totalFiles })}
              </span>
            </div>
          )}

          {/* Selection toolbar - sticky on mobile below search bar. It stays
              while anything is selected, even with the selected folder's own
              pane empty: a file ticked in an intermediate column of the
              columns view still needs its count and actions (#3020). */}
          {(filteredAndSortedFiles.length > 0 || selectedFiles.length > 0) && (
            <div className="flex flex-wrap items-center gap-2 mb-4 p-2 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary sticky top-[52px] z-10 lg:static">
              {/* Select all / Deselect all */}
              {allPaneFilesSelected ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleDeselectAll}
                >
                  <Square className="w-4 h-4 sm:mr-1" />
                  <span className="hidden sm:inline">{t('fileManager.deselectAll')}</span>
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSelectAll}
                >
                  <CheckSquare className="w-4 h-4 sm:mr-1" />
                  <span className="hidden sm:inline">{t('fileManager.selectAll')}</span>
                </Button>
              )}

              {selectedFiles.length > 0 && (
                <>
                  <span className="text-sm text-bambu-gray ml-2">
                    {t('fileManager.selected', { count: selectedFiles.length })}
                  </span>
                  <div className="hidden sm:block flex-1" />
                  <div className="w-full sm:w-auto flex flex-wrap items-center gap-2 mt-2 sm:mt-0">
                    {previewSelection && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openPreview(previewSelection)}
                        disabled={!hasPermission('library:read')}
                        title={!hasPermission('library:read') ? t('fileManager.noPermissionPreview') : undefined}
                      >
                        <Eye className="w-4 h-4 sm:mr-1" />
                        <span className="hidden sm:inline">{t('fileManager.preview.open')}</span>
                      </Button>
                    )}
                    {/* Print used to disappear the moment a second sliced file was
                        selected. Selecting several is now how you say "same job,
                        different printers" (#671) — one queue item, whichever
                        machine frees up first. */}
                    {selectedSlicedFiles.length >= 1 && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setPrintFile(selectedSlicedFiles[0])}
                        disabled={!hasPermission('queue:create')}
                        title={!hasPermission('queue:create') ? t('fileManager.noPermissionAddToQueue') : undefined}
                      >
                        <Printer className="w-4 h-4 sm:mr-1" />
                        <span className="hidden sm:inline">
                          {selectedSlicedFiles.length > 1
                            ? t('fileManager.printFiles', { count: selectedSlicedFiles.length })
                            : t('common.print')}
                        </span>
                      </Button>
                    )}
                    {selectedSlicedFiles.length >= 2 && !selectedSlicedFiles.some(f => f.variant_group_id) && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => groupAsVersionsMutation.mutate(selectedSlicedFiles.map(f => f.id))}
                        disabled={
                          groupAsVersionsMutation.isPending
                          || !hasAnyPermission('library:update_own', 'library:update_all')
                        }
                        title={t('fileManager.variants.groupTooltip')}
                      >
                        <Layers className="w-4 h-4 sm:mr-1" />
                        <span className="hidden sm:inline">{t('fileManager.variants.groupAction')}</span>
                      </Button>
                    )}
                    {selectedStlFiles.length >= 1 && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setShowCombineModal(true)}
                        disabled={!hasPermission('library:upload')}
                        title={t('fileManager.combine.tooltip')}
                      >
                        <Combine className="w-4 h-4 sm:mr-1" />
                        <span className="hidden sm:inline">{t('fileManager.combine.action')}</span>
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setShowMoveModal(true)}
                      disabled={!hasAnyPermission('library:update_own', 'library:update_all')}
                      title={!hasAnyPermission('library:update_own', 'library:update_all') ? t('fileManager.noPermissionMoveFiles') : undefined}
                    >
                      <MoveRight className="w-4 h-4 sm:mr-1" />
                      <span className="hidden sm:inline">{t('common.move')}</span>
                    </Button>
                    {/* Fenrir: Move to project (projects PDM phase 5) — non-printable files come back as skipped */}
                    {hasAnyPermission('library:update_own', 'library:update_all') && hasPermission('projects:update') && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setMoveToProjectIds([...selectedFiles])}
                        title={t('projectsPdm.filing.moveToProject')}
                        aria-label={t('projectsPdm.filing.moveToProject')}
                      >
                        <FolderInput className="w-4 h-4 sm:mr-1" />
                        <span className="hidden sm:inline">{t('projectsPdm.filing.moveToProject')}</span>
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setShowBulkTagsModal(true)}
                      disabled={!hasAnyPermission('library:update_own', 'library:update_all')}
                      title={!hasAnyPermission('library:update_own', 'library:update_all') ? t('fileManager.tags.noPermission') : t('fileManager.tags.bulkTooltip')}
                    >
                      <TagIcon className="w-4 h-4 sm:mr-1" />
                      <span className="hidden sm:inline">{t('fileManager.tags.tagAction')}</span>
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        if (selectedFiles.length === 1) {
                          setDeleteConfirm({ type: 'file', id: selectedFiles[0] });
                        } else {
                          setDeleteConfirm({ type: 'bulk', id: 0, count: selectedFiles.length });
                        }
                      }}
                      disabled={!hasAnyPermission('library:delete_own', 'library:delete_all')}
                      title={!hasAnyPermission('library:delete_own', 'library:delete_all') ? t('fileManager.noPermissionDeleteFiles') : undefined}
                    >
                      <Trash2 className="w-4 h-4 sm:mr-1" />
                      <span className="hidden sm:inline">{t('common.delete')}</span>
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleDeselectAll}
                    >
                      <X className="w-4 h-4 sm:mr-1" />
                      <span className="hidden sm:inline">{t('common.clear')}</span>
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* File grid/list. The columns view is exempt from the full-pane
              loading swap: every keyboard descent into an uncached folder
              flips filesLoading for one round-trip, and replacing the pane
              would strip its tabindex mid-keystroke — the focus-fixup rule
              then drops focus to <body> and kills keyboard navigation. The
              pane stays mounted and only its files pane shows the spinner. */}
          {isLoading && viewMode !== 'columns' ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="w-8 h-8 animate-spin text-bambu-green" />
                <p className="text-sm text-bambu-gray">{t('fileManager.loadingFiles')}</p>
              </div>
            </div>
          ) : viewMode === 'columns' ? (
            /* Miller columns (macOS-Finder style): one column per folder level,
               the rightmost pane lists the selected folder's files. Unlike the
               grid/list branches this renders even for an "empty" folder — an
               empty files pane next to navigable folder columns is the whole
               point of the view. */
            <div
              ref={columnsViewRef}
              tabIndex={0}
              aria-label={t('fileManager.columnsView')}
              onKeyDown={handleColumnsKeyDown}
              className="flex-1 min-h-0 bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary overflow-x-auto outline-none focus-visible:ring-1 focus-visible:ring-bambu-green/50"
              data-testid="columns-view"
            >
              <div className="h-full min-h-[16rem] flex divide-x divide-bambu-dark-tertiary">
                {!columnsFilterActive && folderColumns.map((col) => {
                  const level = columnFiles.get(col.key);
                  // A column carrying file rows needs the room the files pane
                  // has: checkbox, thumbnail and the seven-icon action strip
                  // leave nothing for the name at the folder-only width. A
                  // column that only lists folders keeps that narrow width.
                  const wide = Boolean(level && (level.loading || level.files.length > 0));
                  return (
                  /* Dropping a dragged folder on a column's empty space moves
                     it into that column's folder (#3305); the external bucket's
                     root column is not a destination. */
                  <FolderDropZone
                    key={col.key}
                    folderDrag={folderDrag}
                    destinationId={col.folderId}
                    enabled={!(col.folderId === null && currentBucketIsExternal)}
                    data-testid={`columns-level-${col.key}`}
                    className={`${wide ? 'w-[26rem]' : 'w-64'} flex-shrink-0 overflow-y-auto py-1`}
                  >
                    {col.items.map((folder) => {
                      const isSelectedFolder = selectedFolderId === folder.id;
                      const canDragFolder = folderDrag.canDrag(folder);
                      return (
                        /* The row is a div, not the button itself: the kebab
                           is a button of its own and buttons don't nest. */
                        <FolderDropZone
                          key={folder.id}
                          folderDrag={folderDrag}
                          destinationId={folder.id}
                          data-folder-id={folder.id}
                          draggable={canDragFolder || undefined}
                          onDragStart={canDragFolder ? (e) => folderDrag.onDragStart(folder, e) : undefined}
                          onDragEnd={canDragFolder ? folderDrag.onDragEnd : undefined}
                          className={`group flex items-center pr-1.5 transition-colors ${
                            col.activeId === folder.id
                              ? 'bg-bambu-green/20 text-bambu-green'
                              : isSelectedFolder
                                ? 'bg-bambu-green/10 text-white'
                                : 'text-white hover:bg-bambu-dark'
                          }`}
                        >
                          <button
                            type="button"
                            // Roving tabindex: the pane is the keyboard surface
                            // (arrows walk the folders), so Tab skips the names
                            // and goes straight to the selected row's kebab and
                            // on to the focused file's actions.
                            tabIndex={-1}
                            onClick={() => {
                              // Clear the file focus here too: re-clicking the
                              // already-selected folder bails out of the state
                              // update, so the clearing effect would not run and
                              // the arrow keys would stay stuck in the files pane.
                              setColumnsFocusedFileId(null);
                              setSelectedFolderId(folder.id);
                            }}
                            className="flex-1 min-w-0 flex items-center gap-2 pl-3 pr-1 py-2.5 text-left text-sm"
                            title={folder.name}
                          >
                            {folder.is_external ? (
                              <FolderSymlink className="w-5 h-5 flex-shrink-0 text-purple-600 dark:text-purple-400" />
                            ) : (
                              <FolderOpen className="w-5 h-5 flex-shrink-0 text-bambu-green" />
                            )}
                            <span className="flex-1 truncate">{folder.name}</span>
                            {(folder.project_id || folder.archive_id) && (
                              <Link2 className="w-3.5 h-3.5 flex-shrink-0 text-blue-700 dark:text-blue-400" />
                            )}
                            {folder.shared && (
                              <span title={t('fileManager.sharedFolder')}>
                                <Users className="w-3.5 h-3.5 flex-shrink-0 text-bambu-gray" />
                              </span>
                            )}
                            {folder.is_external && folder.external_readonly && (
                              <Lock className="w-3.5 h-3.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                            )}
                            {folder.file_count > 0 && (
                              <span className="text-xs text-bambu-gray flex-shrink-0">{folder.file_count}</span>
                            )}
                            {folder.children.length > 0 && (
                              <ChevronRightIcon className="w-4 h-4 flex-shrink-0 text-bambu-gray" />
                            )}
                          </button>
                          {/* Kebab: hover-revealed with a mouse, always there
                              without one (#2865) and on the selected row. */}
                          <FolderActionsMenu
                            folder={folder}
                            onDelete={(id) => setDeleteConfirm({ type: 'folder', id })}
                            onLink={setLinkFolder}
                            onRename={(f) => setRenameItem({ type: 'folder', id: f.id, name: f.name })}
                            onMove={setMoveFolder}
                            onToggleShared={toggleFolderShared}
                            hasPermission={hasPermission}
                            revealOnHover={!isSelectedFolder}
                            tabIndex={isSelectedFolder ? 0 : -1}
                            t={t}
                          />
                        </FolderDropZone>
                      );
                    })}
                    {level?.loading && (
                      <div className="px-3 py-2 text-sm text-bambu-gray" aria-hidden="true">…</div>
                    )}
                    {level && !level.loading && level.files.map((file) => (
                      <ColumnFileRow
                        key={file.id}
                        file={file}
                        isSelected={selectedFiles.includes(file.id)}
                        isHighlighted={highlightedFileId === file.id}
                        isFocused={columnsFocusedFileId === file.id}
                        showModified={showModified}
                        thumbnailVersion={thumbnailVersions[file.id]}
                        onSelect={(f) => {
                          // Focusing a file in an intermediate column must not
                          // move the folder selection out from under it.
                          setColumnsFocusedFileId(f.id);
                          handleFileSelect(f.id);
                        }}
                        onOpen={openPreview}
                        actionProps={fileActionProps}
                        t={t}
                      />
                    ))}
                  </FolderDropZone>
                  );
                })}
                {/* Files pane — still the selected folder's contents, so a
                    leaf folder's column layout is exactly what it was. */}
                <div className="flex-1 min-w-[28rem] overflow-y-auto py-1" data-testid="columns-files-pane">
                  {filesLoading ? (
                    <div className="h-full flex items-center justify-center">
                      <Loader2 className="w-5 h-5 animate-spin text-bambu-green" />
                    </div>
                  ) : filteredAndSortedFiles.length === 0 ? (
                    <div className="h-full flex items-center justify-center px-4 text-sm text-bambu-gray text-center">
                      {(files?.length ?? 0) > 0
                        ? t('fileManager.noMatchingFiles')
                        : selectedFolderId !== null
                          ? t('fileManager.folderIsEmpty')
                          // At the root the pane lists only the files in no
                          // folder, so with folders beside it "No files yet"
                          // would be wrong (and an external bucket never has
                          // unfiled files at all).
                          : paneRootOnly && folderColumns[0].items.length > 0
                            ? t('fileManager.noFilesOutsideFolders')
                          : topLevelView === 'external'
                            ? t('fileManager.externalIsEmpty')
                            : t('fileManager.noFilesYet')}
                    </div>
                  ) : (
                    filteredAndSortedFiles.map((file) => (
                      <ColumnFileRow
                        key={file.id}
                        file={file}
                        isSelected={selectedFiles.includes(file.id)}
                        isHighlighted={highlightedFileId === file.id}
                        isFocused={columnsFocusedFileId === file.id}
                        showModified={showModified}
                        thumbnailVersion={thumbnailVersions[file.id]}
                        onSelect={(f) => {
                          setColumnsFocusedFileId(f.id);
                          handleFileSelect(f.id);
                        }}
                        onOpen={openPreview}
                        actionProps={fileActionProps}
                        t={t}
                      />
                    ))
                  )}
                  {hasNextPage && <div ref={sentinelRef} className="h-px" aria-hidden="true" />}
                </div>
              </div>
            </div>
          ) : files.length === 0 && !hasActiveFilters && !filesArePlaceholder ? (
            <div className="flex-1 flex flex-col items-center justify-center">
              <div className="p-4 bg-bambu-dark rounded-2xl mb-4">
                <FileBox className="w-12 h-12 text-bambu-gray/50" />
              </div>
              <h3 className="text-lg font-medium text-white mb-2">
                {selectedFolderId !== null
                  ? t('fileManager.folderIsEmpty')
                  : topLevelView === 'external'
                    ? t('fileManager.externalIsEmpty')
                    : t('fileManager.noFilesYet')}
              </h3>
              <p className="text-bambu-gray text-center max-w-md mb-6">
                {selectedFolderId !== null
                  ? t('fileManager.folderEmptyDescription')
                  : topLevelView === 'external'
                    ? t('fileManager.externalEmptyDescription')
                    : t('fileManager.noFilesDescription')}
              </p>
              <Button
                onClick={() => setShowUploadModal(true)}
                disabled={!canUpload}
                title={!hasPermission('library:upload') ? t('fileManager.noPermissionUpload') : addDisabledTitle}
              >
                <Plus className="w-4 h-4 mr-2" />
                {t('fileManager.uploadFiles')}
              </Button>
            </div>
          ) : files.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center">
              <div className="p-4 bg-bambu-dark rounded-2xl mb-4">
                <Search className="w-12 h-12 text-bambu-gray/50" />
              </div>
              <h3 className="text-lg font-medium text-white mb-2">{t('fileManager.noMatchingFiles')}</h3>
              <p className="text-bambu-gray text-center max-w-md mb-6">
                {t('fileManager.noMatchingFilesDescription')}
              </p>
              <Button variant="secondary" onClick={() => updateViewSettings({ search: '', filterType: 'all', filterUsername: '' })}>
                {t('fileManager.clearFilters')}
              </Button>
            </div>
          ) : viewMode === 'grid' ? (
            <div className="flex-1 lg:overflow-y-auto">
              {/* stagger-parents + animate-rise-lg cascades the cards in on first
                  paint and for cards that newly enter; each card's info block
                  then cascades via stagger-nested inside FileCard. useFlipReorder
                  slides persisting cards to new slots on search/filter/sort. */}
              <div
                ref={fileGridRef}
                className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4 stagger-parents"
              >
                {filteredAndSortedFiles.map((file) => (
                  <div key={file.id} data-flip-key={file.id} className="animate-rise-lg">
                  <FileCard
                    file={file}
                    isSelected={selectedFiles.includes(file.id)}
                    isHighlighted={highlightedFileId === file.id}
                    t={t}
                    onSelect={handleFileSelect}
                    onDelete={(id) => setDeleteConfirm({ type: 'file', id })}
                    onDownload={handleDownload}
                    onPrint={setPrintFile}
                    onSlice={setSliceFile}
                    onOpenInSlicer={handleOpenInSlicer}
                    desktopSlicer={preferredSlicer}
                    onRunPipeline={setRunPipelineFile}
                    useSlicerApi={settings?.use_slicer_api ?? false}
                    canSlice={canSlice()}
                    onPreview={openPreview}
                    onOpenInCalculator={(f) => navigate(calculatorPrefillUrl(f, calcConfig, [f.sliced_for_model]))}
                    onRename={(f) => setRenameItem({ type: 'file', id: f.id, name: f.filename })}
                    onDetails={setDetailsFile}
                    onGenerateThumbnail={(f) => singleThumbnailMutation.mutate(f.id)}
                    onManageTags={(f) => setSingleTagFile(f)}
                    onTagClick={toggleTagFilter}
                    onHistory={setHistoryFile}
                    onMoveToProject={(f) => setMoveToProjectIds([f.id])} // Fenrir: projects PDM phase 5
                    thumbnailVersion={thumbnailVersions[file.id]}
                    calcConfig={calcConfig}
                    currencyCode={settings?.currency || 'USD'}
                    hasPermission={hasPermission}
                    canModify={canModify}
                    authEnabled={authEnabled}
                    showModified={showModified}
                  />
                  </div>
                ))}
              </div>
              {isFetchingNextPage && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4 mt-4" aria-hidden="true">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary animate-pulse">
                      <div className="aspect-square bg-bambu-dark rounded-t-lg" />
                      <div className="p-3 space-y-2">
                        <div className="h-3 rounded bg-bambu-dark-tertiary" />
                        <div className="h-3 w-1/2 rounded bg-bambu-dark-tertiary" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {isFetchNextPageError && (
                <div className="flex items-center justify-center gap-3 py-4 text-sm text-bambu-gray">
                  <span>{t('fileManager.loadMoreFailed')}</span>
                  <Button variant="secondary" size="sm" onClick={() => void fetchNextPage()}>
                    {t('common.retry')}
                  </Button>
                </div>
              )}
              {hasNextPage && <div ref={sentinelRef} className="h-px" aria-hidden="true" />}
            </div>
          ) : (
            <div className="flex-1 lg:overflow-y-auto">
              {/* The wrapper has overflow-x-auto so a narrow viewport scrolls
                  horizontally instead of clipping the actions column off the
                  right edge. The previous `overflow-hidden` was there for the
                  rounded corners but also swallowed any content the actions
                  column couldn't fit (#1325 follow-up reported in chat). */}
              <div className="bg-bambu-dark-secondary rounded-lg border border-bambu-dark-tertiary overflow-x-auto">
                {/* List header - hidden on mobile, show simplified on small screens.
                    Trailing actions column is fixed at 220px (sliced 3MF = 7 icons
                    ~220px). It used to be `min-content`, but header + body are sibling
                    grids that compute `min-content` independently — the header's empty
                    trailing div resolved to 0px, leaving body columns shifted left of
                    their headers. Fixed width keeps header and body in lockstep. */}
                <div
                  data-testid="file-list-grid-header"
                  className={`hidden sm:grid ${fileListGridColumns(authEnabled)} ${fileListGridMinWidth} gap-4 px-4 py-2 bg-bambu-dark-secondary border-b border-bambu-dark-tertiary text-xs text-bambu-gray font-medium`}
                >
                  <div className="w-6" />
                  <div>{t('common.name')}</div>
                  {authEnabled && <div>{t('fileManager.uploadedBy', { defaultValue: 'Uploaded By' })}</div>}
                  <div>{t('common.type')}</div>
                  <div>{t('fileManager.size')}</div>
                  <div>{t('fileManager.prints')}</div>
                  <div>{t('fileManager.tags.title')}</div>
                  <div />
                </div>
                {/* List rows */}
                {filteredAndSortedFiles.map((file) => (
                  <div
                    key={file.id}
                    data-testid="file-list-grid-row"
                    data-file-id={file.id}
                    style={highlightedFileId === file.id ? HIGHLIGHT_ROW_STYLE : undefined}
                    className={`grid ${fileListGridColumns(authEnabled)} ${fileListGridMinWidth} gap-4 px-4 py-3 items-center border-b border-bambu-dark-tertiary last:border-b-0 cursor-pointer hover:bg-bambu-dark/50 transition-colors ${
                      selectedFiles.includes(file.id) ? 'bg-bambu-green/10' : ''
                    }`}
                    onClick={() => handleFileSelect(file.id)}
                    // Double-click opens the preview (#2976), as in the grid.
                    onDoubleClick={() => openPreview(file)}
                  >
                    {/* Checkbox */}
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                      selectedFiles.includes(file.id)
                        ? 'bg-bambu-green border-bambu-green'
                        : 'border-bambu-gray/50'
                    }`}>
                      {selectedFiles.includes(file.id) && <div className="w-2 h-2 bg-white rounded-sm" />}
                    </div>
                    {/* Name with thumbnail */}
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="relative group/thumb">
                        <div className="w-10 h-10 rounded bg-bambu-dark flex-shrink-0 overflow-hidden">
                          {file.thumbnail_path ? (
                            <img
                              src={`${api.getLibraryFileThumbnailUrl(file.id, file.thumbnail_path)}${thumbnailVersions[file.id] ? ((api.getLibraryFileThumbnailUrl(file.id, file.thumbnail_path).includes('?') ? '&' : '?') + `v=${thumbnailVersions[file.id]}`) : ''}`}
                              loading="lazy"
                              alt=""
                              className="w-full h-full object-cover brightness-125 contrast-110"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <FileTypePlaceholderIcon fileType={file.file_type} className="w-5 h-5 text-bambu-gray/50" />
                            </div>
                          )}
                        </div>
                        {/* Hover preview */}
                        {file.thumbnail_path && (
                          <div className="absolute left-0 top-full mt-2 z-50 hidden group-hover/thumb:block">
                            <div className="w-48 h-48 rounded-lg bg-bambu-dark-secondary border border-bambu-dark-tertiary shadow-xl overflow-hidden">
                              <img
                                src={`${api.getLibraryFileThumbnailUrl(file.id, file.thumbnail_path)}${thumbnailVersions[file.id] ? ((api.getLibraryFileThumbnailUrl(file.id, file.thumbnail_path).includes('?') ? '&' : '?') + `v=${thumbnailVersions[file.id]}`) : ''}`}
                                loading="lazy"
                                alt={file.filename}
                                className="w-full h-full object-contain brightness-125 contrast-110"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-sm text-white truncate">{file.print_name || file.filename}</span>
                          {/* Metadata indicators (#3077), same set as the card. */}
                          {file.external_url && (
                            <a
                              href={file.external_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              {...stopRowActivation}
                              className="flex-shrink-0 text-bambu-gray hover:text-bambu-green"
                              title={t('fileManager.details.openLink')}
                              aria-label={t('fileManager.details.openLink')}
                            >
                              <Globe className="w-3.5 h-3.5" />
                            </a>
                          )}
                          {file.has_notes && (
                            <span className="flex-shrink-0 text-bambu-gray" title={t('fileManager.details.hasNotes')} aria-label={t('fileManager.details.hasNotes')}>
                              <StickyNote className="w-3.5 h-3.5" />
                            </span>
                          )}
                          {(file.photo_count ?? 0) > 0 && (
                            <span className="flex-shrink-0 flex items-center gap-0.5 text-xs text-bambu-gray" title={t('fileManager.details.photoCount', { count: file.photo_count })}>
                              <Camera className="w-3.5 h-3.5" />
                              {file.photo_count}
                            </span>
                          )}
                        </div>
                        {(file.filament_type || (file.filament_used_grams != null && file.filament_used_grams > 0)) && (
                          <div className="text-xs text-bambu-gray truncate flex items-center gap-1">
                            <Package className="w-3 h-3 flex-shrink-0" />
                            {file.filament_type && <span className="truncate" title={file.filament_type}>{file.filament_type}</span>}
                            {file.filament_type && file.filament_used_grams != null && file.filament_used_grams > 0 && (
                              <span className="text-bambu-gray/50">·</span>
                            )}
                            {file.filament_used_grams != null && file.filament_used_grams > 0 && (
                              <span>{file.filament_used_grams.toFixed(1)}g</span>
                            )}
                          </div>
                        )}
                        {/* #2680: last-modified date under the name, toggled from
                            the toolbar. Real on-disk mtime when known, else created_at. */}
                        {showModified && (
                          <div className="text-xs text-bambu-gray flex items-center gap-1 mt-0.5" title={t('fileManager.lastModified')}>
                            <CalendarClock className="w-3 h-3 flex-shrink-0" />
                            <span className="truncate">{formatDate(file.fs_modified_at ?? file.created_at)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    {/* Uploaded By - only show when auth is enabled */}
                    {authEnabled && (
                      <div className="text-sm text-bambu-gray flex items-center gap-1">
                        {file.created_by_username ? (
                          <>
                            <User className="w-3 h-3" />
                            <span className="truncate">{file.created_by_username}</span>
                          </>
                        ) : (
                          '-'
                        )}
                      </div>
                    )}
                    {/* Type */}
                    <div>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${fileTypeBadgeClass(file.file_type)}`}>
                        {file.file_type.toUpperCase()}
                      </span>
                    </div>
                    {/* Size */}
                    <div className="text-sm text-bambu-gray">{formatFileSize(file.file_size)}</div>
                    {/* Prints — clickable to open the file's history timeline
                        (the list-view icon strip is at capacity, so the count
                        itself is the entry point here). */}
                    <div className="text-sm text-bambu-gray" onClick={(e) => e.stopPropagation()}>
                      {file.print_count > 0 && hasPermission('library:read') ? (
                        <button
                          type="button"
                          onClick={() => setHistoryFile(file)}
                          className="text-bambu-green hover:underline"
                          aria-label={t('fileManager.fileHistory.viewHistoryAria')}
                          title={t('fileManager.fileHistory.viewHistoryAria')}
                        >
                          {file.print_count}x
                        </button>
                      ) : file.print_count > 0 ? (
                        `${file.print_count}x`
                      ) : (
                        '-'
                      )}
                    </div>
                    {/* Tags (#1268) — clickable chips push into the active
                        filter; minmax(96px,200px) on the column lets the cell
                        shrink/wrap on narrow viewports, and the 96px floor
                        keeps chips readable once the wrapper scrolls (#3105). */}
                    <div className="min-w-0" {...stopRowActivation}>
                      {!file.tags || file.tags.length === 0 ? (
                        <span className="text-xs text-bambu-gray/50">-</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {file.tags.map((tg) => (
                            <button
                              key={tg.id}
                              type="button"
                              onClick={() => toggleTagFilter(tg.id)}
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-bambu-green/10 text-bambu-green hover:bg-bambu-green/20 transition-colors max-w-full"
                              title={tg.name}
                            >
                              <TagIcon className="w-2.5 h-2.5 flex-shrink-0" />
                              <span className="truncate">{tg.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Actions */}
                    <FileActionStrip file={file} {...fileActionProps} />
                  </div>
                ))}
              </div>
              {isFetchingNextPage && (
                <div className="space-y-2 p-4" aria-hidden="true">
                  {Array.from({ length: 3 }, (_, i) => (
                    <div key={i} className="h-10 rounded bg-bambu-dark-tertiary animate-pulse" />
                  ))}
                </div>
              )}
              {isFetchNextPageError && (
                <div className="flex items-center justify-center gap-3 py-4 text-sm text-bambu-gray">
                  <span>{t('fileManager.loadMoreFailed')}</span>
                  <Button variant="secondary" size="sm" onClick={() => void fetchNextPage()}>
                    {t('common.retry')}
                  </Button>
                </div>
              )}
              {hasNextPage && <div ref={sentinelRef} className="h-px" aria-hidden="true" />}
            </div>
          )}
        </div>
          {/* README rail — collapsible right column on lg+, stacks on top
              on mobile. See the files-area wrapper comment above (#2520). */}
          {selectedFolderId !== null && <FolderReadmePanel folderId={selectedFolderId} />}
        </div>
      </div>

      {/* Modals */}
      {showNewFolderModal && (
        <NewFolderModal
          parentId={selectedFolderId}
          onClose={() => setShowNewFolderModal(false)}
          onSave={(data) => createFolderMutation.mutate(data)}
          isLoading={createFolderMutation.isPending}
          t={t}
        />
      )}

      {showExternalFolderModal && (
        <ExternalFolderModal
          onClose={() => setShowExternalFolderModal(false)}
          onSave={(data) => createExternalFolderMutation.mutate(data)}
          isLoading={createExternalFolderMutation.isPending}
          t={t}
        />
      )}

      {showMoveModal && folders && (
        <MoveFilesModal
          folders={folders}
          selectedFiles={selectedFiles}
          currentFolderId={selectedFolderId}
          onClose={() => setShowMoveModal(false)}
          onMove={(folderId) => moveFilesMutation.mutate({ fileIds: selectedFiles, folderId })}
          isLoading={moveFilesMutation.isPending}
          t={t}
        />
      )}

      {/* Fenrir: Move to project (projects PDM phase 5) */}
      {moveToProjectIds && (
        <MoveToProjectModal
          fileIds={moveToProjectIds}
          fileName={moveToProjectIds.length === 1 ? files.find((f) => f.id === moveToProjectIds[0])?.filename : undefined}
          onClose={() => setMoveToProjectIds(null)}
          onMoved={() => setSelectedFiles([])}
        />
      )}

      {moveFolder && folders && (
        <MoveFolderModal
          folders={folders}
          folder={moveFolder}
          onClose={() => setMoveFolder(null)}
          onMove={(parentId) => moveFolderMutation.mutate({ id: moveFolder.id, parentId })}
          isLoading={moveFolderMutation.isPending}
          t={t}
        />
      )}

      {showUploadModal && (
        <FileUploadModal
          folderId={selectedFolderId}
          onClose={() => {
            setShowUploadModal(false);
            setDroppedFiles([]);
          }}
          onUploadComplete={handleUploadComplete}
          onFileUploaded={handleFileUploaded} // Fenrir: projects PDM phase 5
          initialFiles={droppedFiles.length > 0 ? droppedFiles : undefined}
        />
      )}

      {showPurgeModal && (
        <PurgeOldFilesModal onClose={() => setShowPurgeModal(false)} />
      )}

      <LibraryTagsModal
        open={showTagsModal}
        onClose={() => setShowTagsModal(false)}
        onPickTag={(tagId) => {
          if (!selectedTagIds.includes(tagId)) {
            setSelectedTagIds((prev) => [...prev, tagId]);
          }
        }}
      />

      <BulkTagsPickerModal
        open={showBulkTagsModal}
        fileIds={selectedFiles}
        onClose={() => setShowBulkTagsModal(false)}
      />

      <BulkTagsPickerModal
        open={singleTagFile !== null}
        fileIds={singleTagFile !== null ? [singleTagFile.id] : []}
        initialTagIds={(singleTagFile?.tags ?? []).map((tg) => tg.id)}
        singleMode
        onClose={() => setSingleTagFile(null)}
      />

      {linkFolder && (
        <LinkFolderModal
          folder={linkFolder}
          onClose={() => setLinkFolder(null)}
          onLink={(data) => updateFolderMutation.mutate({ id: linkFolder.id, data })}
          isLoading={updateFolderMutation.isPending}
          t={t}
        />
      )}

      {deleteConfirm && (
        <ConfirmModal
          title={
            deleteConfirm.type === 'folder'
              ? t('fileManager.deleteFolder')
              : deleteConfirm.type === 'bulk'
              ? t('fileManager.deleteFilesCount', { count: deleteConfirm.count })
              : t('fileManager.deleteFile')
          }
          message={
            deleteConfirm.type === 'folder'
              ? t('fileManager.deleteFolderConfirm')
              : deleteConfirm.type === 'bulk'
              ? t('fileManager.deleteFilesConfirm', { count: deleteConfirm.count })
              : t('fileManager.deleteFileConfirm')
          }
          confirmText={t('common.delete')}
          variant="danger"
          isLoading={isDeleting}
          loadingText={t('fileManager.deleting')}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {/* Held back until the variant group has loaded. The modal reads its
          candidate list once, on mount, so opening before the group arrives
          would show a single-file print for a file that has alternatives. */}
      {printFile && (!printFile.variant_group_id || printFileGroup !== undefined) && (
        <PrintModal
          mode="create"
          libraryFileId={printVariantFiles?.[0]?.id ?? printFile.id}
          variantFiles={printVariantFiles}
          // A version group is by definition alternatives; only an explicit
          // selection (the same one printVariantFiles prefers) may mean separate
          // jobs (#3462).
          separateJobsAllowed={selectedSlicedFiles.length > 1 || resumeRun}
          resumeSeparateJobs={resumeRun ? separateJobsRun! : undefined}
          onSeparateJobsProgress={setSeparateJobsRun}
          // Naming a cross-model job after one of its files reads as though the
          // others aren't part of it.
          archiveName={
            printVariantFiles && printVariantFiles.length > 1
              ? `${printVariantFiles[0].filename} ${t('common.plusNMore', { count: printVariantFiles.length - 1 })}`
              : printFile.print_name || printFile.filename
          }
          onClose={() => {
            setPrintFile(null);
            // Closed after a refusal: what went in leaves the selection, and the
            // rest reopens as that run (see separateJobsRun).
            if (separateJobsRun) {
              const done = separateJobsRun.queuedFileIds;
              setSelectedFiles((prev) => prev.filter((id) => !done.includes(id)));
              queryClient.invalidateQueries({ queryKey: ['library-files'] });
              queryClient.invalidateQueries({ queryKey: ['queue'] });
            }
          }}
          onSuccess={() => {
            setPrintFile(null);
            setSeparateJobsRun(null);
            setSelectedFiles([]);
            queryClient.invalidateQueries({ queryKey: ['library-files'] });
            queryClient.invalidateQueries({ queryKey: ['queue'] });
            queryClient.invalidateQueries({ queryKey: ['archives'] });
          }}
        />
      )}

      {sliceFile && (
        <SliceModal
          source={{ kind: 'libraryFile', id: sliceFile.id, filename: sliceFile.filename }}
          onClose={() => setSliceFile(null)}
        />
      )}

      {showCombineModal && selectedStlFiles.length > 0 && (
        <CombineFilesModal
          files={selectedStlFiles}
          folderId={selectedFolderId}
          // canSlice() also covers the desktop-slicer handoff; "open the
          // slicer next" means the in-app SliceModal, so the sidecar must be on.
          canSlice={!!settings?.use_slicer_api && canSlice()}
          onClose={() => setShowCombineModal(false)}
          onCombined={(result, sliceNext) => {
            setShowCombineModal(false);
            setSelectedFiles([]);
            if (sliceNext) setSliceCombined({ id: result.id, filename: result.filename });
          }}
        />
      )}

      {sliceCombined && (
        <SliceModal
          source={{ kind: 'libraryFile', id: sliceCombined.id, filename: sliceCombined.filename }}
          onClose={() => setSliceCombined(null)}
          defaultAutoArrange
        />
      )}

      {runPipelineFile && (
        <RunWithPipelineModal
          source={{ kind: 'libraryFile', id: runPipelineFile.id, filename: runPipelineFile.filename }}
          onClose={() => setRunPipelineFile(null)}
        />
      )}

      {historyFile && (
        <FileHistoryModal
          fileId={historyFile.id}
          filename={historyFile.filename}
          onClose={() => setHistoryFile(null)}
        />
      )}

      {viewerFile && (
        <PartViewerModal
          subject={{ kind: 'library', fileId: viewerFile.id, fileType: viewerFile.file_type, filename: viewerFile.filename, nozzleDiameter: viewerFile.nozzle_diameter }}
          title={viewerFile.print_name || viewerFile.filename}
          onClose={() => setViewerFile(null)}
          printed={viewerFile.print_count}
          // STEP has no server-side renderer; persist the first client render
          // as the grid thumbnail (#2976).
          onSnapshot={isStepType(viewerFile.file_type) ? previewSnapshotHandler(viewerFile) : undefined}
          
          onSliceWithFenrir={
            // Only offer in-app slicing on files the SliceModal can actually
            // handle (matches the file-row Cog visibility check at :2127).
            isSliceableLibraryFile(viewerFile, true, preferredSlicer) && hasPermission('library:upload')
              ? () => {
                  const f = viewerFile;
                  setViewerFile(null);
                  setSliceFile(f);
                }
              : undefined
          }
        />
      )}

      {(pdfPreviewFile || sheetPreviewFile || imagePreviewFile) && (
        <Suspense fallback={null}>
          {pdfPreviewFile && (
            <PdfPreviewModal
              libraryFileId={pdfPreviewFile.id}
              filename={pdfPreviewFile.print_name || pdfPreviewFile.filename}
              fileSize={pdfPreviewFile.file_size}
              onClose={() => setPdfPreviewFile(null)}
              onSnapshot={previewSnapshotHandler(pdfPreviewFile)}
            />
          )}
          {sheetPreviewFile && (
            <SpreadsheetPreviewModal
              libraryFileId={sheetPreviewFile.id}
              filename={sheetPreviewFile.print_name || sheetPreviewFile.filename}
              fileType={sheetPreviewFile.file_type}
              fileSize={sheetPreviewFile.file_size}
              onClose={() => setSheetPreviewFile(null)}
              onSnapshot={previewSnapshotHandler(sheetPreviewFile)}
            />
          )}
          {imagePreviewFile && (
            <ImagePreviewModal
              libraryFileId={imagePreviewFile.id}
              filename={imagePreviewFile.print_name || imagePreviewFile.filename}
              fileSize={imagePreviewFile.file_size}
              onClose={() => setImagePreviewFile(null)}
            />
          )}
        </Suspense>
      )}

      {detailsFile && (
        <LibraryFileDetailsModal
          file={detailsFile}
          canEdit={canModify('library', 'update', detailsFile.created_by_id)}
          onClose={() => setDetailsFile(null)}
        />
      )}

      {renameItem && (
        <RenameModal
          type={renameItem.type}
          currentName={renameItem.name}
          onClose={() => setRenameItem(null)}
          onSave={(newName) => {
            if (renameItem.type === 'file') {
              renameFileMutation.mutate({ id: renameItem.id, filename: newName });
            } else {
              renameFolderMutation.mutate({ id: renameItem.id, name: newName });
            }
          }}
          isLoading={renameFileMutation.isPending || renameFolderMutation.isPending}
          t={t}
        />
      )}
    </div>
  );
}
