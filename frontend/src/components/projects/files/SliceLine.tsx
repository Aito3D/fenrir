import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, RotateCw, Upload } from 'lucide-react';
import { focusRingCls } from '../../formStyles';
import type { RevisionSliceState } from './useRevisionSlice';

// `changed`: the state moved since the card mounted, so the new line fades in (and a
// fresh "Sliced" gives its check one press). A page load never animates.
// `onUpload`: the hand-slice fallback of a failed slice (upload the .gcode.3mf yourself).
export function SliceLine({ state, percent, error, printCount, onRetry, onUpload, changed }: {
  changed: boolean;
  state: RevisionSliceState;
  percent: number | null;
  error: string | null;
  printCount: number;
  onRetry?: () => void;
  onUpload?: () => void;
}) {
  const { t } = useTranslation();
  const enter = changed ? 'animate-fade-in' : '';
  if (state === 'slicing') {
    return (
      <div className={`mt-2 ${enter}`}>
        <div className="mb-1 flex justify-between text-[11px] text-bambu-green">
          <span>{t('slice.slicing')}</span>
          {percent !== null && <span>{`${percent}%`}</span>}
        </div>
        <div role="progressbar" aria-label={t('slice.slicing')} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={percent ?? undefined} className="h-1 overflow-hidden rounded bg-bambu-dark-tertiary">
          <div className={`h-full bg-bambu-green ${percent === null ? 'w-1/3 animate-pulse' : 'w-full origin-left transition-transform duration-300 ease-[var(--ease-signature)]'}`}
            style={percent !== null ? { transform: `scaleX(${percent / 100})` } : undefined} />
        </div>
      </div>
    );
  }
  if (state === 'failed') {
    return (
      <div className={`mt-1 flex flex-wrap items-center gap-x-2 text-red-400 ${enter}`}>
        <span className="flex min-w-0 items-center gap-1 break-words">
          <AlertCircle className="h-3 w-3 shrink-0" aria-hidden />
          {error ? t('projectsPdm.slice.failed', { detail: error }) : t('queue.status.slice_failed')}
        </span>
        {onRetry && (
          <button type="button" onClick={onRetry}
            className={`inline-flex min-h-[44px] items-center gap-1 rounded underline md:min-h-0 ${focusRingCls}`}>
            <RotateCw className="h-3 w-3" aria-hidden />{t('common.retry')}
          </button>
        )}
        {onUpload && (
          <button type="button" onClick={onUpload}
            className={`inline-flex min-h-[44px] items-center gap-1 rounded underline md:min-h-0 ${focusRingCls}`}>
            <Upload className="h-3 w-3" aria-hidden />{t('projectsPdm.slice.uploadAction')}
          </button>
        )}
      </div>
    );
  }
  if (state === 'none') {
    return (
      <div className={`mt-1 flex items-center gap-1 text-amber-400 ${enter}`}>
        <AlertCircle className="h-3 w-3" aria-hidden />{t('projectsPdm.files.notSliced')}
      </div>
    );
  }
  return (
    <div className={`mt-1 flex items-center gap-1 text-bambu-green ${enter}`}>
      <CheckCircle2 className={`h-3 w-3 ${changed ? 'animate-slice-done' : ''}`} aria-hidden />
      <span>{t('projectsPdm.files.sliced')}</span>
      {printCount > 0 && <span>{`· ${t('projectsPdm.print.printCount', { count: printCount })}`}</span>}
    </div>
  );
}
