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
    try {
      const data = await api.getAitoTracking(value);
      if (seq !== sequence.current) return;
      queryClient.setQueryData(['aito-track', value], data);
      setState('found');
      const wait = prefersReducedMotion() ? 0 : ENTRY_MOTION.leaveAt;
      leaveTimer.current = window.setTimeout(() => navigate(`/t/${value}`), wait);
    } catch (err) {
      if (seq !== sequence.current) return;
      setState('error');
      setFailure(err instanceof ApiError && err.status === 404 ? 'notFound' : err instanceof ApiError && err.status === 429 ? 'tooMany' : 'error');
    }
  };
  const onChange = (next: string) => {
    if (next === code) return;
    setCode(next);
    setFailure(null);
    if (next.length === CODE_LENGTH) void check(next);
    else setState('idle');
  };

  if (!ready) return <div className="min-h-screen bg-aito-midnight" />;

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
