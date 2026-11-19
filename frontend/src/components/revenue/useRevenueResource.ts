import { useEffect, useState } from 'react';
import { bearerAuthHeaders } from '../../api/client';
import { createSeriesLoader } from './lib/dashboard';

/**
 * One revenue read for a panel: fetched when `url` or `version` moves, revalidated with the last
 * ETag (a 304 keeps the rendered data), an overtaken answer dropped. `url` null fetches nothing.
 * Data from a previous URL stays on screen but reads as loading until the new answer lands;
 * `dataUrl` names the URL `data` was loaded from (kept through a 304 and a failure).
 */
export function useRevenueResource<T>(
  url: string | null,
  version: unknown,
): { data: T | null; dataUrl: string | null; error: string | null; loading: boolean; reload: () => void } {
  const [loader] = useState(() => createSeriesLoader<T>(bearerAuthHeaders));
  const [state, setState] = useState<{ url: string | null; data: T | null; dataUrl: string | null; error: string | null }>({
    url: null,
    data: null,
    dataUrl: null,
    error: null,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    loader.load(url).then(
      (r) => {
        if (cancelled || r.status === 'stale') return;
        setState((s) => (r.status === 'data' ? { url, data: r.payload, dataUrl: url, error: null } : { ...s, url, error: null }));
      },
      (e: unknown) => {
        if (!cancelled) setState((s) => ({ ...s, url, error: e instanceof Error ? e.message : String(e) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loader, url, version, tick]);
  const reload = () => {
    loader.reset();
    setTick((t) => t + 1);
  };
  return { data: state.data, dataUrl: state.dataUrl, error: state.url === url ? state.error : null, loading: url !== null && state.url !== url, reload };
}
