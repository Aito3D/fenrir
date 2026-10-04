import {
  Download,
  Trash2,
  Calculator,
  Box,
  Printer,
  Upload,
  ExternalLink,
  CheckSquare,
  Square,
  Globe,
  Pencil,
  Star,
  Copy,
  Film,
  ScanSearch,
  QrCode,
  Camera,
  FileText,
  FileCode,
  FolderKanban,
  Play,
  Cog,
  History,
  ThumbsUp,
  ThumbsDown,
} from 'lucide-react';
import { api } from '../../api/client';
import type { Archive } from '../../api/client';
import type { ContextMenuItem } from '../ContextMenu';
import type { SlicerType } from '../../utils/slicer';
import { calculatorPrefillUrl, type CalcConfig } from '../../utils/archivePricing';
import { openSafeExternalUrl } from '../../utils/safeExternalUrl';
import { openInSlicerWithToken } from './archiveFileUtils';
import type { ArchiveActions, ArchiveTFunction } from './useArchiveActions';

export interface ArchiveMenuParams {
  archive: Archive;
  t: ArchiveTFunction;
  actions: ArchiveActions;
  preferredSlicer: SlicerType;
  useSlicerApi: boolean;
  openGcodeViewer: () => Promise<void>;
  calcConfig?: CalcConfig | null;
  printerName: string;
  isSelected: boolean;
  onSelect: (id: number) => void;
}

/**
 * Context-menu items the archive grid card and list row share verbatim,
 * split into the runs that sit between their view-specific items:
 * - `head`: print/slice actions through "View timelapse"
 * - `body`: timelapse scan/upload through "Go to project"
 * - `tail`: "Open in calculator" through "Delete"
 */
