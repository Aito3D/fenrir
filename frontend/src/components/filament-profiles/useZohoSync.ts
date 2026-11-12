import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';

import { api, ApiError } from '../../api/client';
import type { FilamentPresetZohoSyncResponse } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';

/** The header's "Sync Zoho prices" action and its last result. */
export function useZohoSync() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [zohoSyncing, setZohoSyncing] = useState(false);
  const [zohoResult, setZohoResult] = useState<FilamentPresetZohoSyncResponse | null>(null);

  // ── Sync prices from Zoho ────────────────────────────────────────────────
  // T-033: zoho_filaments' own comment documents a ~400s cold-cache worst case
  // (20 pages x 2 attempts x 10s). 10 minutes gives comfortable headroom above
  // that so a legitimate sync is never killed, while a connection dropped
  // without a reset (proxy idle-kill, laptop sleep) still recovers the button
  // instead of leaving it dead until reload.
  const ZOHO_SYNC_DEADLINE_MS = 600_000;

  const handleZohoSync = async () => {
    setZohoSyncing(true);
    setZohoResult(null);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), ZOHO_SYNC_DEADLINE_MS);
    try {
      const result = await api.syncFilamentPresetsFromZoho(controller.signal);
      setZohoResult(result);
      // A run that priced nothing must not read as a success: report the
      // needs-attention count in the toast text itself (the detail panel with
      // the full breakdown lives further down the page, off-screen on a
      // normal viewport) and downgrade the toast color whenever some
      // profiles couldn't be priced or nothing was priced/unchanged at all.
      const doneMessage = t('filamentProfiles.syncZohoDone', { priced: result.priced, unchanged: result.unchanged });
      // T-038: the true count, not the (possibly truncated) attention array's
      // length — a capped run must not read as "fewer profiles needed
      // review" than it actually did.
      const attentionCount = result.attention_total;
      // T-034: Zoho was unreachable and this catalogue came from fetch_catalogue's
      // failure-branch stale-cache fallback, with no upper bound on its age — the
      // sync still ran and wrote (see the route), but the toast must disclose
      // that instead of reading exactly like a live, fully successful sync.
      const staleMessage = result.catalogue_stale_since
        ? t('filamentProfiles.syncZohoStale', { timestamp: new Date(result.catalogue_stale_since).toLocaleString() })
        : null;
      const toastMessage = [doneMessage]
        .concat(attentionCount > 0 ? [t('filamentProfiles.syncZohoAttention', { count: attentionCount })] : [])
        .concat(staleMessage ? [staleMessage] : [])
        .join(' — ');
      const isFullSuccess = attentionCount === 0 && result.priced + result.unchanged > 0 && !staleMessage;
      showToast(toastMessage, isFullSuccess ? 'success' : 'warning');
    } catch (error) {
      setZohoResult(null);
      // T-047: /zoho-sync commits its write server-side before it responds,
      // so only a definite HTTP error *response* (an `ApiError` — the server
      // told us it did NOT apply, e.g. 409/502/503) means the sync really
      // failed. Every other failure mode here — the client-side deadline's
      // AbortError, or a network failure (fetch throwing a plain `TypeError`
      // before any response arrives) — means the response was lost, not
      // that the write never landed. Those get an "unknown outcome" toast
      // instead of a definite "failed" one; either way the `finally` below
      // refetches so the grid/editor stop serving the stale pre-sync cache.
      const isApiError = error instanceof ApiError;
      showToast(isApiError ? error.message : t('filamentProfiles.syncZohoUnknown'), 'error');
    } finally {
      // T-047: invalidate on every path, not just success — a lost response
      // doesn't mean the server didn't commit the sync, so the failure/abort
      // paths must refetch too instead of leaving the grid and any open
      // editor on the pre-sync snapshot (which a subsequent Save would then
      // PATCH straight back over the committed price).
      await queryClient.invalidateQueries({ queryKey: ['filamentPresets'] });
      clearTimeout(deadline);
      setZohoSyncing(false);
    }
  };

  return { zohoSyncing, zohoResult, handleZohoSync };
}
