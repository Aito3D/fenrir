import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { LinkedProjectRef, TaskProjectLink } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { nonPrintableFiles } from '../files/filesUi';
import { useFileDropZone } from '../files/useFileDropZone';
import { useInvalidateProjectLinks } from './useOrderProjectLinks';

export { inZone, isFileDrag } from '../files/useFileDropZone';

/** False (with a toast) when a drop holds any non-printing file: projects hold
 *  printing files only for now, and the server refuses such a drop whole. */
export function useAcceptsPrintable() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  return (files: readonly File[]): boolean => {
    if (nonPrintableFiles(files).length === 0) return true;
    showToast(t('projectsPdm.files.onlyPrintable'), 'error');
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
  const acceptsPrintable = useAcceptsPrintable();
  return async (orderId: number, taskId: number, project: LinkedProjectRef, files: File[]) => {
    if (!acceptsPrintable(files)) return;
    let storedIn: number | undefined;
    try {
      const result = await api.dropFilesOnTask(taskId, files);
      storedIn = result.project_id;
      // The server's answer wins: someone may have relinked the task since our
      // links were fetched (the invalidation below refetches them).
      const code =
        result.code ??
        (result.project_id === project.id ? (project.code ?? project.name) : `#${result.project_id}`);
      showToast(t('projectsPdm.aito.dropped', { count: result.results.length, code }), 'success');
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : t('projectsPdm.files.uploadFailed'), 'error');
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
