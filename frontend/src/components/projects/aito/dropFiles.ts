import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { LinkedProjectRef, Permission, TaskProjectLink } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { isSourceFilename, refusalMessage } from '../files/filesUi';
import { useFileDropZone } from '../files/useFileDropZone';
import { useInvalidateProjectLinks } from './useOrderProjectLinks';

/** The dashed accent outline an Aito drop zone shows while files hover it. */
export const DROP_HIGHLIGHT_CLS = 'outline-dashed outline-2 outline-offset-2 outline-bambu-green';

/** Files may be dropped on Aito tasks: aito:update and projects:update, plus
 *  projects:read since the task's link comes from the projects:read-gated links route. */
export function canDropFiles(hasPermission: (permission: Permission) => boolean): boolean {
  return hasPermission('aito:update') && hasPermission('projects:update') && hasPermission('projects:read');
}

/** False (with a toast) when a drop holds anything but source `.3mf` files: sliced files are
 *  made by the server, so nothing else is sent. Several files are fine (they group by item name). */
export function useAcceptsSource() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  return (files: readonly File[]): boolean => {
    const refused = files.find((f) => !isSourceFilename(f.name));
    if (!refused) return true;
    showToast(t('projectsPdm.files.onlySource', { name: refused.name }), 'error');
    return false;
  };
}

/** Uploads dropped files onto one linked task and reports the outcome with a
 *  toast; the order's links, chips and project trees refresh afterwards.
 *  Non-printing files toast and send nothing. */
export function useUploadToTask() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const invalidate = useInvalidateProjectLinks();
  const acceptsSource = useAcceptsSource();
  return async (orderId: number, taskId: number, project: LinkedProjectRef, files: File[]) => {
    if (!acceptsSource(files)) return;
    let storedIn: number | undefined;
    try {
      const result = await api.dropFilesOnTask(taskId, files);
      storedIn = result.project_id;
      // The server's answer wins: someone may have relinked the task since our
      // links were fetched (the invalidation below refetches them).
      const code =
        result.code ??
        (result.project_id === project.id ? (project.code ?? project.name) : `#${result.project_id}`);
      const failed = result.errors ?? [];
      const notStored = failed.flatMap((e) => e.filenames);
      if (notStored.length > 0) {
        showToast(
          t('projectsPdm.aito.droppedPartial', {
            count: result.results.length,
            code,
            files: notStored.join(', '),
            reason: failed.map((e) => refusalMessage(t, e.detail, e.filenames[0] ?? '') ?? e.detail).join('; '),
          }),
          'warning',
        );
      } else {
        showToast(t('projectsPdm.aito.dropped', { count: result.results.length, code }), 'success');
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : '';
      showToast(
        (detail && refusalMessage(t, detail, files[0]?.name ?? '')) || detail || t('projectsPdm.files.uploadFailed'),
        'error',
      );
    } finally {
      invalidate(orderId, [project.id, storedIn]);
    }
  };
}

/** Native file drop on one Aito task: linked → the printing files go to the
 *  project's Impression section and a toast says where; not linked → a toast
 *  asks for a project first. `canDrop` false swallows the drop silently. */
export function useTaskFileDrop({
  orderId,
  taskId,
  link,
  canDrop,
}: {
  orderId: number;
  taskId: number | null;
  link: TaskProjectLink | undefined;
  canDrop: boolean;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const upload = useUploadToTask();
  // Always claims a file drag inside the row, or the browser opens the file.
  return useFileDropZone({
    canDrop: canDrop && taskId !== null,
    fileDragsOnly: true,
    stopPropagation: 'drop',
    onFiles: async (files) => {
      const project = link?.project;
      if (!project) {
        showToast(t('projectsPdm.aito.dropNeedsProject'), 'info');
        return;
      }
      await upload(orderId, taskId as number, project, files); // non-null: `canDrop` above
    },
  });
}
