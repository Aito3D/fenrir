import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Building2, Loader2, User, X } from 'lucide-react';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { api } from '../../api/client';
import type { AitoClientHistoryCard, AitoProject } from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useCurrency } from '../../hooks/useCurrency';
import { formatMoney } from '../../utils/pricing';
import { formatDate } from '../../utils/date';
import { focusRingCls } from '../formStyles';
import { ALL_COLUMNS } from './columns';
import { CLIENT_TIMELINE_LIMIT, summariseTimeline, timelineItems } from './clientHistoryTimeline';

/** A beat past .animate-modal-out's 150ms — the margin CreateInvoiceModal gives. */
const MODAL_OUT_MS = 170;

/** Every project this client ever had, newest first, on a vertical rail.
 *
 *  Opened from the panel masthead (a 0.5 s hold on the name, or the History
 *  button). Each row is identified by `#id · quote number` and its total —
 *  the three things an operator quotes back to a returning client — with the
 *  description and stage under them. The row for the card the dialog was
 *  opened from is tinted and inert; every other row is a button that hands
 *  its id to `onOpenCard`, which the page turns into a panel swap.
 *
 *  It is rendered by the panel, so it stacks above it (z-[110] against the
 *  panel's z-50 backdrop) and never touches the masthead's height.
 *
 *  Spec: docs/superpowers/specs/2026-09-23-aito-client-history-timeline-design.md
 */
