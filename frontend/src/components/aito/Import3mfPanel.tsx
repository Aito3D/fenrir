import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Box, Check, Loader2, X } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { Aito3mfPlate } from '../../api/client';
import { Money } from '../calculator/shared';
import { focusRingCls, inputCls } from '../formStyles';
import { useCurrency } from '../../hooks/useCurrency';
import { formatDuration } from '../../utils/date';
import {
  isImportable,
  mainFilament,
  matchFilament,
  matchPrinter,
  objectLines,
  plateTitle,
  plateToDraft,
} from '../../utils/aito3mfImport';
import type { TaskDraft } from '../../utils/taskDraft';

export interface Import3mfPanelProps {
  file: File;
  onAdd: (drafts: TaskDraft[]) => void;
  onClose: () => void;
  /** Poll interval of the slicing job; tests shorten it. */
  pollMs?: number;
}

/** What the operator changed on a plate's row; anything absent falls back to the match. */
interface RowChoice {
  ticked?: boolean;
  printerId?: number;
  filamentId?: number;
}

/** Imports a Bambu Studio project .3mf into the new project drawer: uploads it, follows the
 *  server slice, then lists the plates for review. Each ticked plate becomes one print task.
 *  The drawer keys this component per picked file, so a new file starts from scratch. */
