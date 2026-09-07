import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ListFilter, X } from 'lucide-react';
import { FOLLOWUP_KEYS, type FollowupBucket, type FollowupKey } from '../../utils/aitoFollowups';
import type { AitoProject } from '../../api/client';

/** What a pill reads off a project to name its worst offender. `Pick`, not
 *  the whole row, so a test can hand in three fields and the component is
 *  honest about how little of the board it looks at. */
export type FollowupProject = Pick<AitoProject, 'id' | 'client_name' | 'description'>;

/** Colour per bucket, complete class strings (Tailwind cannot see fragments).
 *  notTold is cyan on purpose: it is the same fact the card's "call the
 *  client" glow paints, so the two must share a colour. */
const PILL_CLS: Record<FollowupKey, string> = {
  quoteOut: 'border-amber-400/30 bg-amber-400/[0.12] text-amber-400',
  notTold: 'border-cyan-400/30 bg-cyan-400/[0.12] text-cyan-400',
  notCollected: 'border-orange-400/30 bg-orange-400/[0.12] text-orange-400',
  unpaid: 'border-red-400/30 bg-red-400/[0.12] text-red-400',
};

const LABEL_KEY: Record<FollowupKey, string> = {
  quoteOut: 'aito.followups.quoteOut',
  notTold: 'aito.followups.notTold',
  notCollected: 'aito.followups.notCollected',
  unpaid: 'aito.followups.unpaid',
};

/** The "to chase" pills in the board header: one per non-empty bucket.
 *
 *  These four numbers are the money on this screen — quotes nobody answered,
 *  clients nobody rang, invoices nobody paid — so each gets a count you can
 *  read from across the room and the longest wait. They sit in the header
 *  row rather than on a row of their own because the board is the page: a
 *  two-line tile strip cost it a full row of cards (2026-09-06), and the
 *  worst offender's name, which is what the second line held, is one hover
 *  away — the pill's tooltip names them, and so does its accessible name.
 *
 *  Every pill is a filter, and says so: a filter glyph that comes up on
 *  hover, a hint in the tooltip, `aria-pressed`, and the glyph turning into
 *  an × once the filter is on. The bucket's ids are already sorted longest
 *  wait first (see `followups()`), so the worst offender is simply `ids[0]`. */
export function FollowupStrip({
  buckets,
  active,
  onChange,
  projects = [],
  className = '',
}: {
  buckets: Record<FollowupKey, FollowupBucket>;
  active: FollowupKey | null;
  onChange: (next: FollowupKey | null) => void;
  /** The board's projects, to name each pill's worst offender. Optional: a
   *  pill without it still shows its count and longest wait. */
  projects?: FollowupProject[];
  className?: string;
}) {
  const { t } = useTranslation();
  const byId = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const shown = FOLLOWUP_KEYS.filter((key) => buckets[key].ids.length > 0);
  if (shown.length === 0) return null;

  return (
    <div
      role="group"
      aria-label={t('aito.followups.title')}
      // Wraps rather than truncates: on a screen too narrow for four pills
      // beside the title, a second pill line still costs less than the old
      // tile strip did, and every pill stays readable.
      className={`flex flex-wrap items-center gap-1.5 min-w-0 ${className}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && active !== null) onChange(null);
      }}
    >
      {shown.map((key) => {
        const bucket = buckets[key];
        const pressed = active === key;
        const worst = byId.get(bucket.ids[0]);
        const worstText = worst ? [worst.client_name, worst.description].filter(Boolean).join(' · ') : '';
        const Glyph = pressed ? X : ListFilter;
        // The tooltip is where the worst offender's name lives now: a
        // newline keeps it on its own line above the hint in every browser.
        const title = pressed ? t('aito.followups.clear') : [worstText, t('aito.followups.hint')].filter(Boolean).join('\n');
        return (
          <button
            key={key}
            type="button"
            data-testid={`aito-followup-${key}`}
            aria-pressed={pressed}
            aria-label={`${t(LABEL_KEY[key])} ${bucket.ids.length}${worstText ? ` — ${worstText}` : ''}`}
            title={title}
            onClick={() => onChange(pressed ? null : key)}
            className={`group/pill inline-flex items-center gap-2 rounded-full border px-3 py-1 whitespace-nowrap transition-[filter,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current ${
              PILL_CLS[key]
            } ${pressed ? 'ring-2 ring-current' : 'hover:brightness-110'}`}
          >
            <span className="text-sm font-bold leading-none tabular-nums">{bucket.ids.length}</span>
            <span className="text-[11px] font-semibold uppercase tracking-wider">{t(LABEL_KEY[key])}</span>
            {bucket.maxDays > 0 && (
              <span className="text-[11px] opacity-80 tabular-nums">{t('aito.followups.longest', { days: bucket.maxDays })}</span>
            )}
            <Glyph
              aria-hidden="true"
              className={`h-3.5 w-3.5 flex-shrink-0 transition-opacity ${pressed ? '' : 'opacity-50 group-hover/pill:opacity-100'}`}
            />
          </button>
        );
      })}
    </div>
  );
}
