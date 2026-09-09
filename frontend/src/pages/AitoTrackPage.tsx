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
import { TRACK_MOTION, etaCopy, statusCopy, trackStageIndex, trackStages, trackStateDelay, updatedAt } from '../utils/aitoTracking';
import type { AitoColumnId } from '../api/client';

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
  // "Réessayer" in flight. Tracked here, not read off the query: a refetch
  // of an errored query with no data drops back to `pending` (TanStack v5),
  // which would swap the error for the skeleton and back — a flash where
  // the client needs to see the button they pressed doing something.
  const [retrying, setRetrying] = useState(false);
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
  // The story's next chapter: a refetch (window focus, past the stale time)
  // that brings a LATER stage — the client left the tab open and their
  // order advanced. The rail replays its walk from the node that was
  // current, and the state card rises again; the parts and the footer did
  // not change and stay still. Same render-time ref gate as `firstData`, so
  // React's double render in dev sees the same answer twice. A column that
  // went BACK (a step re-opened) simply re-renders: nothing to celebrate.
  const lastColumn = useRef<AitoColumnId | undefined>(undefined);
  const advanceRef = useRef<{ from: number; seq: number } | null>(null);
  if (data && settled) {
    if (lastColumn.current === undefined) lastColumn.current = data.column;
    else if (lastColumn.current !== data.column) {
      const from = trackStageIndex(lastColumn.current);
      const to = trackStageIndex(data.column);
      advanceRef.current = to > from ? { from, seq: (advanceRef.current?.seq ?? 0) + 1 } : null;
      lastColumn.current = data.column;
    }
  }
  const advance = entrance ? null : advanceRef.current;
  const copy = data ? statusCopy(data, t, lng) : null;
  const eta = data ? etaCopy(data, t, lng) : null;
  const preOrder = data?.column === 'devis' || data?.column === 'waiting';
  const finished = data?.column === 'done';
  const current = data ? trackStages(data.shipping !== null, t).findIndex((s) => s.id === data.column) : 0;
  // Where the rail's choreography starts: node 0 on the first data, the old
  // current node on an advance, nowhere otherwise.
  const origin = entrance ? 0 : advance?.from;
  const moving = origin !== undefined;
  const stateAt = trackStateDelay(current, origin ?? 0);
  const is404 = query.error instanceof ApiError && query.error.status === 404;
  // Past the route's rate limit: say "wait", as the code-entry page does —
  // "cannot load, try again" would only send the client straight back into it.
  const is429 = query.error instanceof ApiError && query.error.status === 429;
  const showContent = data !== undefined && copy !== null && settled;
  const showError = (query.isError || retrying) && !is404 && data === undefined;
  const retry = () => {
    setRetrying(true);
    void query.refetch().finally(() => setRetrying(false));
  };

  if (is404 && settled) {
    return (
      <div className="min-h-screen bg-aito-midnight pt-[64px] pb-[48px] text-aito-ink">
        <div className={CARD}>
          <TrackingLanguageSelect />
          {/* The same fade-and-rise contract as every other state of the
              page: the skeleton must never be swapped for this in one frame. */}
          <header className="animate-track-fade text-center" data-testid="track-invalid">
            <Logo className="mb-[20px]" />
            <h1 className="animate-rise text-[23px] font-semibold tracking-tight" style={delayAt(TRACK_MOTION.invalidTitle)}>
              {t('aito.track.invalidTitle')}
            </h1>
            <p className="animate-rise mt-[8px] text-[15px] text-aito-muted" style={delayAt(TRACK_MOTION.invalidBody)}>
              {t('aito.track.invalidBody')}
            </p>
            {/* A code printed on the quote outlives any one link: the way
                back in is to type it. */}
            <Link
              to="/t"
              style={delayAt(TRACK_MOTION.invalidLink)}
              className={`animate-rise mt-[20px] inline-flex min-h-[44px] items-center justify-center rounded-[8px] border border-aito-cyan/35 px-[24px] text-[14px] font-semibold text-aito-cyan hover:bg-aito-cyan/10 ${PRESS} ${FOCUS}`}
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
          {(query.isPending || !settled) && !query.isError && !retrying && (
            <div className="mt-[32px] space-y-[32px]" aria-hidden="true">
              <div className="h-[64px] rounded-[12px] bg-aito-line/60 motion-safe:animate-pulse" />
              <div className="rounded-[12px] bg-aito-line/60 motion-safe:animate-pulse sm:min-h-[132px]" />
            </div>
          )}
          {showError && (
            <div className="mt-[32px] text-center">
              {/* Keyed on the failure, so a retry that fails again re-delivers
                  the same words with a fade instead of leaving them frozen —
                  the client must see that their tap was heard. */}
              <p key={query.errorUpdatedAt} className="animate-track-fade text-[15px] text-aito-muted" data-testid="track-error">
                {t(is429 ? 'aito.track.codeTooMany' : 'aito.track.error')}
              </p>
              <button
                type="button"
                disabled={retrying}
                onClick={retry}
                className={`mt-[16px] inline-flex min-h-[44px] items-center justify-center rounded-[8px] border border-aito-cyan/35 px-[24px] text-[14px] font-semibold text-aito-cyan transition-[color,background-color,transform,opacity] duration-150 hover:bg-aito-cyan/10 active:scale-[0.97] disabled:opacity-60 ${FOCUS}`}
              >
                {t(retrying ? 'aito.track.retrying' : 'aito.track.retry')}
              </button>
            </div>
          )}
          {showContent && (
            <div className={entrance ? 'animate-track-fade' : undefined} data-testid="track-content" data-entrance={entrance || undefined}>
              <div className="mt-[32px]">
                <TrackingRail column={data.column} shipped={data.shipping !== null} animateFrom={origin} />
              </div>
              {/* Keyed on the advance, so the card remounts and rises again
                  for each new stage — the classes alone would not replay. */}
              <section
                key={advance?.seq ?? 0}
                data-testid="track-state"
                className={`relative mt-[32px] rounded-[12px] border px-[16px] py-[16px] transition-colors duration-150 sm:min-h-[132px] sm:px-[24px] sm:py-[16px] ${
                  preOrder ? 'border-aito-line bg-white/[.025]' : 'border-aito-cyan/35 bg-aito-cyan/10'
                } ${moving ? 'animate-rise' : ''} ${moving && finished ? 'animate-track-halo' : ''}`}
                style={moving ? ({ ...delayAt(stateAt), '--track-halo-delay': `${stateAt + TRACK_MOTION.halo}ms` } as CSSProperties) : undefined}
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
        {showError && <Footer at={TRACK_MOTION.footerAlone} />}
      </div>
    </div>
  );
}
