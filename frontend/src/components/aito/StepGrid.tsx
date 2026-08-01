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
            if (!task.services.includes(service)) {
              return (
                <span
                  key={service}
                  data-testid="aito-step-placeholder"
                  // Decorative. "This job has no scan" is already said by the
                  // absence of a scan pill; announcing three empty boxes per
                  // row would bury the one pill that matters.
                  aria-hidden="true"
                  // The non-breaking space is load-bearing: an empty inline
                  // box collapses to zero height, and the placeholder has to
                  // match a pill's height exactly. Sharing the pill's padding
                  // and type scale and giving it one blank character gets that
                  // for free, with no pixel value to drift when the pill's
                  // padding changes.
                  className="rounded border border-dashed border-bambu-dark-tertiary px-1.5 py-0.5 text-[10px] leading-tight"
                >
                  {'\u00A0'}
                </span>
              );
            }
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
                // `border border-transparent` matches the placeholder's box
                // model exactly, so a pill and an empty slot are the same
                // height whichever mix a row happens to carry.
                //
                // The transition is the same 300ms the progress bar directly
                // below uses (see ProjectProgress): a tick lands on both at
                // once, and one of them snapping while the other travels reads
                // as two unrelated events instead of one. `box-shadow` is in
                // the list because Tailwind's `ring-1` IS a box-shadow — left
                // out, the green outline would appear a frame before the fill.
                className={`truncate rounded border border-transparent px-1.5 py-0.5 text-center text-[10px] leading-tight transition-[color,background-color,box-shadow] duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
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
