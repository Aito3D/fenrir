import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ListFilter, X } from 'lucide-react';
import { FOLLOWUP_KEYS, type FollowupBucket, type FollowupKey } from '../../utils/aitoFollowups';
import type { AitoProject } from '../../api/client';

/** What a tile reads off a project to name its worst offender. `Pick`, not
 *  the whole row, so a test can hand in three fields and the component is
 *  honest about how little of the board it looks at. */
export type FollowupProject = Pick<AitoProject, 'id' | 'client_name' | 'description'>;

/** Colour per bucket, complete class strings (Tailwind cannot see fragments).
 *  notTold is cyan on purpose: it is the same fact the card's "call the
 *  client" glow paints, so the two must share a colour. */
const TILE_CLS: Record<FollowupKey, string> = {
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

/** The "to chase" panel above the board: one tile per non-empty bucket.
 *
 *  These four numbers are the money on this screen — quotes nobody answered,
 *  clients nobody rang, invoices nobody paid — and as a row of small chips
 *  they read as an afterthought. A tile gives each one a count you can read
 *  from across the room, the longest wait, and the single worst offender by
 *  name, so the operator knows who to ring before opening anything.
 *
 *  Every tile is a filter, and says so: a filter glyph that comes up on hover,
 *  a hint beside the heading, `aria-pressed`, and the glyph turning into an
 *  × once the filter is on. The bucket's ids are already sorted longest wait
 *  first (see `followups()`), so the worst offender is simply `ids[0]`. */
export function FollowupStrip({
  buckets,
  active,
  onChange,
  projects = [],
}: {
  buckets: Record<FollowupKey, FollowupBucket>;
  active: FollowupKey | null;
  onChange: (next: FollowupKey | null) => void;
  /** The board's projects, to name each tile's worst offender. Optional: a
   *  tile without it still shows its count and longest wait. */
  projects?: FollowupProject[];
}) {
  const { t } = useTranslation();
  const byId = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const shown = FOLLOWUP_KEYS.filter((key) => buckets[key].ids.length > 0);
  if (shown.length === 0) return null;

  return (
    <div
      role="group"
      aria-label={t('aito.followups.title')}
      className="animate-rise"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && active !== null) onChange(null);
      }}
    >
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-bambu-gray">{t('aito.followups.title')}</span>
        <span className="text-[11px] text-bambu-gray">{t('aito.followups.hint')}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {shown.map((key) => {
          const bucket = buckets[key];
          const pressed = active === key;
          const worst = byId.get(bucket.ids[0]);
          const worstText = worst ? [worst.client_name, worst.description].filter(Boolean).join(' · ') : '';
          const Glyph = pressed ? X : ListFilter;
          return (
            <button
              key={key}
              type="button"
              data-testid={`aito-followup-${key}`}
              aria-pressed={pressed}
              aria-label={`${t(LABEL_KEY[key])} ${bucket.ids.length}${worstText ? ` — ${worstText}` : ''}`}
              title={pressed ? t('aito.followups.clear') : t('aito.followups.hint')}
              onClick={() => onChange(pressed ? null : key)}
              className={`group/tile flex-1 basis-[13rem] max-w-[20rem] min-w-0 rounded-lg border px-3 py-2 text-left transition-[filter,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current ${
                TILE_CLS[key]
              } ${pressed ? 'ring-2 ring-current' : 'hover:brightness-110'}`}
            >
              <span className="flex items-center gap-2">
                <span className="truncate text-[11px] font-semibold uppercase tracking-wider">{t(LABEL_KEY[key])}</span>
                {bucket.maxDays > 0 && (
                  <span className="ml-auto flex-shrink-0 text-[11px] opacity-80 tabular-nums">
                    {t('aito.followups.longest', { days: bucket.maxDays })}
                  </span>
                )}
                <Glyph
                  aria-hidden="true"
                  className={`h-3.5 w-3.5 flex-shrink-0 transition-opacity ${bucket.maxDays > 0 ? '' : 'ml-auto'} ${
                    pressed ? '' : 'opacity-50 group-hover/tile:opacity-100'
                  }`}
                />
              </span>
              <span className="mt-1 flex min-w-0 items-baseline gap-2">
                <span className="text-xl font-bold leading-none tabular-nums">{bucket.ids.length}</span>
                {worstText && (
                  <span data-testid={`aito-followup-${key}-worst`} className="min-w-0 truncate text-xs text-bambu-gray-light">
                    {worstText}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
