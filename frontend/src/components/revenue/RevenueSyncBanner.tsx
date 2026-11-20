import { useTranslation } from 'react-i18next';
import { focusRingCls } from '../formStyles';
import { bannerState } from './lib/dashboard';
import type { RevenueSyncStatus } from './lib/types';

const linkCls = `underline underline-offset-2 hover:text-white disabled:opacity-50 disabled:no-underline ${focusRingCls}`;

/** The sync line under the page title: idle (cache up to date), progress (back-fill bar) or error
 *  (an error always wins). Retry needs `revenue:sync`; the full rebuild lives in the page's ⋯ menu. */
export function RevenueSyncBanner({
  sync,
  canSync,
  onRetry,
  mismatches = 0,
}: {
  sync: RevenueSyncStatus;
  canSync: boolean;
  onRetry: () => void;
  /** Closed months whose cached total differs from Zoho's. */
  mismatches?: number;
}) {
  const { t, i18n } = useTranslation();
  const { kind, pctDone } = bannerState(sync);
  const hm = (iso: string) => new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
  const dayLabel = (day: string) =>
    new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
  // One day: name it and its retry; several: the count and the earliest retry. An error line already says enough.
  const failed = sync.failedDays;
  const failedNote =
    failed.length > 0 && !sync.lastError ? (
      <span className="text-amber-700 dark:text-amber-400">
        {sync.failedCount === 1
          ? t('revenue.sync.failedDay', { day: dayLabel(failed[0].day), time: hm(failed[0].nextRetryAt) })
          : t('revenue.sync.failedDays', {
              n: sync.failedCount,
              time: hm(failed.map((f) => f.nextRetryAt).reduce((a, b) => (new Date(b) < new Date(a) ? b : a))),
            })}
      </span>
    ) : null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-bambu-gray">
      {kind === 'idle' ? (
        <span>
          <span aria-hidden="true" className="mr-1.5 inline-block h-2 w-2 rounded-full bg-bambu-green" />
          {t('revenue.sync.upToDate', { days: sync.fetchedDays })}
          {sync.lastBatchAt && ` · ${t('revenue.sync.lastSync', { time: hm(sync.lastBatchAt) })}`}
          {sync.legacyDays > 0 && (
            <span className="text-blue-400">
              {' · '}
              {t('revenue.sync.legacy', { done: sync.fetchedDays - sync.legacyDays, total: sync.fetchedDays })}
            </span>
          )}
          {failedNote && <> · {failedNote}</>}
          {mismatches > 0 && <span className="text-amber-700 dark:text-amber-400"> · {t('revenue.sync.mismatch', { n: mismatches })}</span>}
        </span>
      ) : kind === 'error' ? (
        <span className="text-amber-400">{t('revenue.sync.failed', { error: sync.lastError })}</span>
      ) : (
        <>
          <span className="text-bambu-gray-light">{t('revenue.sync.progress', { fetched: sync.fetchedDays, total: sync.totalDays })}</span>
          <div
            className="h-1.5 w-40 overflow-hidden rounded-full bg-bambu-dark-tertiary"
            role="progressbar"
            aria-valuenow={pctDone}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full bg-bambu-green transition-[width]" style={{ width: `${pctDone}%` }} />
          </div>
          <span className="tabular-nums">{pctDone} %</span>
          {sync.lastBatchAt && <span>{t('revenue.sync.lastSyncAt', { time: hm(sync.lastBatchAt) })}</span>}
          {failedNote}
        </>
      )}
      {canSync && kind === 'error' && (
        <button type="button" className={`text-amber-400 ${linkCls}`} onClick={onRetry}>
          {t('revenue.sync.retry')}
        </button>
      )}
    </div>
  );
}
