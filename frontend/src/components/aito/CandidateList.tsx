import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api, type AitoProject } from '../../api/client';
import { useCurrency } from '../../hooks/useCurrency';
import { formatMoney } from '../../utils/pricing';
import { focusRingCls } from '../formStyles';
import { ALL_COLUMNS } from './columns';
import { matchesCandidate, mergeCandidates } from './mergeCandidates';

/** The other board cards `project` can exchange tasks with, as a radio list —
 *  the merge picker and the "move tasks" target picker share it. Filtering
 *  (`query`) and the selection live with the caller, which owns the search
 *  box and the confirm button. */
export function CandidateList({
  project,
  selectedId,
  onSelect,
  query,
}: {
  project: AitoProject;
  selectedId: number | null;
  onSelect: (id: number) => void;
  query: string;
}) {
  const { t } = useTranslation();
  const currency = useCurrency();
  // Same key as the board, so this is served from its cache and costs no
  // request while the panel is open on top of it.
  const board = useQuery({ queryKey: ['aito-projects'], queryFn: api.getAitoProjects });
  const candidates = useMemo(() => mergeCandidates(board.data ?? [], project), [board.data, project]);
  const needle = query.trim().toLowerCase();
  const visible = candidates.filter((p) => matchesCandidate(p, needle));

  const stage = (p: AitoProject) => ALL_COLUMNS.find((column) => column.id === p.column);

  if (board.isPending) {
    return (
      <div className="flex items-center justify-center py-10 text-bambu-gray">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
      </div>
    );
  }
  if (candidates.length === 0) {
    return <p className="py-8 text-center text-sm text-bambu-gray">{t('aito.mergeEmpty')}</p>;
  }
  if (visible.length === 0) {
    return <p className="py-8 text-center text-sm text-bambu-gray">{t('aito.mergeNoMatch')}</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {visible.map((p) => {
        const meta = stage(p);
        const checked = p.id === selectedId;
        return (
          <li key={p.id}>
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              data-testid="merge-candidate"
              onClick={() => onSelect(p.id)}
              className={`w-full rounded-lg border px-3 py-2 text-left transition-[background-color,border-color] duration-150 ${focusRingCls} ${
                checked
                  ? 'border-bambu-green/50 bg-bambu-green/[0.08]'
                  : 'border-transparent hover:border-bambu-dark-tertiary hover:bg-bambu-dark'
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-sm text-white">{p.description}</span>
                <span className="flex-none text-sm tabular-nums text-bambu-gray-light">
                  {formatMoney(p.tasks_total, currency)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-bambu-gray">
                <span className="min-w-0 truncate">{p.client_name ?? t('aito.noClient')}</span>
                <span aria-hidden="true">·</span>
                <span className="flex-none tabular-nums">#{p.id}</span>
                {p.quote_number && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="flex-none tabular-nums">{p.quote_number}</span>
                  </>
                )}
                <span className="flex-1" />
                {meta && (
                  <span className="inline-flex flex-none items-center gap-1.5">
                    <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                    {t(meta.labelKey)}
                  </span>
                )}
                <span className="flex-none tabular-nums">{t('aito.mergeTaskCount', { count: p.task_count })}</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
