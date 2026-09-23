import type { CSSProperties, ReactNode } from 'react';
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

/** Everything the pill and the ring say about a rating, in the viewer's
 *  language: the tier word, the one-line reason, the tooltip that joins
 *  them (with the stale warning and the checked-time), and the aria-label.
 *  One place so the two shapes can never disagree about what they mean.
 *  Hooks run for every render — callers early-return AFTER calling this. */
function useRatingText(rating: AitoClientRating | undefined) {
  const { t } = useTranslation();
  const safe = rating ?? { ...EMPTY, tier: 'unavailable' as const };
  const reason = useReasonText(safe);
  const label = safe.tier === 'unavailable' ? '' : t(`aito.rating.${safe.tier}`);
  const ago = formatRelativeTime(safe.computed_at, 'system', t);
  const tip = [
    safe.stale ? t('aito.rating.stale') : null,
    `${label} — ${reason}`,
    // A company is held to looser timing (a fortnight late is still on
    // time), so a reader comparing figures across clients is told which
    // profile scored these.
    safe.is_company ? t('aito.rating.companyTerms') : null,
    safe.computed_at ? t('aito.rating.checked', { ago }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return { label, reason, ago, tip, ariaLabel: t('aito.rating.ariaLabel', { tier: label, reason }) };
}

/** The client's payment rating as a dot-and-word pill — the DRAWER's shape,
 *  where "New" is a useful word while a deposit is being decided.
 *
 *  Renders NOTHING while the rating is loading or when Books had nothing to
 *  say (`unavailable`). Appearing late is fine: the pill is a trailing
 *  sibling of the name, never a placeholder that resizes.
 *
 *  A stale rating (Books unreachable, cached figures) fades and appends its
 *  age so nobody reads a three-hour-old "Good" as current. */
export function ClientRatingPill({
  rating,
  align = 'center',
  side = 'top',
  className = '',
}: {
  rating: AitoClientRating | undefined;
  /** Straight through to Tooltip — see its doc for when each is right. */
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom';
  className?: string;
}) {
  const { label, ago, tip, ariaLabel } = useRatingText(rating);
  if (!rating || rating.tier === 'unavailable') return null;

  const style = {
    '--c': TIER_COLOR[rating.tier],
    color: 'var(--c)',
    backgroundColor: 'color-mix(in srgb, var(--c) 16%, transparent)',
    borderColor: 'color-mix(in srgb, var(--c) 35%, transparent)',
  } as CSSProperties;

  return (
    // The pill arrives late (Books answers seconds after the client is
    // picked) beside an input that flexes to fill the row, so it unfolds its
    // width rather than landing at full size: `.aito-unfold-x` opens the
    // track from zero and the input narrows with it. It remounts on every
    // client switch (the rating is `undefined` while the new one loads, and
    // this returns null), so the entrance replays each time — and never on a
    // mere re-render, since @starting-style fires only on first paint.
    <span data-testid="client-rating-unfold" className={`aito-unfold-x flex-shrink-0 ${className}`}>
      <span>
        <Tooltip content={tip} align={align} side={side}>
          <span
            data-tier={rating.tier}
            data-stale={rating.stale ? 'true' : undefined}
            role="img"
            aria-label={ariaLabel}
            style={style}
            className={`inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-[3px] text-xs font-semibold leading-none tracking-[0.01em] ${
              rating.stale ? 'opacity-55' : ''
            }`}
          >
            <span
              aria-hidden="true"
              className="h-[7px] w-[7px] rounded-full"
              style={{ backgroundColor: 'var(--c)', boxShadow: '0 0 0 2px color-mix(in srgb, var(--c) 30%, transparent)' }}
            />
            {rating.stale ? `${label} · ${ago}` : label}
          </span>
        </Tooltip>
      </span>
    </span>
  );
}

/** The client's payment rating as a ring around the client glyph — the
 *  MASTHEAD's shape. The band already carries the quote status and the
 *  board flag as pills one row up; a third pill on the name line read as
 *  a repeat of that row, so here the tier is colour on the client's own
 *  mark, like a presence ring, and the word lives in the tooltip and the
 *  accessible name. Zero width and zero height: the ring is drawn OUTSIDE
 *  the glyph's box (`-inset-[5px]`, absolute), so the name line — and the
 *  band, which must never grow a row — measure exactly as they did.
 *
 *  `children` is the glyph (`User` / `Building2`), rendered untouched —
 *  without any wrapper — while the rating is loading, `unavailable`, or
 *  `new` (a walk-in has no verdict and the band must not ring every
 *  first-timer). The drawer's pill shows that word instead.
 *
 *  Arrival is animated (see `.animate-aito-rating-ring` in index.css): the
 *  rating is its own fetch and lands a beat after the panel, and a ring
 *  that simply appears at full size reads as a flash. */
export function ClientRatingRing({
  rating,
  children,
  align = 'start',
  side = 'top',
}: {
  rating: AitoClientRating | undefined;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  /** Straight through to Tooltip. The masthead passes `bottom`: the ring sits
   *  on the first row of the panel's `overflow-hidden` root, where a bubble
   *  hanging above it is cut off entirely. */
  side?: 'top' | 'bottom';
}) {
  const { tip, ariaLabel } = useRatingText(rating);
  if (!rating || rating.tier === 'unavailable' || rating.tier === 'new') return <>{children}</>;

  const style = { '--c': TIER_COLOR[rating.tier] } as CSSProperties;
  return (
    <Tooltip content={tip} align={align} side={side}>
      <span
        data-tier={rating.tier}
        data-stale={rating.stale ? 'true' : undefined}
        role="img"
        aria-label={ariaLabel}
        style={style}
        // mr-[6px]: the ring paints 5px outside the glyph (`-inset-[5px]`
        // below) without taking layout room, so it ate the masthead's gap
        // and sat against the name. Reserving that extent on the right
        // keeps the glyph-to-name space the same whether or not it rings.
        className="relative mr-[6px] inline-flex flex-shrink-0 items-center justify-center"
      >
        {children}
        {/* The halo goes first so the ring paints over its spread. */}
        <span
          aria-hidden="true"
          className="animate-aito-rating-halo pointer-events-none absolute -inset-[5px] rounded-full opacity-0"
        />
        {/* Stale dims through the border colour, not `opacity`: the arrival
            animation's fill state owns opacity and would win. */}
        <span
          aria-hidden="true"
          className="animate-aito-rating-ring pointer-events-none absolute -inset-[5px] rounded-full border-2"
          style={{ borderColor: rating.stale ? 'color-mix(in srgb, var(--c) 55%, transparent)' : 'var(--c)' }}
        />
      </span>
    </Tooltip>
  );
}
