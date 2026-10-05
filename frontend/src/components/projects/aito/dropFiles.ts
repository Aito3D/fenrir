import { useState } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { LinkedProjectRef, TaskProjectLink } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { filesFromDataTransfer } from '../files/fileDrop';
import { useInvalidateProjectLinks } from './useOrderProjectLinks';

/** The modals a task row opens are portalled to <body>, but React still
 *  bubbles their events through the row: only a target really inside the
 *  row's DOM counts as a drop on the task. */
export function inZone(e: DragEvent): boolean {
  return e.currentTarget.contains(e.target as Node);
}

/** True for an OS file drag. dnd-kit reorders with pointer events, so a native
 *  drag carrying `Files` can only be a file drop. */
export function isFileDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes('Files');
}

/** Uploads dropped files onto one linked task and reports the outcome with a
 *  toast; the order's links, chips and project trees refresh afterwards. */
export function useUploadToTask() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const invalidate = useInvalidateProjectLinks();
  return async (orderId: number, taskId: number, project: LinkedProjectRef, files: File[]) => {
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

/** Native file drop on one Aito task: linked → the files go to its project
 *  (section guessed server-side) and a toast says where; not linked → a toast
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
  const [dragOver, setDragOver] = useState(false);

  const onDragOver = (e: DragEvent) => {
    if (!isFileDrag(e.dataTransfer)) return;
    // Always claim a file drag inside the row, or the browser opens the file.
    e.preventDefault();
    if (canDrop && taskId !== null && inZone(e)) setDragOver(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
  };
  const onDrop = async (e: DragEvent) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (!canDrop || taskId === null || !inZone(e)) return;
    const files = filesFromDataTransfer(e.dataTransfer);
    if (!files.length) return;
    const project = link?.project;
    if (!project) {
      showToast(t('projectsPdm.aito.dropNeedsProject'), 'info');
      return;
    }
    await upload(orderId, taskId, project, files);
  };

  return { dragOver, onDragOver, onDragLeave, onDrop: (e: DragEvent) => void onDrop(e) };
}
