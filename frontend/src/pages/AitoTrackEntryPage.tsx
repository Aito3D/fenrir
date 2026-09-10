import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { TrackingLanguageSelect } from '../components/aito/TrackingLanguageSelect';
import { TrackingCodeInput } from '../components/aito/TrackingCodeInput';
import { Footer, Logo } from '../components/aito/trackingShell';
import { useTrackingLanguage } from '../hooks/useTrackingLanguage';
import { ENTRY_MOTION, TRACK_MOTION } from '../utils/aitoTracking';
import { prefersReducedMotion } from '../utils/motion';
import { CODE_LENGTH, type CodeState } from '../utils/trackingCode';
import { CARD, delayAt } from '../utils/trackingShell';

type Failure = 'notFound' | 'tooMany' | 'error';

/** A hung check (request accepted, never answered — a flaky mobile link)
 *  must not leave the squares in "checking" forever with no way out: after
 *  this long, abort and fall into the same retryable error state a network
 *  failure already shows. */
const CHECK_TIMEOUT_MS = 10_000;

/** The front door of client tracking: `/t` with no code. A client holding
 *  the six characters from a quote or a message types them into six
 *  squares; the sixth one sends the code, and a recognised code carries
 *  them straight to their page — no button, nothing else to find.
 *
 *  The check is the tracking route itself, so a wrong code costs one
 *  request and the answer is seeded into the query cache under the same key
 *  the tracking page reads: the page that opens next paints from it and
 *  the visit is logged once, not twice. A 404 shakes the squares and says
 *  so; a 429 (the route's rate limit) says to wait; anything else offers
 *  Enter to retry. Motion lives in index.css under "tracking code entry";
 *  ENTRY_MOTION holds the one delay the page itself must know, the moment
 *  the squares have finished lighting up and it may leave. */
export function AitoTrackEntryPage() {
  const { t, ready } = useTrackingLanguage();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const hintId = useId();
  const statusId = useId();
  const [code, setCode] = useState('');
  const [state, setState] = useState<CodeState>('idle');
  const [failure, setFailure] = useState<Failure | null>(null);
  // A late answer to a code that has since been edited must not land on
  // the new one: each check carries a sequence number and only the latest
  // may speak.
  const sequence = useRef(0);
  const leaveTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    },
    [],
  );

  const check = async (value: string) => {
    const seq = ++sequence.current;
    setState('checking');
    setFailure(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const data = await api.getAitoTracking(value, controller.signal);
      if (seq !== sequence.current) return;
      queryClient.setQueryData(['aito-track', value], data);
      setState('found');
      const wait = prefersReducedMotion() ? 0 : ENTRY_MOTION.leaveAt;
      leaveTimer.current = window.setTimeout(() => navigate(`/t/${value}`), wait);
    } catch (err) {
      if (seq !== sequence.current) return;
      setState('error');
      setFailure(
        err instanceof DOMException && err.name === 'AbortError'
          ? 'error'
          : err instanceof ApiError && err.status === 404
            ? 'notFound'
            : err instanceof ApiError && err.status === 429
              ? 'tooMany'
              : 'error',
      );
    } finally {
      window.clearTimeout(timeout);
    }
  };
  const onChange = (next: string) => {
    if (next === code) return;
    setCode(next);
    setFailure(null);
    if (next.length === CODE_LENGTH) void check(next);
    else setState('idle');
  };

  // The first paint waits on the locale chunk (French, the tracking default,
  // ships lazily like every non-English bundle — see i18n/index.ts). Rather
  // than a bare rectangle, show the same card and logo the ready state uses,
  // with a skeleton standing in for the code row: no text (nothing is
  // translated yet) and no motion (ENTRY_MOTION plays only from the
  // ready-state mount, below).
  if (!ready) {
    return (
      <div className="min-h-screen bg-aito-midnight pt-[64px] pb-[48px] text-aito-ink">
        <div className={CARD}>
          <header className="text-center">
            <Logo className="mb-[20px]" />
          </header>
          <div className="mt-[32px] space-y-[32px]" aria-hidden="true">
            <div className="h-[64px] rounded-[12px] bg-aito-line/60 motion-safe:animate-pulse" />
            <div className="rounded-[12px] bg-aito-line/60 motion-safe:animate-pulse sm:min-h-[132px]" />
          </div>
        </div>
      </div>
    );
  }

  const status =
    state === 'checking'
      ? t('aito.track.codeChecking')
      : state === 'found'
        ? t('aito.track.codeFound')
        : failure === 'notFound'
          ? t('aito.track.codeNotFound')
          : failure === 'tooMany'
            ? t('aito.track.codeTooMany')
            : failure === 'error'
              ? t('aito.track.codeError')
              : '';
  return (
    <div className="min-h-screen bg-aito-midnight pt-[64px] pb-[48px] text-aito-ink">
      <div className={CARD}>
        <TrackingLanguageSelect />
        <header className="text-center">
          <Logo className="mb-[20px]" />
          <h1 className="animate-rise text-[23px] font-semibold tracking-tight" style={delayAt(ENTRY_MOTION.title)}>
            {t('aito.track.enterTitle')}
          </h1>
          <p id={hintId} className="animate-rise mt-[8px] text-[15px] text-aito-muted" style={delayAt(ENTRY_MOTION.hint)}>
            {t('aito.track.enterHint')}
          </p>
        </header>
        <main className="mt-[32px]">
          <TrackingCodeInput
            value={code}
            state={state}
            label={t('aito.track.codeLabel')}
            describedBy={`${hintId} ${statusId}`}
            onChange={onChange}
            onSubmit={() => void check(code)}
          />
          {/* Reserved height: the message must never push the squares. */}
          <p
            id={statusId}
            role="status"
            aria-live="polite"
            data-testid="track-code-status"
            className={`mt-[20px] min-h-[24px] text-center text-[14px] transition-colors duration-150 ${
              state === 'error' ? 'text-red-300' : state === 'found' ? 'text-aito-cyan' : 'text-aito-muted'
            }`}
          >
            {status}
          </p>
        </main>
        <Footer at={TRACK_MOTION.footerAlone} />
      </div>
    </div>
  );
}
