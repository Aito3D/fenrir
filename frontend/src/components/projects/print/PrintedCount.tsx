import { useTranslation } from 'react-i18next';

export interface PrintCounts {
  printed: number;
  rejected: number;
  queued: number;
  /** The task's requested quantity; null = no target to count against. */
  target: number | null;
}

/** A task's print progress (spec §4.2): `12/20 printed · 2 rejected · 4 queued`.
 *  Zero rejected/queued parts are left out; nothing at all renders until a
 *  print exists or is queued. */
export function PrintedCount({ printed, rejected, queued, target, className = '' }: PrintCounts & { className?: string }) {
  const { t } = useTranslation();
  if (printed === 0 && rejected === 0 && queued === 0) return null;
  const parts = [
    target !== null ? t('projectsPdm.print.printed', { printed, target }) : t('projectsPdm.print.printedNoTarget', { printed }),
    rejected > 0 ? t('projectsPdm.print.rejected', { count: rejected }) : null,
    queued > 0 ? t('projectsPdm.print.queued', { count: queued }) : null,
  ].filter(Boolean);
  return (
    <span data-testid="printed-count" className={`tabular-nums ${className}`}>
      {parts.join(' · ')}
    </span>
  );
}
