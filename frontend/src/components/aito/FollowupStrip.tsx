import { useTranslation } from 'react-i18next';
import { FOLLOWUP_KEYS, type FollowupBucket, type FollowupKey } from '../../utils/aitoFollowups';

/** Colour per bucket, complete class strings (Tailwind cannot see fragments).
 *  notTold is cyan on purpose: it is the same fact the card's "call the
 *  client" glow paints, so the two must share a colour. */
const CHIP_CLS: Record<FollowupKey, string> = {
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

export function FollowupStrip({
  buckets,
  active,
  onChange,
}: {
  buckets: Record<FollowupKey, FollowupBucket>;
  active: FollowupKey | null;
  onChange: (next: FollowupKey | null) => void;
}) {
  const { t } = useTranslation();
  const shown = FOLLOWUP_KEYS.filter((key) => buckets[key].ids.length > 0);
  if (shown.length === 0) return null;

  return (
    <div
      role="group"
      aria-label={t('aito.followups.title')}
      className="flex flex-wrap items-center gap-2 animate-rise"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && active !== null) onChange(null);
      }}
    >
      <span className="text-[11px] font-bold uppercase tracking-wider text-bambu-gray">{t('aito.followups.title')}</span>
      {shown.map((key) => {
        const bucket = buckets[key];
        const pressed = active === key;
        return (
          <button
            key={key}
            type="button"
            data-testid={`aito-followup-${key}`}
            aria-pressed={pressed}
            aria-label={`${t(LABEL_KEY[key])} ${bucket.ids.length}`}
            title={pressed ? t('aito.followups.clear') : undefined}
            onClick={() => onChange(pressed ? null : key)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              CHIP_CLS[key]
            } ${pressed ? 'ring-2 ring-current' : 'hover:brightness-110'}`}
          >
            <span>{t(LABEL_KEY[key])}</span>
            <span className="rounded-full bg-black/20 px-1.5 tabular-nums">{bucket.ids.length}</span>
            {bucket.maxDays > 0 && (
              <span className="text-[11px] opacity-80 tabular-nums">{t('aito.followups.longest', { days: bucket.maxDays })}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
