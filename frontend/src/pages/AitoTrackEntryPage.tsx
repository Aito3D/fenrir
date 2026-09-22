import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { TrackingLanguageSelect } from '../components/aito/TrackingLanguageSelect';
import { TrackingCodeInput } from '../components/aito/TrackingCodeInput';
import { CardSkeleton, Footer, Logo } from '../components/aito/trackingShell';
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

// The locale chunk fetch behind `ready` below has the same failure mode as
// a hung check — a stalled connection that never errors — so it gets the
// same deadline: past this, i18next's bundled English strings stand in
// rather than leave the entry door stuck on a skeleton with no way in.
const I18N_SETTLE_TIMEOUT_MS = 10_000;

// The outer wrapper shared by every state of this page (loading branch
// and main return): the same literal, not re-typed at each call site.
const PAGE = 'min-h-screen bg-aito-midnight pt-[64px] pb-[48px] text-aito-ink';

/** Why a check failed, in the one word the status line needs. Only the two
 *  answers the route itself gives are named: an unknown code (404) and the
 *  rate limit (429). Everything else — a dead network, a timeout aborted by
 *  CHECK_TIMEOUT_MS, a 500 — is the same retryable failure, because the code
 *  the client typed was never judged. */
function classifyFailure(err: unknown): Failure {
  if (err instanceof ApiError && err.status === 404) return 'notFound';
  if (err instanceof ApiError && err.status === 429) return 'tooMany';
  return 'error';
}

/** The colour the status line speaks in: red for a refusal, cyan for the
 *  code that worked, muted while the check is still out or nothing has
 *  happened yet. */
const STATUS_TONE: Record<CodeState, string> = {
  idle: 'text-aito-muted',
  checking: 'text-aito-muted',
  found: 'text-aito-cyan',
  error: 'text-red-300',
};

/** The line under the squares: what the check is doing, or why it stopped.
 *  Null while the client is still typing — the line stays empty but keeps
 *  its height. */
function statusKey(state: CodeState, failure: Failure | null): string | null {
  if (state === 'checking') return 'aito.track.codeChecking';
  if (state === 'found') return 'aito.track.codeFound';
  switch (failure) {
    case 'notFound':
      return 'aito.track.codeNotFound';
    case 'tooMany':
      return 'aito.track.codeTooMany';
    case 'error':
      return 'aito.track.codeError';
    default:
      return null;
  }
}

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
  // A stalled locale chunk must not leave the front door stuck on a
  // skeleton forever: once this fires, the page proceeds with i18next's
  // bundled English strings even though `ready` never went true.
  const [i18nTimedOut, setI18nTimedOut] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setI18nTimedOut(true), I18N_SETTLE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, []);

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
      setFailure(classifyFailure(err));
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
  if (!ready && !i18nTimedOut) {
    return (
      <div className={PAGE}>
        <div className={CARD}>
          <header className="text-center">
            <Logo className="mb-[20px]" />
          </header>
          <CardSkeleton />
        </div>
      </div>
    );
  }

  const status = statusKey(state, failure);
  return (
    <div className={PAGE}>
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
            className={`mt-[20px] min-h-[24px] text-center text-[14px] transition-colors duration-150 ${STATUS_TONE[state]}`}
          >
            {status ? t(status) : ''}
          </p>
        </main>
        <Footer at={TRACK_MOTION.footerAlone} />
      </div>
    </div>
  );
}
