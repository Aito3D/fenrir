// The chunked, timeout-guarded, QueryClient-persisted Zoho filament sync walk
// used by CalculatorFilamentsPanel's sync button. Pulled out of that file
// (T-002) so the panel owns only listing/form/dialog wiring; this hook has no
// dependency on the table/form rendering beyond the filaments list it uses to
// seed the initial progress denominator.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CalculatorFilament, type CalculatorFilamentSyncResult } from '../../api/client';

/** Rows per sync request. Small enough that one chunk stays well inside the
 *  request timeout even when every row needs a Zoho lookup. */
const SYNC_CHUNK_SIZE = 25;

/** Per-chunk request budget (T-075). The backend's own Zoho calls are capped
 *  at 10 s each (see `zoho.py`'s `httpx.AsyncClient(timeout=10.0)`), and a
 *  chunk only ever triggers more than one of those when the 10-minute
 *  catalogue cache is cold, in which case `fetch_catalogue` pages it in up to
 *  `_MAX_PAGES` (20) page fetches — a real but rare worst case of a few tens
 *  of seconds. 60 s comfortably covers that case (and any ordinary slow
 *  network) while still bounding how long a chunk that will genuinely never
 *  settle can wedge the sync button. Ending on a timeout is exactly the
 *  existing failure path below — same catch, same guard release.
 */
const SYNC_CHUNK_TIMEOUT_MS = 60_000;

/** Distinguishes a `withTimeout` timeout from any other chunk failure (T-096)
 *  without matching on `message` text, which is only ever used for `instanceof`
 *  checks below — the user-facing wording lives entirely in the i18n layer. */
class SyncTimeoutError extends Error {
  constructor() {
    super('sync request timed out');
    this.name = 'SyncTimeoutError';
  }
}

/** Rejects with a `SyncTimeoutError` if `promise` has not settled within `ms`,
 *  otherwise resolves/rejects exactly as `promise` does. Never touches
 *  `promise` itself — a timeout does not cancel or abort the underlying
 *  request, it only stops the walk from waiting on it forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SyncTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Where the walk's in-flight guard/progress lives. CalculatorPage
 *  mounts/unmounts this panel per tab switch, but the walk itself is a plain
 *  async loop that keeps running regardless — parking the guard in the
 *  QueryClient's cache instead of component state means a remount reattaches
 *  to whatever is already there rather than losing it, and a second mount
 *  cannot start an overlapping walk. The QueryClient itself is created once
 *  for the app's lifetime (App.tsx), so this is effectively session-scoped,
 *  not component-scoped.
 *
 *  The completed summary and any error are deliberately NOT kept here: they
 *  live in this hook's own state below, exactly as before T-075, so a
 *  walk that ended while the panel was unmounted reports nothing on remount
 *  and a fresh mount always starts clean — only the live progress and the
 *  "a walk is running" guard survive a remount. */
const ZOHO_SYNC_PROGRESS_KEY = ['calculatorFilamentZohoSyncProgress'] as const;

type ZohoSyncProgress = { done: number; total: number } | null;

/** Runs and tracks the chunked Zoho filament price sync walk for
 *  CalculatorFilamentsPanel's sync button.
 *
 *  `filaments` is only used to seed the initial progress denominator (how
 *  many rows are already linked) before the first chunk's server-side COUNT
 *  takes over. */
