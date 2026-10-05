import { useState } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { TaskProjectLink } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { filesFromDataTransfer } from '../files/fileDrop';
import { useInvalidateProjectLinks } from './useOrderProjectLinks';

/** The modals a task row opens are portalled to <body>, but React still
 *  bubbles their events through the row: only a target really inside the
 *  row's DOM counts as a drop on the task. */
function inZone(e: DragEvent): boolean {
  return e.currentTarget.contains(e.target as Node);
}

/** True for an OS file drag. dnd-kit reorders with pointer events, so a native
 *  drag carrying `Files` can only be a file drop. */
export function isFileDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes('Files');
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
  const invalidate = useInvalidateProjectLinks();
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
    try {
      const result = await api.dropFilesOnTask(taskId, files);
      showToast(t('projectsPdm.aito.dropped', { count: result.results.length, code: project.code ?? project.name }), 'success');
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : t('projectsPdm.files.uploadFailed'), 'error');
    } finally {
      invalidate(orderId, [project.id]);
    }
  };

  return { dragOver, onDragOver, onDragLeave, onDrop: (e: DragEvent) => void onDrop(e) };
}
