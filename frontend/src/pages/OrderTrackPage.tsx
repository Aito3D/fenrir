import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { OrderTracking } from '../api/client';
import { TrackingLanguageSelect } from '../components/aito/TrackingLanguageSelect';
import { PanelReveal, TrackingPanel } from '../components/aito/TrackingPanel';
import { TrackingPaymentMethods } from '../components/aito/TrackingPaymentMethods';
import { StageRail } from '../components/aito/TrackingRail';
import { TrackingShopPanel } from '../components/aito/TrackingShopPanel';
import { CardSkeleton, Footer, Logo, TrackingPayLink } from '../components/aito/trackingShell';
import { useI18nSettleDeadline, useTrackingLanguage } from '../hooks/useTrackingLanguage';
import { useTrackingPanel } from '../hooks/useTrackingPanel';
import { AITO3D_SENDER } from '../utils/aitoSender';
import { TRACK_MOTION, longDate, trackStateDelay, updatedAt } from '../utils/aitoTracking';
import { ORDER_LINE_TONE, orderLineLabel, orderStageIndex, orderStages, orderStatusCopy, orderTally } from '../utils/orderTracking';
import { formatMoney } from '../utils/pricing';
import { CARD, FOCUS, PAGE, PRESS, TERMS_BUTTON, delayAt } from '../utils/trackingShell';

// The Aito page's fold: more than 8 lines show the first 6 behind a button.
const LINES_FOLD = 8;
const LINES_SHOWN = 6;
// A stalled connection must end in the retryable error, not an endless skeleton (as on the Aito page).
const TRACK_TIMEOUT_MS = 10_000;

/** The customer's public tracking page of a sales order (`/t/<code>`, the Aito cards' link shape):
 *  the Aito tracking page's shell, motion and side panels around an order's
 *  own story — received, in preparation, ready to collect, handed over —
 *  its lines with a status each, and what is left to pay. Standalone and
 *  always dark, in the customer's language. Every failure of the link is
 *  the same dedicated page; any other failure offers a retry. */
