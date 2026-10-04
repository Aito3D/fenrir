import type { ReactNode } from 'react';
import { api } from '../../api/client';
import type { Archive } from '../../api/client';
import { SliceModal } from '../SliceModal';
import { RunWithPipelineModal } from '../RunWithPipelineModal';
import { PrintModal } from '../PrintModal';
import { ConfirmOutcomeDialog } from '../ConfirmOutcomeDialog';
import { ConfirmModal } from '../ConfirmModal';
import { EditArchiveModal } from '../EditArchiveModal';
import { PrintLogModal } from '../PrintLogModal';
import { ContextMenu, type ContextMenuItem } from '../ContextMenu';
import { QRCodeModal } from '../QRCodeModal';
import { PhotoGalleryModal } from '../PhotoGalleryModal';
import { ProjectPageModal } from '../ProjectPageModal';
import { TimelapseViewer } from '../TimelapseViewer';
import { ArchiveMediaDownloadModal } from '../ArchiveMediaDownloadModal';
import { PlatePickerModal } from '../PlatePickerModal';
import type { ArchiveActions, ArchiveTFunction } from './useArchiveActions';

/**
 * The modals, context menu and hidden upload inputs the archive grid card and
 * list row both render after their own layout. The timelapse picker differs
 * between the two views, so each passes its own in `timelapseSelectModal`.
 */
