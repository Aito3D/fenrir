import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { TrackingInvoice } from '../components/aito/TrackingInvoice';
import { TrackingLanguageSelect } from '../components/aito/TrackingLanguageSelect';
import { TrackingRail } from '../components/aito/TrackingRail';
import { Footer, Logo } from '../components/aito/trackingShell';
import { useTrackingLanguage } from '../hooks/useTrackingLanguage';
import { CARD, FOCUS, PRESS, delayAt } from '../utils/trackingShell';
import { TRACK_MOTION, etaCopy, statusCopy, trackStages, trackStateDelay, updatedAt } from '../utils/aitoTracking';

// Above this many parts, fold to the first six behind a "Voir les n pièces"
// button — a 60-character name and a 10+ item list must still hold (§7b).
const PARTS_FOLD = 8;
const PARTS_SHOWN = 6;

/** The client's public tracking page: standalone, no app chrome, always
 *  dark (Midnight Blue + cyan) whatever the operator's theme, in the
 *  client's language. The current state is the hero; the brand is a small
 *  logo and a footer. A 404 (expired or unknown link, §2) gets its own
 *  dedicated page — never a stack trace, a raw API message or the login
 *  screen; any other failure offers a "Réessayer" button instead. */
export function AitoTrackPage() {
  const { token = '' } = useParams<{ token: string }>();
  const { t, lng, ready } = useTrackingLanguage();
  const [showAllParts, setShowAllParts] = useState(false);
  const query = useQuery({
    queryKey: ['aito-track', token],
    queryFn: () => api.getAitoTracking(token),
    enabled: token !== '',
    retry: false,
    staleTime: 30_000,
  });

  const data = query.data;
  // The first paint waits for the language bundle (English ships in the
  // entry, everything else is a lazy chunk) so the choreography never plays
  // in English and then flips. Later language switches keep the content
  // mounted — react-i18next re-renders it in place when the chunk lands.
  const everReady = useRef(false);
  if (ready) everReady.current = true;
  const settled = everReady.current;
  // The choreography plays on the FIRST data only. React Query refetches on
  // window focus once the 30 s stale time has passed; replaying the rail on
  // every tab switch would be the over-animation this page must avoid. A
  // refetch that changes nothing keeps the same object (structural sharing),
  // so the classes stay and the finished animations simply do not replay.
  const firstData = useRef<typeof data>(undefined);
  if (data && settled && firstData.current === undefined) firstData.current = data;
  const entrance = data !== undefined && data === firstData.current;
  const copy = data ? statusCopy(data, t, lng) : null;
  const eta = data ? etaCopy(data, t, lng) : null;
  const preOrder = data?.column === 'devis' || data?.column === 'waiting';
  const finished = data?.column === 'done';
  const current = data ? trackStages(data.shipping !== null, t).findIndex((s) => s.id === data.column) : 0;
  const stateAt = trackStateDelay(current);
  const is404 = query.error instanceof ApiError && query.error.status === 404;
  const showContent = data !== undefined && copy !== null && settled;

  if (is404 && settled) {
    return (
      <div className="min-h-screen bg-aito-midnight pt-[64px] pb-[48px] text-aito-ink">
        <div className={CARD}>
          <TrackingLanguageSelect />
          <header className="text-center">
            <Logo className="mb-[20px]" />
            <h1 className="text-[23px] font-semibold tracking-tight">{t('aito.track.invalidTitle')}</h1>
            <p className="mt-[8px] text-[15px] text-aito-muted">{t('aito.track.invalidBody')}</p>
            {/* A code printed on the quote outlives any one link: the way
                back in is to type it. */}
            <Link
              to="/t"
              className={`mt-[20px] inline-flex min-h-[44px] items-center justify-center rounded-[8px] border border-aito-cyan/35 px-[24px] text-[14px] font-semibold text-aito-cyan hover:bg-aito-cyan/10 ${PRESS} ${FOCUS}`}
            >
              {t('aito.track.invalidEnterCode')}
            </Link>
          </header>
          <Footer at={TRACK_MOTION.footerAlone} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-aito-midnight pt-[64px] pb-[48px] text-aito-ink">
      <div className={CARD}>
        <TrackingLanguageSelect />
        <header className="text-center">
          <Logo className="mb-[20px]" />
          <h1 className="text-[23px] font-semibold tracking-tight">{t('aito.track.title')}</h1>
          {data?.reference && settled && (
            <p className="mt-[8px] text-[13.5px] text-aito-muted">{t('aito.track.reference', { ref: data.reference })}</p>
          )}
        </header>
        <main>
          {(query.isPending || !settled) && !query.isError && (
            <div className="mt-[32px] space-y-[32px]" aria-hidden="true">
              <div className="h-[64px] rounded-[12px] bg-aito-line/60 motion-safe:animate-pulse" />
              <div className="rounded-[12px] bg-aito-line/60 motion-safe:animate-pulse sm:min-h-[132px]" />
            </div>
          )}
          {query.isError && !is404 && (
            <div className="mt-[32px] text-center">
              <p className="text-[15px] text-aito-muted">{t('aito.track.error')}</p>
              <button
                type="button"
                onClick={() => query.refetch()}
                className={`mt-[16px] inline-flex min-h-[44px] items-center justify-center rounded-[8px] border border-aito-cyan/35 px-[24px] text-[14px] font-semibold text-aito-cyan hover:bg-aito-cyan/10 ${PRESS} ${FOCUS}`}
              >
                {t('aito.track.retry')}
              </button>
            </div>
          )}
          {showContent && (
            <div className={entrance ? 'animate-track-fade' : undefined} data-testid="track-content" data-entrance={entrance || undefined}>
              <div className="mt-[32px]">
                <TrackingRail column={data.column} shipped={data.shipping !== null} animate={entrance} />
              </div>
              <section
                data-testid="track-state"
                className={`relative mt-[32px] rounded-[12px] border px-[16px] py-[16px] transition-colors duration-150 sm:min-h-[132px] sm:px-[24px] sm:py-[16px] ${
                  preOrder ? 'border-aito-line bg-white/[.025]' : 'border-aito-cyan/35 bg-aito-cyan/10'
                } ${entrance ? 'animate-rise' : ''} ${entrance && finished ? 'animate-track-halo' : ''}`}
                style={entrance ? ({ ...delayAt(stateAt), '--track-halo-delay': `${stateAt + TRACK_MOTION.halo}ms` } as CSSProperties) : undefined}
              >
                <h2 className="text-[19px] font-semibold tracking-tight">{copy.title}</h2>
                <p className="mt-[8px] text-[15px] text-aito-muted">{copy.sub}</p>
                {eta && eta.kind !== 'none' && (
                  <div className="mt-[12px] border-t border-aito-line/60 pt-[12px]">
                    <p className="text-[12px] uppercase tracking-[.08em] text-aito-muted">{t('aito.track.eta')}</p>
                    <p className={eta.kind === 'date' ? 'mt-[4px] text-[17px] font-semibold text-aito-cyan' : 'mt-[4px] text-[15px] text-aito-ink'}>
                      {eta.text}
                    </p>
                  </div>
                )}
                <p className="mt-[8px] text-[13px] text-aito-muted/80">{t('aito.track.updated', { when: updatedAt(data.updated_at, t, lng) })}</p>
              </section>
              <section className="mt-[24px]">
                <h3
                  className={`mb-[16px] text-[12px] font-semibold uppercase tracking-[.08em] text-aito-muted ${entrance ? 'animate-rise' : ''}`}
                  style={entrance ? delayAt(stateAt + TRACK_MOTION.parts - TRACK_MOTION.partStep) : undefined}
                >
                  {t('aito.track.tasksHeading')}
                </h3>
                {(() => {
                  const foldable = data.tasks.length > PARTS_FOLD;
                  const folded = foldable && !showAllParts;
                  const shown = folded ? data.tasks.slice(0, PARTS_SHOWN) : data.tasks;
                  // Two cascades share one list: the first-load one (after the
                  // state card, 50 ms steps, capped at 7) and, for a list that
                  // was folded, the parts revealed by the button (40 ms steps).
                  // A revealed part rises even after a refetch — that is an
                  // interaction, not the entrance.
                  const revealed = (i: number) => foldable && i >= PARTS_SHOWN;
                  const partStyle = (i: number) =>
                    revealed(i)
                      ? delayAt(Math.min(i - PARTS_SHOWN, 7) * TRACK_MOTION.reveal)
                      : entrance
                        ? delayAt(stateAt + TRACK_MOTION.parts + Math.min(i, 7) * TRACK_MOTION.partStep)
                        : undefined;
                  return (
                    <>
                      <ul className="divide-y divide-aito-line/60 text-[15px]">
                        {shown.map((task, i) => (
                          <li
                            key={i}
                            className={`flex items-start justify-between gap-[12px] py-[12px] ${revealed(i) || entrance ? 'animate-rise' : ''}`}
                            style={partStyle(i)}
                          >
                            <span className="min-w-0">{task.title}</span>
                            {task.quantity !== null && (
                              <span className="min-w-[28px] shrink-0 text-right tabular-nums text-aito-muted">×{task.quantity}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                      {folded && (
                        <button
                          type="button"
                          onClick={() => setShowAllParts(true)}
                          className={`mt-[12px] inline-flex min-h-[44px] items-center rounded-[8px] text-[13.5px] font-semibold text-aito-cyan hover:text-aito-cyan/80 ${PRESS} ${FOCUS}`}
                        >
                          {t('aito.track.showAllParts', { n: data.tasks.length })}
                        </button>
                      )}
                    </>
                  );
                })()}
              </section>
              {data.invoice && (
                <div className={`mt-[32px] ${entrance ? 'animate-rise' : ''}`} style={entrance ? delayAt(stateAt + TRACK_MOTION.invoice) : undefined}>
                  <TrackingInvoice state={data.invoice} />
                </div>
              )}
            </div>
          )}
        </main>
        {showContent && <Footer at={entrance ? stateAt + TRACK_MOTION.footer : 0} />}
        {query.isError && !is404 && <Footer at={TRACK_MOTION.footerAlone} />}
      </div>
    </div>
  );
}