export function useZohoFilamentSync(filaments: CalculatorFilament[]) {
  const queryClient = useQueryClient();

  // Backed by the QueryClient cache (see ZOHO_SYNC_PROGRESS_KEY above), not
  // useState, so this survives the panel unmounting mid-walk. `queryFn` only
  // matters for the very first observer in the app session — after that,
  // every update is a direct `setQueryData` push from `runSync` below, and
  // `staleTime`/`gcTime: Infinity` keep React Query from ever refetching or
  // discarding it on its own.
  const { data: syncProgress = null } = useQuery<ZohoSyncProgress>({
    queryKey: ZOHO_SYNC_PROGRESS_KEY,
    queryFn: () => queryClient.getQueryData<ZohoSyncProgress>(ZOHO_SYNC_PROGRESS_KEY) ?? null,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Unlike the guard/progress above, the completed summary and any error are
  // ordinary component state: a walk that finishes (or fails) while the panel
  // is unmounted has nothing listening for it, and a remount starts clean —
  // matching the panel's pre-T-075 behavior for these two.
  const [syncSummary, setSyncSummary] = useState<CalculatorFilamentSyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  // Set alongside `syncError` only when the walk ended via `withTimeout`
  // (T-096): `withTimeout` never aborts the underlying request, so a timeout
  // is not a real failure — the chunk may still commit after the walk gives
  // up on it. Gates the indeterminate wording below instead of the flat
  // "failed" one.
  const [syncTimedOut, setSyncTimedOut] = useState(false);

  // Chunking is client-driven and pages by id (keyset), not by offset: each
  // request commits its own work, so a failure partway through leaves the
  // earlier chunks applied and `next_after_id` is where a retry resumes.
  // Paging by id rather than offset means a filament deleted mid-run cannot
  // shift the remaining rows and cause one to be silently skipped.
  const runSync = async () => {
    // Belt and braces: the button is already disabled while a walk is live,
    // but this is what actually stops a second walk from starting, from any
    // mount — the button's `disabled` prop is just what makes that visible.
    if (queryClient.getQueryData<ZohoSyncProgress>(ZOHO_SYNC_PROGRESS_KEY)) return;
    setSyncSummary(null);
    setSyncError(null);
    setSyncTimedOut(false);
    // Seed the denominator from what we already know is linked, so the button
    // never sits at "0 / 0" for the seconds the first chunk takes; the server's
    // own COUNT takes over from that chunk onwards.
    queryClient.setQueryData<ZohoSyncProgress>(ZOHO_SYNC_PROGRESS_KEY, {
      done: 0,
      total: filaments.filter((f) => f.zoho_item_id).length,
    });
    const totals = { processed: 0, total: 0, updated: 0, unchanged: 0, skipped_no_price: 0, missing: 0 };
    let afterId: number | null = 0;
    try {
      while (afterId !== null) {
        // T-075: a chunk that never settles (network black hole — nothing
        // guards against that on the browser's own `fetch`) would otherwise
        // leave this loop, and therefore the guard above, stuck forever.
        const chunk: CalculatorFilamentSyncResult = await withTimeout(
          api.syncCalculatorFilamentsFromZoho(afterId, SYNC_CHUNK_SIZE),
          SYNC_CHUNK_TIMEOUT_MS,
        );
        totals.processed += chunk.processed;
        totals.updated += chunk.updated;
        totals.unchanged += chunk.unchanged;
        totals.skipped_no_price += chunk.skipped_no_price;
        totals.missing += chunk.missing;
        totals.total = chunk.total;
        // `total` is a fresh COUNT on every chunk, so rows added or deleted
        // mid-walk make it drift. Never let the denominator fall behind what
        // has already been processed — "50 / 12" would read as a bug.
        queryClient.setQueryData<ZohoSyncProgress>(ZOHO_SYNC_PROGRESS_KEY, {
          done: totals.processed,
          total: Math.max(chunk.total, totals.processed),
        });
        // A last chunk can legitimately report processed: 0 — its lookahead
        // sentinel row was deleted in between. Only next_after_id ends the walk.
        const prev = afterId;
        afterId = chunk.next_after_id;
        // The cursor must strictly increase (the backend pages WHERE id >
        // after_id), and nothing today returns otherwise. But if it ever did,
        // this loop would hammer the server with hundreds of COUNT-plus-commit
        // requests a second behind a disabled button with no way out. Throwing
        // hands it to the catch below: the operator gets a truthful stop and
        // the partial work is refetched, instead of a hung tab.
        if (afterId !== null && afterId <= prev) {
          throw new Error(`sync did not advance past id ${prev}`);
        }
      }
      setSyncSummary({ ...totals, next_after_id: null });
      queryClient.invalidateQueries({ queryKey: ['calculatorFilaments'] });
    } catch (error) {
      // The chunks that did land are already committed server-side; refetch so
      // the table shows the partial result instead of the pre-sync prices.
      const timedOut = error instanceof SyncTimeoutError;
      setSyncTimedOut(timedOut);
      setSyncError(error instanceof Error ? error.message : String(error));
      queryClient.invalidateQueries({ queryKey: ['calculatorFilaments'] });
      if (timedOut) {
        // `withTimeout` never aborts the request that timed out, so it is
        // still running server-side and may commit further prices after this
        // walk has already given up and refetched above. Re-invalidate again
        // once it has had the same worst-case window to land, so the table
        // picks those up too instead of being stuck on whatever the
        // immediate refetch caught mid-flight.
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['calculatorFilaments'] });
        }, SYNC_CHUNK_TIMEOUT_MS);
      }
    } finally {
      // Always releases the guard — success, a reported failure, or a chunk
      // that timed out all end the walk the same way.
      queryClient.setQueryData<ZohoSyncProgress>(ZOHO_SYNC_PROGRESS_KEY, null);
    }
  };

  return { syncProgress, syncSummary, syncError, syncTimedOut, runSync };
}
