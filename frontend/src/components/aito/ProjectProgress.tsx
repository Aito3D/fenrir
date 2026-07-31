import { useTranslation } from 'react-i18next';

/** How far through its steps a project is, as a hairline at the foot of the
 *  card.
 *
 *  A step is one (task, service) pair with a cost — three tasks carrying ten
 *  steps between them with three ticked reads 30%. A step quoted free counts
 *  like any other; the caller has already applied that rule (see
 *  `summariseTasks`), and this component does no arithmetic beyond the ratio.
 *
 *  No percentage text: at 2px the number is noise, and the card is already
 *  dense. The value reaches assistive technology through `aria-valuenow` and
 *  anyone hovering through the title.
 *
 *  Renders nothing at all when there are no steps. An unpriced project has
 *  nothing to measure, and an empty track on every freshly created card is
 *  clutter rather than information. */
export function ProjectProgress({ done, total }: { done: number; total: number }) {
  const { t } = useTranslation();
  if (total <= 0) return null;

  const label = t('aito.progressLabel', { done, total });
  const percent = Math.round((done / total) * 100);

  return (
    <div
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={label}
      title={label}
      className="h-0.5 w-full overflow-hidden rounded-b-xl bg-bambu-dark-tertiary"
    >
      <div
        data-testid="aito-progress-fill"
        style={{ width: `${percent}%` }}
        // The width transition is what makes an optimistic tick visible as
        // motion rather than a jump. motion-reduce drops it, keeping the
        // value change instant for anyone who asked for less movement.
        className="h-full bg-bambu-green transition-[width] duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none"
      />
    </div>
  );
}
