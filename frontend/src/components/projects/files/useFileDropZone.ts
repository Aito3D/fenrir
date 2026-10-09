import { useState } from 'react';
import type { DragEvent } from 'react';
import { filesFromDataTransfer } from './fileDrop';

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

/** Native drag-and-drop handlers for one drop zone, plus its highlight flag.
 *  Spread `onDragOver` / `onDragLeave` / `onDrop` on the zone's element. Every
 *  claimed drag is `preventDefault`ed, or the browser opens a dropped file. */
export function useFileDropZone({
  canDrop,
  canHighlight = canDrop,
  fileDragsOnly = false,
  stopPropagation,
  onFiles,
}: {
  /** The drop is taken (and, by default, the zone highlights). */
  canDrop: boolean;
  /** The zone highlights under a drag; defaults to `canDrop`. */
  canHighlight?: boolean;
  /** Board zones: a non-file drag passes through untouched (not even claimed),
   *  and only a target really inside the zone's DOM highlights or drops. */
  fileDragsOnly?: boolean;
  /** Which events stop at this zone: the drop only, or the drag-over too. */
  stopPropagation?: 'drop' | 'dragOverAndDrop';
  /** Called with the dropped files (never empty) once the drop is taken. */
  onFiles: (files: File[]) => void | Promise<void>;
}) {
  const [dragOver, setDragOver] = useState(false);

  const onDragOver = (e: DragEvent) => {
    if (fileDragsOnly && !isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    if (stopPropagation === 'dragOverAndDrop') e.stopPropagation();
    if (canHighlight && (!fileDragsOnly || inZone(e))) setDragOver(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
  };
  const onDrop = (e: DragEvent) => {
    if (fileDragsOnly && !isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    if (stopPropagation) e.stopPropagation();
    setDragOver(false);
    if (!canDrop || (fileDragsOnly && !inZone(e))) return;
    const files = filesFromDataTransfer(e.dataTransfer);
    if (files.length) void onFiles(files);
  };

  return { dragOver, onDragOver, onDragLeave, onDrop };
}
