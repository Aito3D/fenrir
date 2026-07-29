import { useTranslation } from 'react-i18next';
import { AITO_SERVICE_LABEL_KEYS } from './services';

/** Compact badge row naming a task's services.
 *
 *  Every element is a `<span>` because both callers render this inside a
 *  `<button>` — the card's body button and a task row's collapse toggle — and
 *  a `<button>` may not contain `<div>` or `<p>`. An unrecognised id falls
 *  back to itself rather than rendering blank, so a service added server-side
 *  shows up instead of disappearing. */
export function ServiceBadges({ services, className = '' }: { services: string[]; className?: string }) {
  const { t } = useTranslation();
  if (services.length === 0) return null;
  return (
    <span className={`flex flex-wrap gap-1 ${className}`}>
      {services.map((service) => (
        <span
          key={service}
          className="rounded px-1.5 py-0.5 text-[10px] leading-tight bg-bambu-dark-tertiary text-bambu-gray-light"
        >
          {AITO_SERVICE_LABEL_KEYS[service] ? t(AITO_SERVICE_LABEL_KEYS[service]) : service}
        </span>
      ))}
    </span>
  );
}
