import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../../api/client';
import { buildFallbackSummary } from '../../utils/aitoSummary';
import { taskDraftToTaskCreate } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';
import { focusRingCls } from '../formStyles';

export interface AiSummaryPanelProps {
  tasks: TaskDraft[];
  /** Current text + edited latch live in the DRAWER (they persist with the draft). */
  value: string;
  edited: boolean;
  onChange: (text: string, edited: boolean) => void;
  /** Bumped by the drawer each time the Client section opens with a stale signature. */
  generateNonce: number;
}

const SERVICE_LABEL_KEYS: Record<string, string> = {
  scan: 'aito.serviceScan3D',
  modelisation: 'aito.serviceModelisation3D',
  impression: 'aito.serviceImpression3D',
  usinage: 'aito.serviceUsinage',
};

/** AI-generated project summary, shown in the drawer's Client rail.
 *
 *  State machine: `idle` (value empty, nonce 0) -> `generating` (mutation
 *  pending, shimmer) -> `generated` (footer shows the model) | `fallback`
 *  (mutation failed: seeds `buildFallbackSummary` when value is empty, shows
 *  `aito.summaryFallback`). A textarea edit calls `onChange(text, true)` and
 *  latches out auto-regeneration; the drawer's `generateNonce` bumps are
 *  ignored while `edited`, but the (Circle) Regenerate button always
 *  regenerates and clears the latch via `onChange(summary, false)`. */
export function AiSummaryPanel({ tasks, value, edited, onChange, generateNonce }: AiSummaryPanelProps) {
  const { t } = useTranslation();
  const lastNonceRef = useRef(0);

  const mutation = useMutation({
    mutationFn: () => api.summarizeAitoProject(tasks.map(taskDraftToTaskCreate)),
    onSuccess: (data) => onChange(data.summary, false),
    onError: () => {
      // Any failure (409 conflict, network error, timeout) means fallback —
      // the drawer must never end up with an empty description.
      if (!value.trim()) {
        const label = (id: string) => t(SERVICE_LABEL_KEYS[id] ?? id);
        onChange(buildFallbackSummary(tasks, label), false);
      }
    },
  });

  // The drawer bumps generateNonce when the Client step opens with a stale
  // signature. Hand-edits latch generation off; the Regenerate button below
  // is the only override.
  useEffect(() => {
    if (generateNonce === 0 || generateNonce === lastNonceRef.current) return;
    lastNonceRef.current = generateNonce;
    if (edited) return;
    mutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generateNonce]);

  const idle = generateNonce === 0 && !value && !mutation.isPending;
  const failed = mutation.isError;

  return (
    <div
      className={`rounded-[.6rem] border p-3 ${
        idle ? 'border-dashed border-violet-400/25' : 'border-violet-400/35 bg-violet-400/[0.05]'
      }`}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-violet-300" aria-hidden="true" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-violet-300">{t('aito.summaryTitle')}</span>
        {!idle && (
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className={`ml-auto inline-flex items-center gap-1 rounded-md border border-bambu-dark-tertiary px-2 py-0.5 text-xs text-bambu-gray transition-colors hover:text-violet-300 disabled:opacity-40 ${focusRingCls}`}
          >
            <RefreshCw className="h-3 w-3" />
            {t('aito.regenerate')}
          </button>
        )}
      </div>
      {idle ? (
        <p className="text-xs italic text-bambu-gray">{t('aito.summaryWaiting')}</p>
      ) : mutation.isPending ? (
        <div data-testid="ai-summary-shimmer" className="h-10 animate-pulse rounded-md bg-violet-400/15" />
      ) : (
        <>
          <textarea
            aria-label={t('aito.summaryTitle')}
            value={value}
            onChange={(e) => onChange(e.target.value, true)}
            rows={3}
            className="w-full resize-none rounded-md bg-transparent p-1 text-sm text-bambu-gray-light outline-none focus:bg-white/[0.04] focus:text-white"
          />
          <p className={`mt-1 text-[11px] ${edited ? 'text-amber-400' : 'text-bambu-gray'}`}>
            {failed
              ? t('aito.summaryFallback')
              : edited
                ? t('aito.summaryEdited')
                : t('aito.summaryGeneratedBy', { model: mutation.data?.model ?? '' })}
          </p>
        </>
      )}
    </div>
  );
}
