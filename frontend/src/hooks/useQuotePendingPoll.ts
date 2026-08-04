import { useRef } from 'react';
import type { AitoProject } from '../api/client';
import type { useBoardSync } from './useBoardSync';

// The board poll exists for exactly one visible thing: CardView's
// "Creating quote…" placeholder (aito.quotePending), which only renders when
// `!quote_number && quote_sync_state === 'pending'` — see CardView.tsx. A
// card that already has a quote number has nothing left for this poll to
// reveal, even if an ordinary task edit re-marks it pending (see
// `_mark_pending_if_ours` in aito.py); polling for it would just be up to
// thirty extra full-board GETs (the ~5 minute bound below, at one fetch per
// QUOTE_POLL_INTERVAL_MS) for a card whose screen never changes.
const QUOTE_POLL_INTERVAL_MS = 10_000;
// `pending` is cleared only by the Zoho sync worker, and the worker is
// gated behind `aito_quote_sync_enabled` — a supported operator setting that
// can be off, or Zoho credentials can be pulled entirely. In either case
// nothing will ever clear `pending`, so "it will resolve eventually" is not
// guaranteed and this poll must not run forever. Five minutes is comfortably
// past the worker's own ~60s cadence when it IS running, so a healthy worker
// is never cut off before it resolves.
const QUOTE_POLL_MAX_MS = 5 * 60 * 1000;

/** Just the shape this poll reads off the `useQuery` `refetchInterval`
 *  callback's `query` argument — narrower than React Query's own `Query`
 *  type so this file does not need to know the board query's full generic
 *  signature. */
interface QuotePendingPollQuery {
  state: { data: AitoProject[] | undefined };
}

/** Builds the `refetchInterval` callback for the `['aito-projects']` query —
 *  see the constants above for why this poll exists and why it is bounded.
 *  Returns a fresh closure every render (not wrapped in `useCallback`): React
 *  Query re-reads `refetchInterval` on every evaluation regardless, and the
 *  two refs below are what carry state across evaluations, not the closure
 *  identity. */
export function useQuotePendingPoll(boardSync: ReturnType<typeof useBoardSync>) {
  // Wall-clock deadline for the current poll run, cleared the instant no
  // card matches and (re)set whenever a card starts matching that was not
  // matching on the previous evaluation — so a later card that starts a
  // fresh import gets its own full run at the poll rather than being cut off
  // by a budget an earlier, still-stuck card already spent (the deadline is
  // shared, not per-card: a new match resets it for whatever else is still
  // pending too, which is fine — it just means a genuinely new event gives
  // the whole poll another chance). Deadline rather than a tick counter:
  // React Query can re-evaluate `refetchInterval` more than once per actual
  // fetch, which would burn a fixed tick budget faster than real time
  // actually elapses.
  const pollDeadlineRef = useRef<number | null>(null);
  // The matching id set as of the previous `refetchInterval` evaluation —
  // what "not matching on the previous evaluation" above is compared
  // against. Keying off ids (not just a boolean) is what lets a new card
  // reset the deadline even while an old one is still matching too; a plain
  // boolean can only ever go true -> true across that transition and would
  // never notice the new arrival.
  const pollMatchingIdsRef = useRef<Set<number>>(new Set());

  return (query: QuotePendingPollQuery) => {
    // A board write's `onMutate` writes its optimistic value into this
    // same cache entry BEFORE this function is asked to run again (writing
    // to the cache is itself what re-triggers this evaluation — see
    // QueryObserver.onQueryUpdate). A poll tick landing inside that
    // write's [onMutate, onSettled] window would issue a fresh GET that
    // overwrites the optimistic entry with data that predates the write,
    // with no ring and no toast — silent, not merely stale. Skipping here,
    // rather than after computing `matchingIds`, is deliberate: it must
    // leave `pollDeadlineRef`/`pollMatchingIdsRef` exactly as they were, so
    // a skipped tick neither consumes the deadline's budget nor loses the
    // "was this id already matching" state that `hasNewMatch` depends on.
    // The write's own `settle()` invalidates once it finishes, which
    // re-triggers this function and lets the poll resume exactly where it
    // left off.
    if (!boardSync.isIdle()) return false;
    const matchingIds = new Set(
      (query.state.data ?? [])
        .filter((p) => !p.quote_number && p.quote_sync_state === 'pending')
        .map((p) => p.id),
    );
    if (matchingIds.size === 0) {
      pollDeadlineRef.current = null;
      pollMatchingIdsRef.current = matchingIds;
      return false;
    }
    const now = Date.now();
    const hasNewMatch = [...matchingIds].some((id) => !pollMatchingIdsRef.current.has(id));
    if (pollDeadlineRef.current === null || hasNewMatch) {
      pollDeadlineRef.current = now + QUOTE_POLL_MAX_MS;
    }
    pollMatchingIdsRef.current = matchingIds;
    if (now >= pollDeadlineRef.current) return false;
    return QUOTE_POLL_INTERVAL_MS;
  };
}