export function ArchiveModals({
  archive,
  t,
  actions,
  printerName,
  contextMenuItems,
  timelapseSelectModal,
  photosRequireNonEmpty,
}: {
  archive: Archive;
  t: ArchiveTFunction;
  actions: ArchiveActions;
  printerName: string;
  contextMenuItems: ContextMenuItem[];
  /** Rendered between the timelapse viewer and the QR code modal. */
  timelapseSelectModal: ReactNode;
  /** The card hides the photo gallery for an empty photo list; the row only checks the list exists. */
  photosRequireNonEmpty: boolean;
}) {
  const {
    queryClient,
    showToast,
    navigate,
    showEdit,
    setShowEdit,
    showPrintLog,
    setShowPrintLog,
    platePickerPlates,
    setPlatePickerPlates,
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
    deleteImpactQuery,
    deleteMutation,
    deletePurgeStats,
    setDeletePurgeStats,
    showDeleteSource3mfConfirm,
    setShowDeleteSource3mfConfirm,
    source3mfDeleteMutation,
    showDeleteF3dConfirm,
    setShowDeleteF3dConfirm,
    f3dDeleteMutation,
    showDeleteTimelapseConfirm,
    setShowDeleteTimelapseConfirm,
    timelapseDeleteMutation,
    contextMenu,
    setContextMenu,
    showPrinterMedia,
    setShowPrinterMedia,
    showTimelapse,
    setShowTimelapse,
    showQRCode,
    setShowQRCode,
    showPhotos,
    setShowPhotos,
    showProjectPage,
    setShowProjectPage,
    source3mfInputRef,
    source3mfUploadMutation,
    f3dInputRef,
    f3dUploadMutation,
    timelapseInputRef,
    timelapseUploadMutation,
  } = actions;

  return (
    <>

      {/* Edit Modal */}
      {showEdit && (
        <EditArchiveModal
          archive={archive}
          onClose={() => setShowEdit(false)}
        />
      )}

      {/* Print Log Modal — opened from the "N prints" badge or context menu (#1378) */}
      {showPrintLog && (
        <PrintLogModal
          archiveId={archive.id}
          archiveName={archive.print_name || archive.filename}
          onClose={() => setShowPrintLog(false)}
        />
      )}

      {/* Plate picker — shown only for multi-plate archives on 3D Preview click */}
      {platePickerPlates && (
        <PlatePickerModal
          plates={platePickerPlates}
          onSelect={(plateIndex) => {
            setPlatePickerPlates(null);
            navigate(`/gcode-viewer?archive=${archive.id}&plate=${plateIndex}`);
          }}
          onClose={() => setPlatePickerPlates(null)}
        />
      )}

      {/* Reprint Modal */}
      {showReprint && (
        <PrintModal
          mode="create"
          archiveId={archive.id}
          archiveName={archive.print_name || archive.filename}
          onClose={() => setShowReprint(false)}
        />
      )}

      {/* Post-print outcome confirmation (#1898) */}
      {showConfirmOutcome && (
        <ConfirmOutcomeDialog
          archiveId={archive.id}
          onClose={() => setShowConfirmOutcome(false)}
        />
      )}

      {/* Slice Modal */}
      {showSliceModal && (
        <SliceModal
          source={{ kind: 'archive', id: archive.id, filename: archive.print_name || archive.filename || 'model' }}
          onClose={() => setShowSliceModal(false)}
        />
      )}

      {/* Run-with-Pipeline Modal (#1425 PR B). Sources from archive — backend
          reads source_3mf_path, falls back to file_path. */}
      {showRunPipeline && (
        <RunWithPipelineModal
          source={{ kind: 'archive', id: archive.id, filename: archive.print_name || archive.filename || 'model' }}
          onClose={() => setShowRunPipeline(false)}
        />
      )}

      {/* Delete Confirmation */}
      {showDeleteConfirm && (
        <ConfirmModal
          title={t('archives.modal.deleteArchive')}
          message={t('archives.modal.deleteConfirm', { name: archive.print_name || archive.filename })}
          confirmText={t('archives.modal.deleteButton')}
          variant="danger"
          confirmDisabled={(deleteImpactQuery.data?.currently_printing ?? 0) > 0}
          onConfirm={() => {
            deleteMutation.mutate(deletePurgeStats);
            setShowDeleteConfirm(false);
            setDeletePurgeStats(false);
          }}
          onCancel={() => {
            setShowDeleteConfirm(false);
            setDeletePurgeStats(false);
          }}
        >
          {/* #1734: warn the user when related queue items will also be removed,
              and block the action entirely if any are currently printing. */}
          {(deleteImpactQuery.data?.related_queue_items ?? 0) > 0 && (
            <div
              className={
                (deleteImpactQuery.data?.currently_printing ?? 0) > 0
                  ? 'text-sm text-red-600 dark:text-red-400 mb-2'
                  : 'text-sm text-amber-600 dark:text-amber-400 mb-2'
              }
            >
              {(deleteImpactQuery.data?.currently_printing ?? 0) > 0
                ? t('archives.modal.deleteBlockedByPrinting', {
                    count: deleteImpactQuery.data!.currently_printing,
                  })
                : t('archives.modal.deleteQueueItemsWarning', {
                    count: deleteImpactQuery.data!.related_queue_items,
                  })}
            </div>
          )}
          {/* #1343: opt-in checkbox — by default the archive is soft-deleted,
              so its filament / time / cost contribution stays in Quick Stats. */}
          <label className="flex items-start gap-2 cursor-pointer text-sm text-bambu-gray">
            <input
              type="checkbox"
              className="mt-0.5 accent-red-500"
              checked={deletePurgeStats}
              onChange={(e) => setDeletePurgeStats(e.target.checked)}
            />
            <span>{t('archives.modal.deletePurgeStats')}</span>
          </label>
        </ConfirmModal>
      )}

      {/* Delete Source 3MF Confirmation */}
      {showDeleteSource3mfConfirm && (
        <ConfirmModal
          title={t('archives.modal.removeSource3mf')}
          message={t('archives.modal.removeSource3mfConfirm', { name: archive.print_name || archive.filename })}
          confirmText={t('archives.modal.removeButton')}
          variant="danger"
          onConfirm={() => {
            source3mfDeleteMutation.mutate();
            setShowDeleteSource3mfConfirm(false);
          }}
          onCancel={() => setShowDeleteSource3mfConfirm(false)}
        />
      )}

      {/* Delete F3D Confirmation */}
      {showDeleteF3dConfirm && (
        <ConfirmModal
          title={t('archives.modal.removeF3d')}
          message={t('archives.modal.removeF3dConfirm', { name: archive.print_name || archive.filename })}
          confirmText={t('archives.modal.removeButton')}
          variant="danger"
          onConfirm={() => {
            f3dDeleteMutation.mutate();
            setShowDeleteF3dConfirm(false);
          }}
          onCancel={() => setShowDeleteF3dConfirm(false)}
        />
      )}

      {/* Delete Timelapse Confirmation */}
      {showDeleteTimelapseConfirm && (
        <ConfirmModal
          title={t('archives.modal.removeTimelapse')}
          message={t('archives.modal.removeTimelapseConfirm', { name: archive.print_name || archive.filename })}
          confirmText={t('archives.modal.removeButton')}
          variant="danger"
          onConfirm={() => {
            timelapseDeleteMutation.mutate();
            setShowDeleteTimelapseConfirm(false);
          }}
          onCancel={() => setShowDeleteTimelapseConfirm(false)}
        />
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Print Media Download Modal */}
      {showPrinterMedia && (
        <ArchiveMediaDownloadModal
          archiveId={archive.id}
          archiveName={archive.print_name || archive.filename}
          printerName={printerName}
          onClose={() => setShowPrinterMedia(false)}
        />
      )}

      {/* Timelapse Viewer Modal */}
      {showTimelapse && archive.timelapse_path && (
        <TimelapseViewer
          src={api.getArchiveTimelapse(archive.id)}
          title={t('archives.modal.timelapse', { name: archive.print_name || archive.filename })}
          downloadFilename={`${archive.print_name || archive.filename}_timelapse.mp4`}
          archiveId={archive.id}
          onClose={() => setShowTimelapse(false)}
          onEdit={() => {
            queryClient.invalidateQueries({ queryKey: ['archives'] });
            setShowTimelapse(false);  // Close viewer to reload fresh video
          }}
        />
      )}

      {timelapseSelectModal}

      {/* QR Code Modal */}
      {showQRCode && (
        <QRCodeModal
          archiveId={archive.id}
          archiveName={archive.print_name || archive.filename}
          onClose={() => setShowQRCode(false)}
        />
      )}

      {/* Photo Gallery Modal */}
      {showPhotos && archive.photos && (!photosRequireNonEmpty || archive.photos.length > 0) && (
        <PhotoGalleryModal
          archiveId={archive.id}
          archiveName={archive.print_name || archive.filename}
          photos={archive.photos}
          onClose={() => setShowPhotos(false)}
          onDelete={async (filename) => {
            try {
              await api.deleteArchivePhoto(archive.id, filename);
              queryClient.invalidateQueries({ queryKey: ['archives'] });
              showToast(t('archives.toast.photoDeleted'));
            } catch {
              showToast(t('archives.toast.failedDeletePhoto'), 'error');
            }
          }}
        />
      )}

      {/* Project Page Modal */}
      {showProjectPage && (
        <ProjectPageModal
          archiveId={archive.id}
          archiveName={archive.print_name || archive.filename}
          onClose={() => setShowProjectPage(false)}
        />
      )}

      {/* Hidden file input for source 3MF upload */}
      <input
        ref={source3mfInputRef}
        type="file"
        accept=".3mf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            source3mfUploadMutation.mutate(file);
          }
          e.target.value = '';
        }}
      />
      {/* Hidden file input for F3D upload */}
      <input
        ref={f3dInputRef}
        type="file"
        accept=".f3d"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            f3dUploadMutation.mutate(file);
          }
          e.target.value = '';
        }}
      />
      {/* Hidden file input for timelapse upload */}
      <input
        ref={timelapseInputRef}
        type="file"
        accept=".mp4,.avi,.mkv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            timelapseUploadMutation.mutate(file);
          }
          e.target.value = '';
        }}
      />
    </>
  );
}
