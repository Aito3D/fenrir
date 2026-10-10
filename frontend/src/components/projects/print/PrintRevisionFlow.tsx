import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ProjectFileOut } from '../../../api/client';
import { PrintModal } from '../../PrintModal';
import { OrderPickerDialog } from './OrderPickerDialog';
import { useOpenOrders } from './useOpenOrders';
import { projectKeys } from '../projectQueries';
import { DropShield } from '../DropShield';

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

  const { openOrders, loading: ordersLoading, failed: ordersFailed, noOrderNeeded } = useOpenOrders(projectId);
  const chosen = taskId !== undefined ? taskId : noOrderNeeded ? null : undefined;

  return (
    <DropShield>
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
            queryClient.invalidateQueries({ queryKey: projectKeys.tree(projectId) });
            queryClient.invalidateQueries({ queryKey: projectKeys.orders(projectId) });
            queryClient.invalidateQueries({ queryKey: ['aito-project-links'] });
          }}
        />
      )}
    </DropShield>
  );
}
