import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { AitoClientRating, AitoClientRatingTier } from '../../api/client';
import { Tooltip } from '../Tooltip';
import { formatRelativeTime } from '../../utils/date';

/** One colour token per tier, resolved through the theme so the pill reads
 *  on the masthead's accent-washed band and on the drawer's flat surface
 *  alike. The status trio is what the rest of the app uses for ok/warn/
 *  error; `new` borrows the muted text grey so it sits back from the name. */
const TIER_COLOR: Record<Exclude<AitoClientRatingTier, 'unavailable'>, string> = {
  good: 'var(--color-status-ok)',
  medium: 'var(--color-status-warning)',
  bad: 'var(--color-status-error)',
  new: 'var(--color-bambu-gray)',
};

const EMPTY: AitoClientRating = {
  tier: 'new',
  reason: null,
  settled_count: 0,
  on_time_count: 0,
  overdue_count: 0,
  past_due_count: 0,
  worst_overdue_days: 0,
  worst_overdue_number: null,
  is_company: false,
  computed_at: null,
  stale: false,
};

/** Why the tier is what it is, in the viewer's language. Structured fields
 *  in, one line out — the backend deliberately sends no sentence. */
function useReasonText(rating: AitoClientRating): string {
  const { t } = useTranslation();
  switch (rating.reason) {
    case 'overdue':
      return rating.worst_overdue_number
        ? t('aito.rating.overdue', {
            count: rating.overdue_count,
            days: rating.worst_overdue_days,
            number: rating.worst_overdue_number,
          })
        : t('aito.rating.overdueNoNumber', {
            count: rating.overdue_count,
            days: rating.worst_overdue_days,
          });
    case 'chronic':
      return t('aito.rating.chronic', { onTime: rating.on_time_count, settled: rating.settled_count });
    case 'punctual':
      return t('aito.rating.punctual', { onTime: rating.on_time_count, settled: rating.settled_count });
    case 'mixed': {
      const head = t('aito.rating.mixed', { onTime: rating.on_time_count, settled: rating.settled_count });
      return rating.past_due_count > 0
        ? `${head} · ${t('aito.rating.pastDue', { count: rating.past_due_count })}`
        : head;
    }
    default:
      return t('aito.rating.newTip');
  }
}

/** The client's payment rating as a dot-and-word pill.
 *
 *  Renders NOTHING while the rating is loading, when Books had nothing to
 *  say (`unavailable`), or for a `new` client when `hideNew` is set — the
 *  masthead hides it (a walk-in has no verdict and the band must not grow
 *  noise), the drawer shows it (there, "first-timer" is useful while a
 *  deposit is being decided). Appearing late is fine: the pill is a
 *  trailing sibling of the name, never a placeholder that resizes.
 *
 *  A stale rating (Books unreachable, cached figures) fades and appends its
 *  age so nobody reads a three-hour-old "Good" as current. */
export function ClientRatingPill({
  rating,
  hideNew = false,
  align = 'center',
  className = '',
}: {
  rating: AitoClientRating | undefined;
  hideNew?: boolean;
  align?: 'center' | 'end';
  className?: string;
}) {
  const { t } = useTranslation();
  // Hooks above the early returns: the reason text is computed for every
  // render and simply unused when nothing is drawn.
  const reason = useReasonText(rating ?? { ...EMPTY, tier: 'unavailable' });
  if (!rating || rating.tier === 'unavailable') return null;
  if (rating.tier === 'new' && hideNew) return null;

  const label = t(`aito.rating.${rating.tier}`);
  const ago = formatRelativeTime(rating.computed_at, 'system', t);
  const tip = [
    rating.stale ? t('aito.rating.stale') : null,
    `${label} — ${reason}`,
    // A company is held to looser timing (a fortnight late is still on
    // time), so a reader comparing figures across clients is told which
    // profile scored these.
    rating.is_company ? t('aito.rating.companyTerms') : null,
    rating.computed_at ? t('aito.rating.checked', { ago }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const style = {
    '--c': TIER_COLOR[rating.tier],
    color: 'var(--c)',
    backgroundColor: 'color-mix(in srgb, var(--c) 16%, transparent)',
    borderColor: 'color-mix(in srgb, var(--c) 35%, transparent)',
  } as CSSProperties;

  return (
    <Tooltip content={tip} align={align}>
      <span
        data-tier={rating.tier}
        data-stale={rating.stale ? 'true' : undefined}
        role="img"
        aria-label={t('aito.rating.ariaLabel', { tier: label, reason })}
        style={style}
        className={`inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-[3px] text-xs font-semibold leading-none tracking-[0.01em] ${
          rating.stale ? 'opacity-55' : ''
        } ${className}`}
      >
        <span
          aria-hidden="true"
          className="h-[7px] w-[7px] rounded-full"
          style={{ backgroundColor: 'var(--c)', boxShadow: '0 0 0 2px color-mix(in srgb, var(--c) 30%, transparent)' }}
        />
        {rating.stale ? `${label} · ${ago}` : label}
      </span>
    </Tooltip>
  );
}
