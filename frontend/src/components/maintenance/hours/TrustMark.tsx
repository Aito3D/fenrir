import { AlertTriangle, Circle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { HourMachine } from '../../../api/client';

interface TrustMarkProps {
  machine: HourMachine;
  size?: 'sm' | 'md';
}

export function TrustMark({ machine, size = 'sm' }: TrustMarkProps) {
  const { t } = useTranslation();
  const cls = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  if (machine.trust === 'drifting') {
    const label = t('maintenance.hours.trust.drifting', { hours: Math.round(Math.abs(machine.last_drift_hours ?? 0)) });
    return (
      <span role="img" aria-label={label} title={label} className="shrink-0">
        <AlertTriangle className={`${cls} text-amber-400`} aria-hidden="true" />
      </span>
    );
  }
  if (machine.trust === 'uncalibrated') {
    const label = t('maintenance.hours.trust.uncalibrated');
    return (
      <span role="img" aria-label={label} title={label} className="shrink-0">
        <Circle className={`${cls} text-bambu-gray`} aria-hidden="true" />
      </span>
    );
  }
  return null;
}
