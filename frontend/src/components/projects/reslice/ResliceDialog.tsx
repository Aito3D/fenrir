import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { api } from '../../../api/client';
import type { ProjectFileOut } from '../../../api/client';
import { Button } from '../../Button';
import { IssueText } from '../../RunWithPipelineModal';
import { useIsolatedEscape } from '../../../hooks/useIsolatedEscape';
import { OrderPickerDialog } from '../print/OrderPickerDialog';
import { useOpenOrders } from '../print/useOpenOrders';
import { DialogShell } from '../DialogShell';
import { RADIO_ROW_CLS } from '../dialogStyles';

interface Props {
  projectId: number;
  /** The revision's 3MF files (the only re-sliceable ones). */
  files: ProjectFileOut[];
  initialFileId: number;
  /** `queueTaskId` undefined = slice only; a task id or null = slice then print for that order / none. */
  onStart: (fileId: number, pipelineId: number, queueTaskId: number | null | undefined) => void;
  onClose: () => void;
}

/** Re-trancher (spec §12.1): pick the source 3MF and a saved pipeline; eligibility issues are
 *  warnings only. "Trancher + file" asks for the order first, like a print (phase 4). */
export function ResliceDialog({ projectId, files, initialFileId, onStart, onClose }: Props) {
  const { t } = useTranslation();
  const [fileId, setFileId] = useState(initialFileId);
  const [pipelineId, setPipelineId] = useState<number | null>(null);
  const [askOrder, setAskOrder] = useState(false);
  const dialogRef = useRef<HTMLFormElement>(null);
  // In the order step the picker owns Escape (back to this step); this dialog must not close too.
  useIsolatedEscape(() => { if (!askOrder) onClose(); }, dialogRef);
  const { openOrders, loading: ordersLoading, failed: ordersFailed, noOrderNeeded } = useOpenOrders(projectId);

  const { data: pipelines, isPending, isError: pipelinesFailed } = useQuery({ queryKey: ['slicer-pipelines'], queryFn: api.listSlicerPipelines });
  const { data: report } = useQuery({
    queryKey: ['pipeline-eligibility', pipelineId, fileId],
    queryFn: () => api.checkPipelineEligibility(pipelineId as number, { kind: 'libraryFile', id: fileId }),
    enabled: pipelineId !== null,
    retry: false,
  });
  const list = pipelines?.pipelines ?? [];
  const source = files.find((f) => f.id === fileId) ?? files[0];
  const title = t('projectsPdm.reslice.title', { name: source?.filename ?? '' });

  const sliceAndQueue = () => {
    if (pipelineId === null) return;
    // Same rule as PrintRevisionFlow: no open order (and orders loaded fine) → no task, no picker.
    if (noOrderNeeded) onStart(fileId, pipelineId, null);
    else setAskOrder(true);
  };

  if (askOrder && pipelineId !== null) {
    return (
      <OrderPickerDialog
        orders={openOrders}
        unavailable={ordersFailed}
        loading={ordersLoading}
        onConfirm={(taskId) => onStart(fileId, pipelineId, taskId)}
        onCancel={() => setAskOrder(false)}
      />
    );
  }

  return (
    <DialogShell
      dialogRef={dialogRef}
      title={title}
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        if (pipelineId !== null) onStart(fileId, pipelineId, undefined);
      }}
    >
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      {files.length > 1 && (
        <label className="block space-y-1 text-sm text-bambu-gray-light">
          <span>{t('projectsPdm.reslice.source')}</span>
          <select value={fileId} onChange={(e) => setFileId(Number(e.target.value))}
            className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-white">
            {files.map((f) => <option key={f.id} value={f.id}>{f.filename}</option>)}
          </select>
        </label>
      )}
      {isPending ? (
        <p role="status" className="flex min-h-[44px] items-center gap-2 px-3 text-sm text-bambu-gray-light">
          <Loader2 className="h-4 w-4 animate-spin text-bambu-green" aria-hidden="true" />
          {t('common.loading')}
        </p>
      ) : pipelinesFailed ? (
        <p role="alert" className="text-sm text-red-400">{t('projectsPdm.reslice.pipelinesUnavailable')}</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-bambu-gray-light">{t('projectsPdm.reslice.noPipelines')}</p>
      ) : (
        <fieldset className="max-h-[40vh] space-y-2 overflow-y-auto">
          <legend className="mb-1 text-sm text-bambu-gray-light">{t('projectsPdm.reslice.pipeline')}</legend>
          {list.map((p) => (
            <label key={p.id} className={RADIO_ROW_CLS}>
              <input type="radio" name="reslice-pipeline" checked={pipelineId === p.id}
                onChange={() => setPipelineId(p.id)} className="accent-bambu-green" />
              <span className="min-w-0 break-words">{p.name}</span>
            </label>
          ))}
        </fieldset>
      )}
      {report && report.issues.length > 0 && (
        <div role="status" className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
          <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" aria-hidden="true" />{t('projectsPdm.reslice.warnings')}</p>
          <ul className="list-disc pl-5">{report.issues.map((issue, i) => <li key={i}><IssueText issue={issue} /></li>)}</ul>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
        <Button type="button" variant="secondary" disabled={pipelineId === null} onClick={sliceAndQueue}>
          {t('projectsPdm.reslice.sliceAndQueue')}
        </Button>
        <Button type="submit" disabled={pipelineId === null}>{t('projectsPdm.reslice.slice')}</Button>
      </div>
    </DialogShell>
  );
}
