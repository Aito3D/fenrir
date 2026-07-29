import { useTranslation } from 'react-i18next';
import { AITO_SERVICE_LABEL_KEYS } from './services';

/** Compact badge row naming a task's services.
 *
 *  Every element is a `<span>` because both callers render this inside a
 *  `<button>` — the card's body button and a task row's collapse toggle — and
 *  a `<button>` may not contain `<div>` or `<p>`. An unrecognised id falls
 *  back to itself rather than rendering blank, so a service added server-side
 *  shows up instead of disappearing.
 *
 *  `done` is optional and, when omitted, changes nothing: the board card
 *  never passes it, so a badge there renders exactly as before. A task row's
 *  collapsed header passes the ids whose step is ticked, and those badges dim
 *  with a strikethrough — the same "quiet, not hidden" treatment the step
 *  list itself uses. */
export function ServiceBadges({
  services,
  done = [],
  className = '',
}: {
  services: string[];
  done?: string[];
  className?: string;
}) {
  const { t } = useTranslation();
  if (services.length === 0) return null;
  return (
    <span className={`flex flex-wrap gap-1 ${className}`}>
      {services.map((service) => (
        <span
          key={service}
          className={`rounded px-1.5 py-0.5 text-[10px] leading-tight bg-bambu-dark-tertiary text-bambu-gray-light ${
            done.includes(service) ? 'opacity-50 line-through' : ''
          }`}
        >
          {AITO_SERVICE_LABEL_KEYS[service] ? t(AITO_SERVICE_LABEL_KEYS[service]) : service}
        </span>
      ))}
    </span>
  );
}
