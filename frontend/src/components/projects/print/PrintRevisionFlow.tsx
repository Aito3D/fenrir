import { useState } from 'react';
import type { DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../api/client';
import type { ProjectFileOut } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { PrintModal } from '../../PrintModal';
import { OrderPickerDialog } from './OrderPickerDialog';

interface Props {
  projectId: number;
  file: ProjectFileOut;
  /** Non-blocking OUTDATED text for the print modal (spec §5.3). */
  revisionWarning?: string;
  onClose: () => void;
}

/** Print one revision file: pick the order it is for (skipped when the project
 *  has no open order), then the regular PrintModal with the task attached. */
export function PrintRevisionFlow({ projectId, file, revisionWarning, onClose }: Props) {
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canReadOrders = hasPermission('projects:read') && hasPermission('aito:read');
  // undefined = not chosen yet; null = no task (internal/test print).
  const [taskId, setTaskId] = useState<number | null | undefined>(undefined);

  // Same key the link/delivery mutations invalidate.
  const { data, isPending, isError } = useQuery({
    queryKey: ['project-orders', projectId],
    queryFn: () => api.getProjectOrders(projectId),
    enabled: canReadOrders,
    retry: false,
  });

  if (canReadOrders && isPending) return null;
  const openOrders = isError ? [] : (data?.orders ?? []).filter((o) => o.board_column !== 'done');
  const chosen = taskId !== undefined ? taskId : openOrders.length === 0 ? null : undefined;

  // Portalled out of the files tree: keep a stray drag over the dialogs from
  // reaching the section/item drop zones (which would upload a revision).
  const stopDrag = (e: DragEvent) => e.stopPropagation();

  return createPortal(
    <div onDragOver={stopDrag} onDrop={stopDrag}>
      {chosen === undefined ? (
        <OrderPickerDialog orders={openOrders} onConfirm={setTaskId} onCancel={onClose} />
      ) : (
        <PrintModal
          mode="create"
          libraryFileId={file.id}
          archiveName={file.filename}
          projectId={projectId}
          aitoTaskId={chosen}
          revisionWarning={revisionWarning}
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