export function Import3mfPanel({ file, onAdd, onClose, pollMs = 1500 }: Import3mfPanelProps) {
  const { t } = useTranslation();
  const currency = useCurrency();
  const [attempt, setAttempt] = useState(0);
  const [jobId, setJobId] = useState<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<number, RowChoice>>({});
  const [elapsed, setElapsed] = useState(0);

  // Whether the server already settled the job; a settled one has nothing left to cancel.
  const settledRef = useRef(false);
  // Fire-and-forget: the job may already be gone, and a failure here changes nothing for the operator.
  const cancelJob = (id: number) => void api.cancelAito3mfImport(id).catch(() => undefined);

  useEffect(() => {
    let cancelled = false;
    let startedId: number | null = null;
    settledRef.current = false;
    api
      .startAito3mfImport(file)
      .then((r) => {
        // Closed or re-picked while the upload was in flight: stop the slice nobody will read.
        if (cancelled) return cancelJob(r.job_id);
        startedId = r.job_id;
        setJobId(r.job_id);
      })
      .catch((e: unknown) => !cancelled && setStartError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      // Unmount, another file or a Retry re-upload: the previous job is abandoned.
      if (startedId !== null && !settledRef.current) cancelJob(startedId);
    };
  }, [file, attempt]);

  const job = useQuery({
    queryKey: ['aito3mfImport', jobId],
    queryFn: () => api.getAito3mfImport(jobId as number),
    enabled: jobId !== null,
    // The shop is reached through a tunnel that drops requests: one lost poll must not
    // throw away a slice that took minutes.
    retry: 3,
    retryDelay: pollMs,
    gcTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'completed' || status === 'failed' || query.state.status === 'error' ? false : pollMs;
    },
  });
  // Same keys and fetchers as ImpressionFields, so React Query shares the lists.
  const filamentsQuery = useQuery({ queryKey: ['calculatorFilaments'], queryFn: api.getCalculatorFilaments, staleTime: 60_000 });
  const printersQuery = useQuery({ queryKey: ['calculatorPrinters'], queryFn: api.getCalculatorPrinters, staleTime: 60_000 });
  const defaultsQuery = useQuery({ queryKey: ['calculatorDefaults'], queryFn: api.getCalculatorDefaults, staleTime: 60_000 });
  const filaments = filamentsQuery.data;
  const printers = printersQuery.data;
  const defaults = defaultsQuery.data;
  const failedLists = [filamentsQuery, printersQuery, defaultsQuery].filter((q) => q.isError);

  const state = job.data;
  settledRef.current = state?.status === 'completed' || state?.status === 'failed';
  const jobError = startError ?? (job.isError ? (job.error as Error).message : state?.status === 'failed' ? state.error : null);
  // A list that cannot load would otherwise leave the slicing spinner up for good.
  const error = jobError ?? (failedLists.length > 0 ? (failedLists[0].error as Error).message : null);
  const plates = state?.status === 'completed' ? (state.plates ?? []) : null;
  const slicing = error === null && plates === null;

  useEffect(() => {
    if (!slicing) return;
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [slicing]);

  const retry = () => {
    // Only the calculator lists failed: reload them, the slice itself is fine.
    if (jobError === null && failedLists.length > 0) {
      failedLists.forEach((q) => void q.refetch());
      return;
    }
    // Polls were lost but the server never said the job failed: ask the same job again.
    // A 404 means the server no longer has the job (restart, retention): slice it afresh.
    const gone = job.error instanceof ApiError && job.error.status === 404;
    if (jobId !== null && state?.status !== 'failed' && !gone) {
      void job.refetch();
      return;
    }
    setStartError(null);
    setJobId(null);
    setElapsed(0);
    setAttempt((n) => n + 1);
  };

  const header = (
    <div className="flex items-center gap-2 border-b border-bambu-dark-tertiary px-3 py-2 text-sm">
      <Box className="h-4 w-4 flex-shrink-0 text-bambu-green" />
      <span className="truncate font-semibold text-white">{file.name}</span>
      {plates && <span className="flex-shrink-0 text-bambu-gray">· {t('aito.import3mf.plates', { count: plates.length })}</span>}
      <button
        type="button"
        aria-label={t('common.close')}
        onClick={onClose}
        className={`-m-1 ml-auto rounded-md p-1 text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
  const shell = 'mt-2 overflow-hidden rounded-[.6rem] border border-bambu-green/40 bg-bambu-dark';

  if (error !== null) {
    return (
      <div className={shell} data-testid="import-3mf-panel">
        {header}
        <div className="flex items-center gap-3 px-3 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-400" />
          <span role="alert" className="min-w-0 flex-1 text-amber-300">{error}</span>
          <button
            type="button"
            onClick={retry}
            className={`rounded-md border border-bambu-dark-tertiary px-3 py-1.5 text-bambu-gray hover:text-white ${focusRingCls}`}
          >
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (plates === null || !filaments || !printers || !defaults) {
    const percent = state?.percent ?? null;
    return (
      <div className={shell} data-testid="import-3mf-panel">
        {header}
        <div className="px-3 py-3 text-sm">
          <div className="flex items-center gap-2 text-white">
            <Loader2 className="h-4 w-4 animate-spin text-bambu-green motion-reduce:animate-none" />
            {t('aito.import3mf.slicing')}
            <span className="ml-auto text-xs tabular-nums text-bambu-gray">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={t('aito.import3mf.slicing')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="mt-2 h-1.5 overflow-hidden rounded bg-bambu-dark-tertiary"
          >
            <div
              className={`h-full bg-bambu-green ${percent === null ? 'w-1/3 animate-pulse motion-reduce:animate-none' : 'transition-[width]'}`}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-bambu-gray">{t('aito.import3mf.slicingHint')}</p>
        </div>
      </div>
    );
  }

  const rows = plates.map((plate) => {
    const choice = choices[plate.index] ?? {};
    const importable = isImportable(plate);
    const main = mainFilament(plate);
    const match = matchFilament(main, filaments);
    const printerId = choice.printerId ?? matchPrinter(plate.printer_model, printers);
    const filamentId = choice.filamentId ?? match.id;
    const printer = printers.find((p) => p.id === printerId) ?? null;
    const filament = filaments.find((f) => f.id === filamentId) ?? null;
    const title = plateTitle(plate, plates.length, file.name, (n) => t('aito.import3mf.unnamedPlate', { n }));
    const draft = importable && printer && filament ? plateToDraft(plate, title, printer, filament, defaults) : null;
    return {
      plate,
      importable,
      main,
      title,
      draft,
      printer,
      filament,
      candidates: match.candidates,
      // The pickers stay once used, so a wrong choice can be changed.
      askPrinter: matchPrinter(plate.printer_model, printers) === null,
      askFilament: match.id === null,
      ticked: importable && (choice.ticked ?? true),
    };
  });
  const ticked = rows.filter((row) => row.ticked);
  const ready = ticked.length > 0 && ticked.every((row) => row.draft !== null);
  const choose = (plate: Aito3mfPlate, patch: RowChoice) =>
    setChoices((prev) => ({ ...prev, [plate.index]: { ...prev[plate.index], ...patch } }));

  return (
    <div className={shell} data-testid="import-3mf-panel">
      {header}
      <ul>
        {rows.map(({ plate, importable, main, title, draft, printer, filament, candidates, askPrinter, askFilament, ticked: on }) => (
          <li
            key={plate.index}
            className={`flex items-start gap-3 border-b border-bambu-dark-tertiary px-3 py-2.5 text-sm ${importable ? '' : 'opacity-50'}`}
          >
            <input
              type="checkbox"
              aria-label={title}
              checked={on}
              disabled={!importable}
              onChange={(e) => choose(plate, { ticked: e.target.checked })}
              className="mt-1 accent-bambu-green"
            />
            {plate.thumbnail ? (
              <img src={plate.thumbnail} alt="" className="h-14 w-14 flex-shrink-0 rounded-md border border-bambu-dark-tertiary object-contain" />
            ) : (
              <div className="h-14 w-14 flex-shrink-0 rounded-md border border-bambu-dark-tertiary" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-white">{title}</div>
              <div className="mt-0.5 whitespace-pre-line text-xs text-bambu-gray">{objectLines(plate.objects)}</div>
            </div>
            {importable && (
              <div className="flex w-52 flex-shrink-0 flex-col gap-1 text-xs">
                {askPrinter ? (
                  <select
                    aria-label={t('aito.import3mf.choosePrinter')}
                    value={printer?.id ?? ''}
                    onChange={(e) => e.target.value && choose(plate, { printerId: Number(e.target.value) })}
                    className={`${inputCls} ${printer ? '' : 'border-amber-500/60'}`}
                  >
                    <option value="">{t('aito.import3mf.choosePrinter')}</option>
                    {printers.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                ) : (
                  <span className="text-bambu-gray">{printer?.name}</span>
                )}
                {askFilament ? (
                  <select
                    aria-label={t('aito.import3mf.chooseFilament')}
                    value={filament?.id ?? ''}
                    onChange={(e) => e.target.value && choose(plate, { filamentId: Number(e.target.value) })}
                    className={`${inputCls} ${filament ? '' : 'border-amber-500/60'}`}
                  >
                    <option value="">{t('aito.import3mf.chooseFilament')}</option>
                    {candidates.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                ) : (
                  <span className="flex items-center gap-1 text-white">
                    <Check className="h-3.5 w-3.5 flex-shrink-0 text-bambu-green" />
                    <span className="truncate">{filament?.name}</span>
                  </span>
                )}
                <span className="flex items-center gap-1.5 text-bambu-gray">
                  {main?.color && (
                    <span className="inline-block h-3 w-3 rounded-full border border-white/20" style={{ background: main.color }} />
                  )}
                  {main?.type}
                  {plate.filaments.length > 1 && (
                    <span>· {t('aito.import3mf.otherFilaments', { count: plate.filaments.length - 1 })}</span>
                  )}
                </span>
              </div>
            )}
            {importable && (
              <div className="w-28 flex-shrink-0 text-right text-xs tabular-nums">
                <div className="text-bambu-gray">
                  {formatDuration(plate.print_time_seconds)} · {plate.weight_g} g
                </div>
                <div className="mt-1 font-semibold text-white">
                  {draft?.impressionCost != null ? <Money currency={currency} value={draft.impressionCost} /> : '—'}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-end gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={onClose}
          className={`rounded-md border border-bambu-dark-tertiary px-3 py-1.5 text-sm text-bambu-gray hover:text-white ${focusRingCls}`}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={() => {
            onAdd(ticked.map((row) => row.draft as TaskDraft));
            onClose();
          }}
          className={`rounded-md bg-bambu-green px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40 ${focusRingCls}`}
        >
          {t('aito.import3mf.addTasks', { count: ticked.length })}
        </button>
      </div>
    </div>
  );
}