export function buildArchiveMenuSections({
  archive,
  t,
  actions,
  preferredSlicer,
  useSlicerApi,
  openGcodeViewer,
  calcConfig,
  printerName,
  isSelected,
  onSelect,
}: ArchiveMenuParams): { head: ContextMenuItem[]; body: ContextMenuItem[]; tail: ContextMenuItem[] } {
  const {
    hasPermission,
    canModify,
    showToast,
    navigate,
    isGcodeFile,
    setShowReprint,
    setShowSliceModal,
    setShowRunPipeline,
    setShowConfirmOutcome,
    setShowTimelapse,
    timelapseScanMutation,
    timelapseInputRef,
    setShowDeleteTimelapseConfirm,
    source3mfInputRef,
    setShowDeleteSource3mfConfirm,
    f3dInputRef,
    setShowDeleteF3dConfirm,
    setShowQRCode,
    setShowPhotos,
    setShowProjectPage,
    favoriteMutation,
    setShowEdit,
    setShowPrintLog,
    setShowDeleteConfirm,
  } = actions;

  const head: ContextMenuItem[] = [
    // For gcode files: show Print option
    // For source files: show Slice as the primary action
    ...(isGcodeFile ? [
      {
        label: t('common.print'),
        icon: <Printer className="w-4 h-4" />,
        onClick: () => setShowReprint(true),
        disabled: !archive.file_path || !hasPermission('queue:create') || !canModify('archives', 'reprint', archive.created_by_id),
        title: !archive.file_path
          ? t('archives.card.noFileForReprint')
          : !hasPermission('queue:create')
            ? t('archives.permission.noAddToQueue')
            : !canModify('archives', 'reprint', archive.created_by_id)
              ? t('archives.permission.noReprint')
              : undefined,
      },
      {
        label: t('archives.menu.openInBambuStudio'),
        icon: <ExternalLink className="w-4 h-4" />,
        onClick: () => {
          const filename = archive.print_name || archive.filename || 'model';
          openInSlicerWithToken(archive.id, filename, 'file', preferredSlicer);
        },
        disabled: !archive.file_path,
        title: !archive.file_path ? t('archives.card.noFileForReprint') : undefined,
      },
    ] : [
      {
        label: t('archives.menu.slice'),
        icon: useSlicerApi ? <Cog className="w-4 h-4" /> : <ExternalLink className="w-4 h-4" />,
        onClick: () => {
          if (useSlicerApi) {
            setShowSliceModal(true);
          } else {
            const filename = archive.print_name || archive.filename || 'model';
            openInSlicerWithToken(archive.id, filename, 'file', preferredSlicer);
          }
        },
      },
      // Run-with-pipeline (#1425 PR B follow-up). Sources from archive's
      // source 3MF (or file_path fallback). Only when slicer-api is on.
      ...(useSlicerApi
        ? [{
            label: t('library.runWithPipeline.actionLabel'),
            icon: <Play className="w-4 h-4" />,
            onClick: () => setShowRunPipeline(true),
            disabled: !hasPermission('pipelines:run'),
            title: !hasPermission('pipelines:run')
              ? t('library.runWithPipeline.noPermission')
              : undefined,
          }]
        : []),
    ]),
    {
      label: archive.external_url ? t('archives.menu.externalLink') : t('archives.menu.viewOnMakerWorld'),
      icon: <Globe className="w-4 h-4" />,
      onClick: () => {
        openSafeExternalUrl(archive.external_url || archive.makerworld_url);
      },
      disabled: !archive.external_url && !archive.makerworld_url,
    },
    // Post-print outcome confirmation (#1898): completed prints only — the
    // machine statuses already cover everything else.
    ...(archive.status === 'completed'
      ? [{
          label: t('archives.menu.confirmOutcome'),
          icon: archive.user_verdict === 'reject'
            ? <ThumbsDown className="w-4 h-4" />
            : <ThumbsUp className="w-4 h-4" />,
          onClick: () => setShowConfirmOutcome(true),
          disabled: !canModify('archives', 'update', archive.created_by_id),
          title: !canModify('archives', 'update', archive.created_by_id)
            ? t('archives.permission.noUpdateArchives')
            : undefined,
        }]
      : []),
    { label: '', divider: true, onClick: () => {} },
    {
      label: t('archives.menu.preview3d'),
      icon: <Box className="w-4 h-4" />,
      onClick: () => { openGcodeViewer(); },
    },
    {
      label: t('archives.menu.viewTimelapse'),
      icon: <Film className="w-4 h-4" />,
      onClick: () => setShowTimelapse(true),
      disabled: !archive.timelapse_path,
    },
  ];

  const body: ContextMenuItem[] = [
    {
      label: t('archives.menu.scanForTimelapse'),
      icon: <ScanSearch className="w-4 h-4" />,
      onClick: () => timelapseScanMutation.mutate(),
      disabled: !archive.printer_id || !!archive.timelapse_path || timelapseScanMutation.isPending || !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    },
    {
      label: t('archives.menu.uploadTimelapse'),
      icon: <Upload className="w-4 h-4" />,
      onClick: () => timelapseInputRef.current?.click(),
      disabled: !!archive.timelapse_path || !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    },
    ...(archive.timelapse_path ? [{
      label: t('archives.menu.removeTimelapse'),
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => setShowDeleteTimelapseConfirm(true),
      danger: true,
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    }] : []),
    { label: '', divider: true, onClick: () => {} },
    {
      label: archive.source_3mf_path ? t('archives.menu.downloadSource3mf') : t('archives.menu.uploadSource3mf'),
      icon: <FileCode className="w-4 h-4" />,
      onClick: () => {
        if (archive.source_3mf_path) {
          api.downloadSource3mf(archive.id).catch((err) => {
            console.error('Source 3MF download failed:', err);
          });
        } else {
          source3mfInputRef.current?.click();
        }
      },
      disabled: !archive.source_3mf_path && !canModify('archives', 'update', archive.created_by_id),
      title: !archive.source_3mf_path && !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUploadFiles') : undefined,
    },
    ...(archive.source_3mf_path ? [{
      label: t('archives.menu.replaceSource3mf'),
      icon: <Upload className="w-4 h-4" />,
      onClick: () => source3mfInputRef.current?.click(),
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    },
    {
      label: t('archives.menu.removeSource3mf'),
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => setShowDeleteSource3mfConfirm(true),
      danger: true,
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    }] : []),
    {
      label: archive.f3d_path ? t('archives.menu.replaceF3d') : t('archives.menu.uploadF3d'),
      icon: <Box className="w-4 h-4" />,
      onClick: () => f3dInputRef.current?.click(),
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    },
    ...(archive.f3d_path ? [{
      label: t('archives.menu.downloadF3d'),
      icon: <Download className="w-4 h-4" />,
      onClick: () => {
        api.downloadF3d(archive.id).catch((err) => {
          console.error('F3D download failed:', err);
        });
      },
    },
    {
      label: t('archives.menu.removeF3d'),
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => setShowDeleteF3dConfirm(true),
      danger: true,
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    }] : []),
    { label: '', divider: true, onClick: () => {} },
    {
      label: t('archives.menu.download'),
      icon: <Download className="w-4 h-4" />,
      onClick: () => {
        api.downloadArchive(archive.id, `${archive.print_name || archive.filename}.3mf`).catch((err) => {
          console.error('Archive download failed:', err);
        });
      },
      disabled: !hasPermission('archives:read'),
      title: !hasPermission('archives:read') ? t('archives.permission.noDownload') : undefined,
    },
    {
      label: t('archives.menu.copyDownloadLink'),
      icon: <Copy className="w-4 h-4" />,
      onClick: () => {
        const url = `${window.location.origin}${api.getArchiveDownload(archive.id)}`;
        navigator.clipboard.writeText(url).then(() => {
          showToast(t('archives.toast.linkCopied'));
        }).catch(() => {
          showToast(t('archives.toast.failedCopyLink'), 'error');
        });
      },
      disabled: !hasPermission('archives:read'),
      title: !hasPermission('archives:read') ? t('archives.permission.noCopyLink') : undefined,
    },
    {
      label: t('archives.menu.qrCode'),
      icon: <QrCode className="w-4 h-4" />,
      onClick: () => setShowQRCode(true),
    },
    {
      label: archive.photos?.length ? t('archives.menu.viewPhotosCount', { count: archive.photos.length }) : t('archives.menu.viewPhotos'),
      icon: <Camera className="w-4 h-4" />,
      onClick: () => setShowPhotos(true),
      disabled: !archive.photos?.length,
    },
    {
      label: t('archives.menu.projectPage'),
      icon: <FileText className="w-4 h-4" />,
      onClick: () => setShowProjectPage(true),
    },
    { label: '', divider: true, onClick: () => {} },
    {
      label: archive.is_favorite ? t('archives.menu.removeFromFavorites') : t('archives.menu.addToFavorites'),
      // Preview the favourited state on hover so the row reads as clickable (#2791).
      icon: <Star className={`w-4 h-4 ${archive.is_favorite ? 'fill-yellow-400 text-yellow-400' : canModify('archives', 'update', archive.created_by_id) ? 'group-hover:text-yellow-400' : ''}`} />,
      onClick: () => favoriteMutation.mutate(),
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    },
    {
      label: t('archives.menu.edit'),
      icon: <Pencil className="w-4 h-4" />,
      onClick: () => setShowEdit(true),
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    },
    {
      label: t('archives.menu.printLog'),
      icon: <History className="w-4 h-4" />,
      onClick: () => setShowPrintLog(true),
    },
    ...(archive.project_id && archive.project_name ? [{
      label: t('archives.menu.goToProject', { name: archive.project_name }),
      icon: <FolderKanban className="w-4 h-4 text-bambu-green" />,
      onClick: () => window.location.href = '/projects',
    }] : []),
  ];

  const tail: ContextMenuItem[] = [
    {
      label: t('archives.menu.openInCalculator'),
      icon: <Calculator className="w-4 h-4" />,
      onClick: () => navigate(calculatorPrefillUrl(archive, calcConfig ?? null, [printerName, archive.sliced_for_model])),
      disabled:
        !hasPermission('calculator:read') ||
        !archive.filament_used_grams ||
        !(archive.actual_time_seconds || archive.print_time_seconds),
    },
    {
      label: isSelected ? t('archives.menu.deselect') : t('archives.menu.select'),
      icon: isSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />,
      onClick: () => onSelect(archive.id),
    },
    { label: '', divider: true, onClick: () => {} },
    {
      label: t('archives.menu.delete'),
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => setShowDeleteConfirm(true),
      danger: true,
      disabled: !canModify('archives', 'delete', archive.created_by_id),
      title: !canModify('archives', 'delete', archive.created_by_id) ? t('archives.permission.noDelete') : undefined,
    },
  ];

  return { head, body, tail };
}
