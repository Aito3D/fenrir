import { useTranslation } from 'react-i18next';
import { formatFcp } from './lib/format';
import type { RevenueBucket } from './lib/types';

const PARTS = ['items', 'filament', 'energy', 'wear', 'labor', 'fixed', 'depreciation'] as const;

/** How a bucket's gross margin is made: costed HT, minus each cost part the server sent, equals the margin. */
export function MarginBreakdown({ bucket, className = '' }: { bucket: RevenueBucket; className?: string }) {
  const { t } = useTranslation();
  const parts = bucket.costParts;
  if (!parts || bucket.costedHt == null) return null;
  const margin = bucket.costedHt - (bucket.cost ?? 0);
  const line = (label: string, value: string, strong = false) => (
    <p key={label} className={`flex justify-between gap-4 tabular-nums ${strong ? 'font-medium text-white' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </p>
  );
  return (
    <div className={className} aria-label={t('revenue.breakdown.label')} role="group">
      {line(t('revenue.breakdown.costedHt'), formatFcp(bucket.costedHt))}
      {PARTS.filter((p) => (parts[p] ?? 0) !== 0).map((p) => line(t(`revenue.breakdown.${p}`), `−${formatFcp(parts[p] ?? 0)}`))}
      <div className="my-0.5 border-t border-bambu-dark-tertiary" />
      {line(t('revenue.breakdown.margin'), formatFcp(margin), true)}
    </div>
  );
}
