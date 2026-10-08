import { useState } from 'react';
import type { DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { ProjectFileOut } from '../../../api/client';
import { PrintModal } from '../../PrintModal';
import { OrderPickerDialog } from './OrderPickerDialog';
import { useOpenOrders } from './useOpenOrders';

interface Props {
  projectId: number;
  file: ProjectFileOut;
  /** Non-blocking OUTDATED text for the print modal (spec §5.3). */
  revisionWarning?: string;
  /** Order already chosen before slicing (null = none); skips the picker. */
  initialTaskId?: number | null;
  onClose: () => void;
}

/** Print one revision file: pick the order it is for (skipped when the project
 *  has no open order), then the regular PrintModal with the task attached. */
export function PrintRevisionFlow({ projectId, file, revisionWarning, initialTaskId, onClose }: Props) {
  const queryClient = useQueryClient();
  // undefined = not chosen yet; null = no task (internal/test print).
  const [taskId, setTaskId] = useState<number | null | undefined>(initialTaskId);

  const { openOrders, loading: ordersLoading, failed: ordersFailed } = useOpenOrders(projectId);
  const chosen =
    taskId !== undefined ? taskId : openOrders.length === 0 && !ordersFailed && !ordersLoading ? null : undefined;

  // Portalled out of the files tree: keep a stray drag over the dialogs from
  // reaching the section/item drop zones (which would upload a revision).
  const stopDrag = (e: DragEvent) => e.stopPropagation();

  return createPortal(
    <div onDragOver={stopDrag} onDrop={stopDrag}>
      {chosen === undefined ? (
        <OrderPickerDialog
          orders={openOrders}
          unavailable={ordersFailed}
          loading={ordersLoading}
          onConfirm={setTaskId}
          onCancel={onClose}
        />
      ) : (
        <PrintModal
          mode="create"
          libraryFileId={file.id}
          archiveName={file.filename}
          projectId={projectId}
          aitoTaskId={chosen}
          revisionWarning={revisionWarning}
          isolateEscape
          onClose={onClose}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['project-tree', projectId] });
            queryClient.invalidateQueries({ queryKey: ['project-orders', projectId] });
            queryClient.invalidateQueries({ queryKey: ['aito-project-links'] });
          }}
        />
      )}
    </div>,
    document.body,
  );
}
