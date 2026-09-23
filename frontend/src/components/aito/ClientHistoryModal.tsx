import { Trans, useTranslation } from 'react-i18next';
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

/** One inset for the masthead, the stat tiles and the rows: content lines up
 *  on a single left edge, and the rail sits just inside it. */
const INSET = 'px-[24px]';

/** Every project this client ever had, newest first, on a vertical rail.
 *
 *  Opened from the panel masthead (a 0.5 s hold on the name, or the History
 *  button). The masthead is the client glyph beside the name with the
 *  dialog's purpose under it, then a strip of stat tiles (projects, spend,
 *  first month). Each row is two lines: date, `#id · quote number`, the
 *  stage chip and the total on the first — the things an operator quotes
 *  back to a returning client — and the description under them. The row for
 *  the card the dialog was opened from is tinted and inert; every other row
 *  is a button that hands its id to `onOpenCard`, which the page turns into
 *  a panel swap.
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
  const statFigure = <b className="text-[.88rem] font-semibold tabular-nums text-white" />;

  return (
    // z-[110], not z-50: the panel's own backdrop is z-50, so a lower overlay
    // renders behind the panel that opened this.
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={requestClose}
      // The panel's own window-level Escape listener (useDismissableDialog,
      // in ProjectDetailPanel) is still mounted while this dialog is open, so
      // one Escape would otherwise fire both: this dialog closes AND the
      // panel closes back to the board. Stopping propagation here — in a
      // React onKeyDown, before the event reaches window — is what keeps it
      // from reaching that listener. Focus is inside the dialog on mount
      // (`dialogRef.focus()`), so this fires; ClientEditor's Escape handler
      // uses the same trick for the same reason.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (!closing) requestClose();
      }}
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
          <header className={`grid grid-cols-[36px_1fr_auto] items-center gap-x-3 ${INSET} pt-5 pb-4`}>
            <span
              aria-hidden="true"
              className="grid h-9 w-9 place-items-center rounded-[9px] bg-bambu-dark-tertiary text-bambu-gray-light"
            >
              <ClientGlyph className="h-[17px] w-[17px]" strokeWidth={2.2} />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-[1.15rem] font-semibold leading-tight tracking-[-0.012em] text-white">
                {project.client_name ?? t('aito.noClient')}
              </h3>
              <p className="mt-0.5 text-[.82rem] text-bambu-gray">{t('aito.clientHistory')}</p>
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label={t('common.close')}
              className={`self-start rounded-lg p-1.5 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
            >
              <X className="h-4.5 w-4.5" aria-hidden="true" />
            </button>
          </header>

          {cards.length > 0 && (
            <div data-testid="client-history-summary" className={`flex flex-wrap items-center gap-1.5 ${INSET} pb-3.5`}>
              <span className={STAT_CLS}>
                <Trans i18nKey="aito.clientHistoryProjects" count={summary.count} components={{ b: statFigure }}>
                  {'<b>{{count}}</b> projects'}
                </Trans>
              </span>
              <span className={STAT_CLS}>
                <b className="text-[.88rem] font-semibold tabular-nums text-white">{formatMoney(summary.total, currency)}</b>
              </span>
              <span className={STAT_CLS}>
                <Trans
                  i18nKey="aito.clientHistorySince"
                  values={{ date: formatDate(summary.since, { month: 'short', year: 'numeric' }) }}
                  components={{ b: statFigure }}
                >
                  {'since <b>{{date}}</b>'}
                </Trans>
              </span>
            </div>
          )}

          <div className={`overflow-y-auto flex-1 min-h-0 border-t border-aito-line ${INSET} pt-3.5 pb-5`}>
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
              // markers and rows alike; it sits 5px inside the inset and the
              // list's padding (pl-5) is the room the dots and markers need.
              <ol className="relative pl-5 before:absolute before:left-[5px] before:top-2 before:bottom-2 before:w-0.5 before:rounded-full before:bg-bambu-dark-tertiary">
                {items.map((item) =>
                  item.kind === 'year' ? (
                    <li
                      key={`year-${item.year}`}
                      data-testid="client-history-year"
                      className="relative mt-3 mb-1.5 text-[.74rem] font-semibold leading-5 tracking-[.04em] text-bambu-gray first:mt-0 before:absolute before:-left-[18px] before:top-[7px] before:h-[7px] before:w-[7px] before:rotate-45 before:rounded-[1.5px] before:bg-bambu-gray-dark"
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

const STAT_CLS =
  'flex items-baseline gap-1.5 rounded-lg bg-bambu-dark-tertiary/45 px-2.5 py-1.5 text-[.78rem] text-bambu-gray';

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

  // Two lines: the date spans both on the left; identity + chip and the
  // total share the first, the description has the second to itself.
  const body = (
    <>
      <div className="row-span-2 self-start pt-px text-[.8rem] leading-tight tabular-nums text-bambu-gray-light">
        {formatDate(card.created_at, { day: 'numeric', month: 'short' })}
        <span className="block text-[.72rem] text-bambu-gray">{formatDate(card.created_at, { year: 'numeric' })}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[.8rem] text-bambu-gray-light">
        <span className="font-semibold text-white">#{card.id}</span>
        {card.quote_number ? (
          <span className="tabular-nums">{card.quote_number}</span>
        ) : (
          <span className="italic text-bambu-gray">{t('aito.clientHistoryNoQuote')}</span>
        )}
        <span className={`whitespace-nowrap rounded-full border px-2 py-px text-[.7rem] font-semibold ${chipCls}`}>{chip}</span>
      </div>
      <div className="whitespace-nowrap text-[.95rem] font-semibold tabular-nums text-white">
        {formatMoney(card.total, currency)}
      </div>
      <div className="col-span-2 col-start-2 truncate text-[.9rem] text-white">{card.description}</div>
    </>
  );
  const rowCls =
    'grid w-full grid-cols-[62px_1fr_auto] items-baseline gap-x-3 gap-y-[3px] rounded-[9px] border px-3 py-2.5 text-left';

  return (
    <li data-testid="client-history-row" aria-current={current ? 'true' : undefined} className="relative mb-1">
      <span aria-hidden="true" className={`absolute -left-5 top-[13px] z-[1] h-3 w-3 rounded-full border-2 ${dotCls}`} />
      {current || !onOpen ? (
        <div className={`${rowCls} ${current ? 'border-bambu-green/35 bg-bambu-green/[0.07]' : 'border-transparent'}`}>{body}</div>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(card.id)}
          title={t('aito.clientHistoryOpenCard', { id: card.id })}
          className={`${rowCls} border-transparent transition-[background-color,border-color] duration-150 hover:border-bambu-dark-tertiary hover:bg-bambu-dark ${focusRingCls}`}
        >
          {body}
        </button>
      )}
    </li>
  );
}
