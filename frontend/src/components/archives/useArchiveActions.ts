import { useState, useRef } from 'react';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Archive } from '../../api/client';
import type { PlateMetadata } from '../../types/plates';
import { invalidateArchiveAndProjectViews } from '../../utils/projectQueries';
import { verdictSourceKey } from '../../utils/verdictSource';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import { isSlicedFile } from './archiveFileUtils';

export type ArchiveTFunction = (key: string, options?: Record<string, unknown>) => string;

/**
 * State, mutations and handlers shared by the archive grid card and the
 * archive list row: modal toggles, the per-archive file/timelapse/project
 * mutations, and the context-menu position.
 */
export function useArchiveActions(archive: Archive, t: ArchiveTFunction) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission, canModify } = useAuth();
  const navigate = useNavigate();
  const [showReprint, setShowReprint] = useState(false);
  // Post-print outcome confirmation dialog (#1898)
  const [showConfirmOutcome, setShowConfirmOutcome] = useState(false);
  const [showSliceModal, setShowSliceModal] = useState(false);
  const [showRunPipeline, setShowRunPipeline] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // #1343: when true, the delete also drops the row from Quick Stats. Default
  // off — soft delete preserves the archive's filament/time/cost contribution.
  const [deletePurgeStats, setDeletePurgeStats] = useState(false);
  // #1734: pre-flight count of related queue items so the confirm modal can
  // tell the user how many will be removed and disable the button if any are
  // currently printing (the server 409s in that case).
  const deleteImpactQuery = useQuery({
    queryKey: ['archive', archive.id, 'delete-impact'],
    queryFn: () => api.getArchiveDeleteImpact(archive.id),
    enabled: showDeleteConfirm,
    staleTime: 0,
  });
  const [showEdit, setShowEdit] = useState(false);
  const [showPrintLog, setShowPrintLog] = useState(false);
  const [showTimelapse, setShowTimelapse] = useState(false);
  const [showPrinterMedia, setShowPrinterMedia] = useState(false);
  const [showTimelapseSelect, setShowTimelapseSelect] = useState(false);
  const [availableTimelapses, setAvailableTimelapses] = useState<Array<{ name: string; path: string; size: number; mtime: string | null }>>([]);
  const [showQRCode, setShowQRCode] = useState(false);
  const [showPhotos, setShowPhotos] = useState(false);
  const [showProjectPage, setShowProjectPage] = useState(false);
  const [showDeleteSource3mfConfirm, setShowDeleteSource3mfConfirm] = useState(false);
  const [showDeleteF3dConfirm, setShowDeleteF3dConfirm] = useState(false);
  const [showDeleteTimelapseConfirm, setShowDeleteTimelapseConfirm] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [platePickerPlates, setPlatePickerPlates] = useState<PlateMetadata[] | null>(null);
  const source3mfInputRef = useRef<HTMLInputElement>(null);
  const f3dInputRef = useRef<HTMLInputElement>(null);
  const timelapseInputRef = useRef<HTMLInputElement>(null);

  // Use pre-computed duplicate sequence and original archive ID from list response
  const duplicateSequence = archive.duplicate_sequence ?? 0;
  // Appended to the verdict badge's tooltip (#1898) so a verdict the
  // plate-clear default recorded can be explained where it is shown.
  const verdictSourceHintKey = verdictSourceKey(archive.user_verdict_source);
  const originalArchiveId = archive.original_archive_id ?? null;

  const timelapseDeleteMutation = useMutation({
    mutationFn: () => api.deleteArchiveTimelapse(archive.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.timelapseRemoved'));
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedRemoveTimelapse'), 'error');
    },
  });

  const timelapseUploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadArchiveTimelapse(archive.id, file),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.timelapseUploaded', { filename: data.filename }));
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedUploadTimelapse'), 'error');
    },
  });

  const source3mfUploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadSource3mf(archive.id, file),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.source3mfAttached', { filename: data.filename }));
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedUploadSource3mf'), 'error');
    },
  });

  const source3mfDeleteMutation = useMutation({
    mutationFn: () => api.deleteSource3mf(archive.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.source3mfRemoved'));
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedRemoveSource3mf'), 'error');
    },
  });

  const f3dUploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadF3d(archive.id, file),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.f3dAttached', { filename: data.filename }));
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedUploadF3d'), 'error');
    },
  });

  const f3dDeleteMutation = useMutation({
    mutationFn: () => api.deleteF3d(archive.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.f3dRemoved'));
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedRemoveF3d'), 'error');
    },
  });

  const timelapseScanMutation = useMutation({
    mutationFn: () => api.scanArchiveTimelapse(archive.id),
    onSuccess: (data) => {
      if (data.status === 'attached') {
        queryClient.invalidateQueries({ queryKey: ['archives'] });
        showToast(t('archives.toast.timelapseAttached', { filename: data.filename }));
      } else if (data.status === 'exists') {
        showToast(t('archives.toast.timelapseAlreadyAttached'));
      } else if (data.status === 'not_found' && data.available_files && data.available_files.length > 0) {
        // Show selection dialog
        setAvailableTimelapses(data.available_files);
        setShowTimelapseSelect(true);
      } else {
        showToast(data.message || t('archives.toast.noMatchingTimelapse'), 'warning');
      }
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedScanTimelapse'), 'error');
    },
  });

  const timelapseSelectMutation = useMutation({
    mutationFn: (filename: string) => api.selectArchiveTimelapse(archive.id, filename),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.timelapseAttached', { filename: data.filename }));
      setShowTimelapseSelect(false);
      setAvailableTimelapses([]);
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedAttachTimelapse'), 'error');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (purgeStats: boolean) => api.deleteArchive(archive.id, purgeStats),
    onSuccess: () => {
      // A deleted archive leaves its project too, so the project views have to
      // be refreshed alongside the archive list (#2731).
      invalidateArchiveAndProjectViews(queryClient);
      showToast(t('archives.toast.archiveDeleted'));
    },
    onError: () => {
      showToast(t('archives.toast.failedDeleteArchive'), 'error');
    },
  });

  const favoriteMutation = useMutation({
    mutationFn: () => api.toggleFavorite(archive.id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(data.is_favorite ? t('archives.toast.addedToFavorites') : t('archives.toast.removedFromFavorites'));
    },
  });

  // The linked folder comes with the list row: fetching it per card cost one
  // request per archive on every page view.
  const linkedFolders = archive.linked_folder ? [archive.linked_folder] : [];

  const assignProjectMutation = useMutation({
    mutationFn: (projectId: number | null) => api.updateArchive(archive.id, { project_id: projectId }),
    onSuccess: () => {
      invalidateArchiveAndProjectViews(queryClient);
      showToast(t('archives.toast.projectUpdated'));
    },
    onError: () => {
      showToast(t('archives.toast.failedUpdateProject'), 'error');
    },
  });

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const isGcodeFile = isSlicedFile(archive);

  return {
    queryClient,
    showToast,
    hasPermission,
    canModify,
    navigate,
    showReprint,
    setShowReprint,
    showConfirmOutcome,
    setShowConfirmOutcome,
    showSliceModal,
    setShowSliceModal,
    showRunPipeline,
    setShowRunPipeline,
    showDeleteConfirm,
    setShowDeleteConfirm,
    deletePurgeStats,
    setDeletePurgeStats,
    deleteImpactQuery,
    showEdit,
    setShowEdit,
    showPrintLog,
    setShowPrintLog,
    showTimelapse,
    setShowTimelapse,
    showPrinterMedia,
    setShowPrinterMedia,
    showTimelapseSelect,
    setShowTimelapseSelect,
    availableTimelapses,
    setAvailableTimelapses,
    showQRCode,
    setShowQRCode,
    showPhotos,
    setShowPhotos,
    showProjectPage,
    setShowProjectPage,
    showDeleteSource3mfConfirm,
    setShowDeleteSource3mfConfirm,
    showDeleteF3dConfirm,
    setShowDeleteF3dConfirm,
    showDeleteTimelapseConfirm,
    setShowDeleteTimelapseConfirm,
    contextMenu,
    setContextMenu,
    platePickerPlates,
    setPlatePickerPlates,
    source3mfInputRef,
    f3dInputRef,
    timelapseInputRef,
    duplicateSequence,
    verdictSourceHintKey,
    originalArchiveId,
    timelapseDeleteMutation,
    timelapseUploadMutation,
    source3mfUploadMutation,
    source3mfDeleteMutation,
    f3dUploadMutation,
    f3dDeleteMutation,
    timelapseScanMutation,
    timelapseSelectMutation,
    deleteMutation,
    favoriteMutation,
    linkedFolders,
    assignProjectMutation,
    handleContextMenu,
    isGcodeFile,
  };
}

export type ArchiveActions = ReturnType<typeof useArchiveActions>;
