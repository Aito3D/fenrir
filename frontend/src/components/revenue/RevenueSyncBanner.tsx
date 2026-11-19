import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { focusRingCls } from '../formStyles';
import { bannerState } from './lib/dashboard';
import type { RevenueSyncStatus } from './lib/types';

const linkCls = `underline underline-offset-2 hover:text-white disabled:opacity-50 disabled:no-underline ${focusRingCls}`;

/** The sync line under the page title: idle (cache up to date), progress (back-fill bar) or error
 *  (an error always wins). Retry and Rebuild need `revenue:sync`; Rebuild asks first. */
export function RevenueSyncBanner({
  sync,
  canSync,
  busy,
  onRetry,
  onRebuild,
}: {
  sync: RevenueSyncStatus;
  canSync: boolean;
  busy: boolean;
  onRetry: () => void;
  onRebuild: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const { kind, pctDone } = bannerState(sync);
  const hm = (iso: string) => new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });

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
        </>
      )}
      {canSync && kind === 'error' && (
        <button type="button" className={`text-amber-400 ${linkCls}`} onClick={onRetry}>
          {t('revenue.sync.retry')}
        </button>
      )}
      {canSync &&
        (confirm ? (
          <>
            <span className="text-amber-400">{t('revenue.sync.rebuildConfirm')}</span>
            <button type="button" className={`text-amber-400 ${linkCls}`} onClick={() => { setConfirm(false); onRebuild(); }}>
              {t('revenue.sync.rebuildYes')}
            </button>
            <button type="button" className={linkCls} onClick={() => setConfirm(false)}>
              {t('revenue.sync.cancel')}
            </button>
          </>
        ) : (
          <button type="button" className={linkCls} disabled={busy} onClick={() => setConfirm(true)}>
            {t('revenue.sync.rebuild')}
          </button>
        ))}
    </div>
  );
}
