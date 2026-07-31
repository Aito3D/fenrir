import { useTranslation } from 'react-i18next';
import { SERVICES } from '../../utils/aitoBoardRules';
import { AITO_SERVICE_LABEL_KEYS } from './services';
import type { AitoTaskSteps } from '../../api/client';

/** A project's tasks as one row of step pills each.
 *
 *  Four fixed columns, always in `SERVICES` order, so Scan is leftmost and
 *  Machining rightmost on every row of every card. A service the task does not
 *  carry leaves its cell empty rather than collapsing it: with the columns
 *  aligned, the SHAPE of a row says what the job involves before any label is
 *  read, and two rows can be compared at a glance. A `flex` row could not do
 *  that — the pills would slide left and each row would mean something
 *  different.
 *
 *  Replaces the card's old task count. A number nobody acts on became four
 *  pills that go green as the work lands, which is the thing an operator
 *  actually wants off a collapsed card.
 *
 *  Each pill's accessible name states its own state ("Scan — Done" / "Scan —
 *  Pending"), via `aria-label`, alongside the plain visible label. The
 *  progress bar underneath separately reports the aggregate ("N of M steps
 *  done") — that is a different fact from which step is finished, and a
 *  screen-reader user needs both: the aggregate to gauge overall progress, the
 *  per-pill state to know which service is still outstanding. Colour alone
 *  (green tint vs grey) would otherwise be the only channel carrying that
 *  fact, which fails both a screen reader and a colour-vision-deficient sighted
 *  user.
 *
 *  Every element is a `<span>`. There is no `<button>` ancestor forcing that
 *  anymore — the card's click region is a plain `<div>` — but the spans stay:
 *  `grid` and `flex` set `display`, so a span lays out exactly as a div would,
 *  and there is nothing to gain by churning every element to a `<div>` for no
 *  behavioural change. */
export function StepGrid({ tasks }: { tasks: AitoTaskSteps[] }) {
  const { t } = useTranslation();
  if (tasks.length === 0) return null;

  return (
    <span data-testid="aito-step-grid" className="mt-2 block space-y-1">
      {tasks.map((task, index) => (
        // Index keys: `task_steps` carries no id, and the array is positional
        // — it is replaced wholesale on every refetch and optimistic write,
        // never spliced or reordered in place.
        <span key={index} data-testid="aito-step-row" className="grid grid-cols-4 gap-1">
          {SERVICES.map((service) => {
            if (!task.services.includes(service)) return <span key={service} />;
            const done = task.done.includes(service);
            const label = AITO_SERVICE_LABEL_KEYS[service]
              ? t(AITO_SERVICE_LABEL_KEYS[service])
              : service;
            return (
              <span
                key={service}
                data-service={service}
                data-done={done}
                // role="img" permits an author-supplied aria-label. Without it,
                // the span is role-generic, and ARIA prohibits an author-supplied
                // name on generic — browsers drop aria-label, and "— Done" never
                // reaches the screen reader. See ARIA 1.2 spec, name-from-author.
                role="img"
                // The state lives in the accessible name, not just in colour:
                // "Scan — Done" / "Scan — Pending". See the module docstring.
                aria-label={`${label} — ${t(done ? 'aito.done' : 'aito.stepPending')}`}
                // The full label in `title`: a quarter of a 300px column is
                // not enough for `Modélisation` at any locale, so the visible
                // text truncates and the tooltip carries the whole of it.
                title={label}
                className={`truncate rounded px-1.5 py-0.5 text-center text-[10px] leading-tight ${
                  done
                    ? 'bg-bambu-green/15 text-bambu-green ring-1 ring-inset ring-bambu-green/30'
                    : 'bg-bambu-dark-tertiary text-bambu-gray-light'
                }`}
              >
                {label}
              </span>
            );
          })}
        </span>
      ))}
    </span>
  );
}