export function OrderTrackPage() {
  const { token = '' } = useParams<{ token: string }>();
  const { t, lng, ready } = useTrackingLanguage();
  const [showAll, setShowAll] = useState(false);
  // Tracked here, not read off the query: an errored query with no data drops
  // back to `pending` on refetch, which would flash the skeleton.
  const [retrying, setRetrying] = useState(false);
  const query = useQuery({
    queryKey: ['order-track', token],
    queryFn: async ({ signal }) => {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort);
      const timeout = window.setTimeout(() => controller.abort(), TRACK_TIMEOUT_MS);
      try {
        return await api.getOrderTracking(token, controller.signal);
      } finally {
        window.clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
      }
    },
    enabled: token !== '',
    retry: false,
    staleTime: 30_000,
  });
  const data = query.data;

  // The same render-time gates as the Aito page: the first paint waits for
  // the language (or its deadline), the choreography plays on the first data
  // only, and a refetch that brings a LATER stage replays the rail from the
  // node that was current. Refs, not state, so no static frame paints first.
  const everReady = useRef(false);
  if (ready) everReady.current = true;
  const i18nTimedOut = useI18nSettleDeadline();
  const settled = everReady.current || i18nTimedOut;
  const firstData = useRef<OrderTracking | undefined>(undefined);
  if (data && settled && firstData.current === undefined) firstData.current = data;
  const entrance = data !== undefined && data === firstData.current;
  const lastStage = useRef<OrderTracking['stage'] | undefined>(undefined);
  const advanceRef = useRef<{ from: number; seq: number } | null>(null);
  if (data && settled) {
    if (lastStage.current === undefined) lastStage.current = data.stage;
    else if (lastStage.current !== data.stage) {
      const from = orderStageIndex(lastStage.current);
      advanceRef.current = orderStageIndex(data.stage) > from ? { from, seq: (advanceRef.current?.seq ?? 0) + 1 } : null;
      lastStage.current = data.stage;
    }
  }
  const advance = entrance ? null : advanceRef.current;
  const current = data ? orderStageIndex(data.stage) : 0;
  const origin = entrance ? 0 : advance?.from;
  const moving = origin !== undefined;
  const stateAt = trackStateDelay(current, origin ?? 0);

  const lines = data?.lines ?? [];
  const foldable = lines.length > LINES_FOLD;
  const folded = foldable && !showAll;
  const shown = folded ? lines.slice(0, LINES_SHOWN) : lines;
  const revealed = (i: number) => foldable && i >= LINES_SHOWN;
  const lineStyle = (i: number): CSSProperties | undefined => {
    if (revealed(i)) return delayAt(Math.min(i - LINES_SHOWN, 7) * TRACK_MOTION.reveal);
    if (entrance) return delayAt(stateAt + TRACK_MOTION.parts + Math.min(i, 7) * TRACK_MOTION.partStep);
    return undefined;
  };
  // Only worth a line when the list is long and says more than one thing.
  const tally = foldable ? orderTally(lines) : [];

  const is404 = query.error instanceof ApiError && query.error.status === 404;
  const is429 = query.error instanceof ApiError && query.error.status === 429;
  const showContent = data !== undefined && settled;
  const showError = (query.isError || retrying) && !is404 && data === undefined;

  // The shop to the left, the ways to pay to the right (only while something is owed). One at a time.
  const panel = useTrackingPanel();
  const payment = data?.payment ?? null;
  const owes = showContent && payment !== null && payment.left > 0;
  const shopTrigger = { open: panel.open === 'shop', controls: 'track-panel-shop', toggle: (from: HTMLElement) => panel.toggle('shop', from) };
  // A refetch can settle the order while the payment panel is open: its trigger is gone, so close it here.
  useEffect(() => {
    if (!owes && panel.open === 'pay') panel.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owes, panel.open, panel.close]);
  const retry = () => {
    setRetrying(true);
    void query.refetch().finally(() => setRetrying(false));
  };
  const outline = `inline-flex min-h-[44px] items-center justify-center rounded-[8px] border border-aito-cyan/35 px-[24px] text-[14px] font-semibold text-aito-cyan hover:bg-aito-cyan/10 ${FOCUS}`;

  if (is404 && settled) {
    return (
      <div className={PAGE}>
        <div className={CARD}>
          <TrackingLanguageSelect />
          <header className="animate-track-fade text-center" data-testid="track-invalid">
            <Logo className="mb-[20px]" />
            <h1 className="animate-rise text-[23px] font-semibold tracking-tight" style={delayAt(TRACK_MOTION.invalidTitle)}>
              {t('aito.track.invalidTitle')}
            </h1>
            <p className="animate-rise mt-[8px] text-[15px] text-aito-muted" style={delayAt(TRACK_MOTION.invalidBody)}>
              {t('aito.track.order.invalidBody')}
            </p>
            <Link to="/t" style={delayAt(TRACK_MOTION.invalidLink)} className={`animate-rise mt-[20px] ${outline} ${PRESS}`}>
              {t('aito.track.invalidEnterCode')}
            </Link>
          </header>
          <Footer at={TRACK_MOTION.footerAlone} question={t('aito.track.order.question')} />
        </div>
      </div>
    );
  }

  const copy = showContent ? orderStatusCopy(data, t) : null;
  const money = (n: number) => formatMoney(n, payment?.currency ?? 'XPF');
  const reference = data ? t('aito.track.order.ref', { ref: data.reference }) : '';
  const small = 'text-[12px] uppercase tracking-[.08em] text-aito-muted';
  return (
    <div className={PAGE}>
      <div className="track-stage" data-open={panel.open ?? undefined} data-testid="track-stage">
        <div className="track-scrim" data-testid="track-scrim" onClick={panel.close} aria-hidden="true" />
        <div className={`${CARD} track-card`}>
          <TrackingLanguageSelect />
          <header className="text-center">
            <Logo className="mb-[20px]" />
            <h1 className="text-[23px] font-semibold tracking-tight">{t('aito.track.order.title')}</h1>
            {showContent && (
              <p className="mt-[8px] text-[13.5px] text-aito-muted" data-testid="track-reference">
                {reference}
                {data.date && ` · ${t('aito.track.order.placed', { date: longDate(data.date, lng) })}`}
              </p>
            )}
          </header>
          <main>
            {(query.isPending || !settled) && !query.isError && !retrying && <CardSkeleton />}
            {showError && (
              <div key={query.errorUpdatedAt} className="animate-track-fade mt-[32px] text-center" data-testid="track-error-block">
                <p className="text-[15px] text-aito-muted" data-testid="track-error">
                  {t(is429 ? 'aito.track.codeTooMany' : 'aito.track.error')}
                </p>
                <button
                  type="button"
                  disabled={retrying}
                  onClick={retry}
                  className={`mt-[16px] ${outline} transition-[color,background-color,transform,opacity] duration-150 active:scale-[0.97] disabled:opacity-60`}
                >
                  {t(retrying ? 'aito.track.retrying' : 'aito.track.retry')}
                </button>
              </div>
            )}
            {showContent && copy && (
              <div className={entrance ? 'animate-track-fade' : undefined} data-testid="track-content" data-state={data.state}>
                <div className="mt-[32px]">
                  <StageRail stages={orderStages(t)} current={data.stage} finished={data.state === 'handed_over'} animateFrom={origin} />
                </div>
                {/* Keyed on the advance, so the card rises again for each new stage. */}
                <section
                  key={advance?.seq ?? 0}
                  aria-live="polite"
                  data-testid="track-state"
                  className={`relative mt-[32px] rounded-[12px] border border-aito-cyan/35 bg-aito-cyan/10 px-[16px] py-[16px] sm:px-[24px] ${
                    moving ? 'animate-rise' : ''
                  } ${moving && data.state === 'handed_over' ? 'animate-track-halo' : ''}`}
                  style={moving ? ({ ...delayAt(stateAt), '--track-halo-delay': `${stateAt + TRACK_MOTION.halo}ms` } as CSSProperties) : undefined}
                >
                  <h2 className="text-[19px] font-semibold tracking-tight">{copy.title}</h2>
                  <p className="mt-[8px] text-[15px] text-aito-muted">{copy.sub}</p>
                  {data.pickup && data.stage === 'ready' && (
                    <div className="mt-[12px] border-t border-aito-line/60 pt-[12px]" data-testid="track-pickup">
                      <p className={small}>{t('aito.track.order.pickup')}</p>
                      <p className="mt-[4px] text-[15px] text-aito-ink">
                        {AITO3D_SENDER.name} — {AITO3D_SENDER.addressLines[0]}, {AITO3D_SENDER.addressLines[1].split(' – ')[0]}
                      </p>
                      <button
                        type="button"
                        aria-expanded={shopTrigger.open}
                        aria-controls={shopTrigger.controls}
                        onClick={(e) => shopTrigger.toggle(e.currentTarget)}
                        className={`mt-[2px] inline-flex min-h-[44px] items-center rounded-[8px] text-[13.5px] font-semibold text-aito-cyan hover:text-aito-cyan/80 ${PRESS} ${FOCUS}`}
                      >
                        {t('aito.track.order.pickupLink')}
                      </button>
                    </div>
                  )}
                  <p className="mt-[8px] text-[13px] text-aito-muted/80">{t('aito.track.updated', { when: updatedAt(data.updated_at, t, lng) })}</p>
                </section>
                <section className="mt-[24px]">
                  <h3
                    className={`mb-[8px] ${small} font-semibold ${entrance ? 'animate-rise' : ''}`}
                    style={entrance ? delayAt(stateAt + TRACK_MOTION.parts - TRACK_MOTION.partStep) : undefined}
                  >
                    {t('aito.track.order.linesHeading')}
                  </h3>
                  {tally.length > 1 && (
                    <p className="mb-[4px] flex flex-wrap gap-x-[14px] gap-y-[6px] text-[13px]" data-testid="track-tally">
                      {tally.map(({ status, n }) => (
                        <span key={status} className={ORDER_LINE_TONE[status]}>
                          {n} · {t(`aito.track.order.line.${status}`).toLocaleLowerCase(lng)}
                        </span>
                      ))}
                    </p>
                  )}
                  <ul className="divide-y divide-aito-line/60 text-[15px]" data-testid="track-lines">
                    {shown.map((line, i) => (
                      <li
                        key={i}
                        data-status={line.status}
                        className={`flex items-start gap-[12px] py-[12px] ${revealed(i) || entrance ? 'animate-rise' : ''}`}
                        style={lineStyle(i)}
                      >
                        <span className="min-w-0 flex-1">
                          {line.name}
                          <span className={`mt-[2px] block text-[12.5px] ${ORDER_LINE_TONE[line.status]}`}>{orderLineLabel(line, t, lng)}</span>
                        </span>
                        <span className="min-w-[28px] shrink-0 text-right tabular-nums text-aito-muted">×{line.quantity}</span>
                      </li>
                    ))}
                  </ul>
                  {folded && (
                    <button
                      type="button"
                      onClick={() => setShowAll(true)}
                      className={`mt-[12px] inline-flex min-h-[44px] items-center rounded-[8px] text-[13.5px] font-semibold text-aito-cyan hover:text-aito-cyan/80 ${PRESS} ${FOCUS}`}
                    >
                      {t('aito.track.order.showAll', { n: lines.length })}
                    </button>
                  )}
                </section>
                {payment && (
                  <section
                    data-testid="track-payment"
                    data-state={owes ? 'unpaid' : 'paid'}
                    className={`mt-[32px] grid gap-[12px] rounded-[12px] border border-aito-line px-[16px] py-[16px] sm:grid-cols-[1fr_auto] sm:items-center sm:px-[24px] ${entrance ? 'animate-rise' : ''}`}
                    style={entrance ? delayAt(stateAt + TRACK_MOTION.invoice) : undefined}
                  >
                    {owes ? (
                      <>
                        <div>
                          <p className={small}>{t('aito.track.order.pay.left')}</p>
                          <p className="mt-[4px] text-[21px] font-semibold tabular-nums">{money(payment.left)}</p>
                          <p className="mt-[2px] text-[13px] text-aito-muted">
                            {payment.paid > 0
                              ? t('aito.track.order.pay.paidSub', { paid: money(payment.paid), total: money(payment.total) })
                              : t('aito.track.order.pay.total', { total: money(payment.total) })}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-[8px]">
                          {data.pay_url && <TrackingPayLink href={data.pay_url} />}
                          <button
                            type="button"
                            aria-expanded={panel.open === 'pay'}
                            aria-controls="track-panel-pay"
                            onClick={(e) => panel.toggle('pay', e.currentTarget)}
                            className={`${TERMS_BUTTON} ${panel.open === 'pay' ? 'border-aito-cyan/60 bg-aito-cyan/12' : 'border-aito-cyan/35'}`}
                          >
                            {t('aito.track.order.pay.methods')}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div>
                        <p className={small}>{t('aito.track.order.pay.heading')}</p>
                        <p className="mt-[4px] text-[17px] font-semibold text-green-500">{t('aito.track.order.pay.settled')}</p>
                        <p className="mt-[2px] text-[13px] text-aito-muted">{t('aito.track.order.pay.total', { total: money(payment.total) })}</p>
                      </div>
                    )}
                  </section>
                )}
              </div>
            )}
          </main>
          {showContent && <Footer at={entrance ? stateAt + TRACK_MOTION.footer : 0} shop={shopTrigger} question={t('aito.track.order.question')} />}
          {showError && <Footer at={TRACK_MOTION.footerAlone} question={t('aito.track.order.question')} />}
        </div>
        {showContent && (
          <>
            {owes && (
              <TrackingPanel
                id="track-panel-pay"
                testId="track-panel-pay"
                side="right"
                open={panel.open === 'pay'}
                title={t('aito.track.order.pay.methods')}
                subtitle={`${reference} · ${t('aito.track.order.pay.left').toLocaleLowerCase(lng)} ${money(payment.left)}`}
                titleRef={panel.titleRef('pay')}
                onClose={panel.close}
              >
                <PanelReveal i={0} className="-mx-[16px]">
                  <TrackingPaymentMethods
                    open={panel.open === 'pay'}
                    reference={data.reference}
                    onFindShop={(from) => panel.show('shop', from)}
                    appHintKey="aito.track.order.appHint"
                  />
                </PanelReveal>
              </TrackingPanel>
            )}
            <TrackingShopPanel open={panel.open === 'shop'} onClose={panel.close} titleRef={panel.titleRef('shop')} />
          </>
        )}
      </div>
    </div>
  );
}
