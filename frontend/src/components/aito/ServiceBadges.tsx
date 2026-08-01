import { useTranslation } from 'react-i18next';
import { AITO_SERVICE_LABEL_KEYS } from './services';

/** Compact badge row naming a task's services.
 *
 *  The board card does not use this at all — it draws its own per-task rows
 *  via `TaskMiniRows`. The sole remaining caller is `ImportQuoteModal`,
 *  which never passes `done` and so always renders the plain, undimmed row.
 *  Every element is still a `<span>`, but that is no longer load-bearing: it
 *  used to be forced by a `<button>` ancestor (a `<button>` may not contain
 *  `<div>` or `<p>`), and that ancestor is gone. Kept anyway — `grid`/`flex`
 *  set `display`, so a span costs nothing here, and churning it to a `<div>`
 *  would be work for no behavioural change. An unrecognised id falls back to
 *  itself rather than rendering blank, so a service added server-side shows
 *  up instead of disappearing.
 *
 *  `done` is optional and, when omitted, changes nothing — the sole caller
 *  never passes it. Any future caller that does gets those services dimmed
 *  with a strikethrough, the same "quiet, not hidden" treatment the step list
 *  itself uses. */
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
