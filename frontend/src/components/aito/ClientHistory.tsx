import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { api } from '../../api/client';
import type { AitoClientHistoryCard, AitoTask } from '../../api/client';
import { ALL_COLUMNS } from './columns';
import { formatDate } from '../../utils/date';
import { formatMoney } from '../../utils/pricing';
import { useCurrency } from '../../hooks/useCurrency';
import { focusRingCls, labelCls } from '../formStyles';

export interface ClientHistoryProps {
  clientId: string;
  isDefault: boolean;
  onReuse: (tasks: AitoTask[]) => void;
}

const LIMIT = 5;

/** The repeat-client recall block: the attached client's newest cards, each
 *  with a Reuse button that hands its tasks up to the drawer. Keyed on the
 *  ATTACHED client rather than on the pick, so a contact restored from the
 *  persisted draft after a reload gets its history too.
 *
 *  Silent while loading, when empty and on error: nothing here gates Create,
 *  and a status line for a convenience block would only unsettle the section's
 *  layout. The default walk-in contact never asks — its cards are everyone's. */
export function ClientHistory({ clientId, isDefault, onReuse }: ClientHistoryProps) {
  const { t } = useTranslation();
  const currency = useCurrency();
  const enabled = !isDefault && clientId !== '';
  const historyQuery = useQuery({
    queryKey: ['aito-client-history', clientId],
    queryFn: () => api.getAitoClientHistory(clientId, LIMIT),
    enabled,
    staleTime: 60_000,
  });
  const cards = enabled ? (historyQuery.data?.cards ?? []) : [];
  if (cards.length === 0) return null;

  const stageLabel = (card: AitoClientHistoryCard) => {
    const meta = ALL_COLUMNS.find((column) => column.id === card.column);
    return meta ? t(meta.labelKey) : card.column;
  };
  const titles = (card: AitoClientHistoryCard) =>
    card.tasks.map((task, index) => task.title?.trim() || t('aito.taskFallbackName', { n: index + 1 })).join(' · ');

  return (
    <div data-testid="client-history">
      <p className={`${labelCls} flex items-center gap-1.5`}>
        <History className="w-3.5 h-3.5" aria-hidden="true" />
        {t('aito.pastCards', { count: cards.length })}
      </p>
      <ul className="space-y-1">
        {cards.map((card) => (
          <li
            key={card.id}
            data-testid="client-history-row"
            className="flex items-center gap-2 rounded-md bg-bambu-dark px-2.5 py-1.5 text-xs"
          >
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-bambu-gray">
                <span>{formatDate(card.created_at, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                <span aria-hidden="true">·</span>
                <span>{stageLabel(card)}</span>
                <span aria-hidden="true">·</span>
                <span className="text-white">{formatMoney(card.total, currency)}</span>
              </p>
              <p className="truncate text-bambu-gray-light" title={titles(card)}>
                {titles(card)}
              </p>
            </div>
            <button
              type="button"
              disabled={card.tasks.length === 0}
              onClick={() => onReuse(card.tasks)}
              className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium text-bambu-green hover:bg-bambu-dark-tertiary disabled:opacity-40 disabled:hover:bg-transparent ${focusRingCls}`}
            >
              {t('aito.reuseTasks')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