export function ClientHistoryModal({
  project,
  onClose,
  onOpenCard,
}: {
  project: AitoProject;
  onClose: () => void;
  /** Absent → rows are plain blocks (a caller without the page's swap). */
  onOpenCard?: (id: number) => void;
}) {
  const { t } = useTranslation();
  const currency = useCurrency();
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: MODAL_OUT_MS });
  const clientId = project.client_id ?? '';
  // A clientless card is a real, expected state (the header falls back to
  // t('aito.noClient') below) — the query is disabled for it, not failed or
  // loading. TanStack Query v5 leaves a disabled query's status at 'pending'
  // forever, so `history.isPending`/`isSuccess` alone cannot distinguish
  // "still fetching" from "nothing to fetch"; every read of them below folds
  // `clientId === ''` in to keep the loading/empty branches honest.
  const hasClient = clientId !== '';

  // Its own key (the limit is part of it): the drawer's recall block caches
  // the same route under ['aito-client-history', id] with limit 5, and a
  // shared entry would hand one of them the wrong slice.
  const history = useQuery({
    queryKey: ['aito-client-history', clientId, CLIENT_TIMELINE_LIMIT],
    queryFn: () => api.getAitoClientHistory(clientId, CLIENT_TIMELINE_LIMIT),
    enabled: hasClient,
    staleTime: 60_000,
    retry: false,
  });

  const cards = history.data?.cards ?? [];
  const summary = summariseTimeline(cards);
  const items = timelineItems(cards);

  const stageLabel = (card: AitoClientHistoryCard) => {
    const meta = ALL_COLUMNS.find((column) => column.id === card.column);
    return meta ? t(meta.labelKey) : card.column;
  };

  const ClientGlyph = project.client_is_company ? Building2 : User;

  return (
    // z-[110], not z-50: the panel's own backdrop is z-50, so a lower overlay
    // renders behind the panel that opened this.
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={requestClose}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('aito.clientHistory')}
        aria-busy={history.isPending && hasClient ? 'true' : undefined}
        data-testid="client-history-modal"
        tabIndex={-1}
        className={`w-full max-w-[600px] max-h-[88vh] flex flex-col focus:outline-none ${
          closing ? 'animate-modal-out' : 'animate-modal-in'
        }`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className="p-0 flex flex-col min-h-0">
          <header className="flex items-start justify-between gap-3 px-5 pt-5 pb-3.5 border-b border-bambu-dark-tertiary">
            <div className="min-w-0">
              <p className="text-[.72rem] font-semibold uppercase tracking-[.08em] text-bambu-gray">
                {t('aito.clientHistory')}
              </p>
              <h3 className="mt-0.5 flex items-center gap-2 text-[1.15rem] font-semibold tracking-[-0.01em] text-white min-w-0">
                <ClientGlyph className="h-4 w-4 flex-shrink-0" strokeWidth={2.5} aria-hidden="true" />
                <span className="truncate">{project.client_name ?? t('aito.noClient')}</span>
              </h3>
              {cards.length > 0 && (
                <p data-testid="client-history-summary" className="mt-1 text-[.85rem] text-bambu-gray-light">
                  {t('aito.clientHistorySummary', {
                    count: summary.count,
                    total: formatMoney(summary.total, currency),
                    date: formatDate(summary.since, { month: 'short', year: 'numeric' }),
                  })}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label={t('common.close')}
              className={`flex-shrink-0 rounded-lg p-1.5 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
            >
              <X className="h-4.5 w-4.5" aria-hidden="true" />
            </button>
          </header>

          <div className="overflow-y-auto flex-1 min-h-0 px-5 pt-2 pb-5">
            {history.isPending && hasClient && (
              <div className="flex items-center gap-2 py-8 text-sm text-bambu-gray">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('common.loading')}
              </div>
            )}
            {history.isError && (
              <div className="flex items-center justify-between gap-3 py-8 text-sm">
                <p className="text-status-error">{t('aito.clientHistoryError')}</p>
                <Button variant="secondary" size="sm" onClick={() => history.refetch()}>
                  {t('common.retry')}
                </Button>
              </div>
            )}
            {(history.isSuccess || !hasClient) && cards.length === 0 && (
              <p className="py-8 text-sm text-bambu-gray">{t('aito.clientHistoryEmpty')}</p>
            )}
            {cards.length > 0 && (
              // The rail is a pseudo-element on the list so it spans year
              // markers and rows alike; its x matches the dot's centre
              // (`left-[88px]`, the date column's width).
              <ol className="relative before:absolute before:left-[88px] before:top-2.5 before:bottom-2.5 before:w-0.5 before:rounded-full before:bg-bambu-dark-tertiary">
                {items.map((item) =>
                  item.kind === 'year' ? (
                    <li
                      key={`year-${item.year}`}
                      data-testid="client-history-year"
                      className="relative pl-[110px] pt-3.5 pb-1.5 text-[.72rem] font-semibold uppercase tracking-[.1em] text-bambu-gray before:absolute before:left-[85px] before:top-[17px] before:h-2 before:w-2 before:rotate-45 before:rounded-[2px] before:bg-bambu-dark-tertiary"
                    >
                      {item.year}
                    </li>
                  ) : (
                    <TimelineRow
                      key={item.card.id}
                      card={item.card}
                      current={item.card.id === project.id}
                      stage={stageLabel(item.card)}
                      currency={currency}
                      onOpen={onOpenCard}
                    />
                  ),
                )}
              </ol>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TimelineRow({
  card,
  current,
  stage,
  currency,
  onOpen,
}: {
  card: AitoClientHistoryCard;
  current: boolean;
  stage: string;
  currency: string;
  onOpen?: (id: number) => void;
}) {
  const { t } = useTranslation();
  const declined = card.quote_status === 'declined';
  const done = card.column === 'done';
  // Dot: cyan on Done, green on any live stage, a red ring when declined —
  // the same three tones the board uses for finished / in flight / refused.
  const dotCls = declined
    ? 'border-status-error bg-bambu-dark-secondary'
    : done
      ? 'border-aito-cyan bg-aito-cyan-dim'
      : 'border-bambu-green bg-bambu-green shadow-[0_0_0_4px_rgba(0,174,66,.18)]';
  const chipCls = declined
    ? 'border-status-error/35 bg-status-error/10 text-status-error'
    : current
      ? 'border-bambu-green/40 bg-bambu-green/[0.12] text-bambu-green-light'
      : done
        ? 'border-aito-cyan/35 bg-aito-cyan/[0.12] text-aito-cyan'
        : 'border-aito-line bg-white/[0.04] text-aito-muted';
  const chip = declined ? t('aito.clientHistoryDeclined') : current ? t('aito.clientHistoryThisCard', { stage }) : stage;

  const body = (
    <>
      <div className="flex items-center gap-2.5 font-mono text-[.8rem] text-bambu-gray-light">
        <span className="font-semibold text-white">#{card.id}</span>
        {card.quote_number ? (
          <span>{card.quote_number}</span>
        ) : (
          <span className="font-sans italic text-bambu-gray">{t('aito.clientHistoryNoQuote')}</span>
        )}
      </div>
      <div className="whitespace-nowrap text-right text-[.95rem] font-semibold tabular-nums text-white">
        {formatMoney(card.total, currency)}
      </div>
      <div className="col-start-1 truncate text-[.9rem] text-white">{card.description}</div>
      <span className={`justify-self-end whitespace-nowrap rounded-full border px-2 py-0.5 text-[.7rem] font-semibold ${chipCls}`}>
        {chip}
      </span>
    </>
  );
  const rowCls = 'my-1 ml-[18px] grid grid-cols-[1fr_auto] gap-x-3.5 gap-y-1 rounded-[10px] border px-3 py-2.5 text-left';

  return (
    <li
      data-testid="client-history-row"
      aria-current={current ? 'true' : undefined}
      className="relative grid grid-cols-[88px_1fr] items-start"
    >
      <div className="pr-[22px] pt-3 text-right text-[.78rem] leading-tight tabular-nums text-bambu-gray-light">
        {formatDate(card.created_at, { day: 'numeric', month: 'short' })}
        <span className="block text-[.72rem] text-bambu-gray">{formatDate(card.created_at, { year: 'numeric' })}</span>
      </div>
      <span aria-hidden="true" className={`absolute left-[83px] top-[15px] z-[1] h-3 w-3 rounded-full border-2 ${dotCls}`} />
      {current || !onOpen ? (
        <div className={`${rowCls} ${current ? 'border-bambu-green/35 bg-bambu-green/[0.07]' : 'border-transparent'}`}>{body}</div>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(card.id)}
          title={t('aito.clientHistoryOpenCard', { id: card.id })}
          className={`${rowCls} w-full border-transparent transition-[background-color,border-color] duration-150 hover:border-bambu-dark-tertiary hover:bg-bambu-dark ${focusRingCls}`}
        >
          {body}
        </button>
      )}
    </li>
  );
}
