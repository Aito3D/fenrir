import type { StatDelta } from './deltas';

const TONE_CLASS = {
  good: 'text-status-ok',
  bad: 'text-status-error',
  neutral: 'text-bambu-gray',
} as const;

/** Small "▲ 12%" change indicator shown next to a stat value. */
export function DeltaBadge({ delta, title }: { delta: StatDelta | null; title?: string }) {
  if (!delta) return null;
  const arrow = delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '—';
  const label = delta.direction === 'flat' ? arrow : `${arrow} ${Math.abs(delta.pct).toFixed(0)}%`;
  return (
    <span className={`text-xs font-medium whitespace-nowrap ${TONE_CLASS[delta.tone]}`} title={title}>
      {label}
    </span>
  );
}
