import { useTranslation } from 'react-i18next';
import i18next, { type TFunction } from 'i18next';
import { Finding, Panel, Tile } from '../aito/stats/primitives';
import { DeltaBadge } from '../stats/DeltaBadge';
import { bucketKeyFor, bucketLabel, isBucketKey, shiftBucketYear, toDateRangeLabel } from './lib/buckets';
import { addDays, daysBetween } from './lib/dates';
import { asDelta, findingCase } from './lib/finding';
import { focusRingCls } from '../formStyles';
import { formatFcp } from './lib/format';
import { evolutionFor, insightTiles, kpiTiles, yearOverYear, type KpiTile } from './lib/kpis';
import type { RevenueBucket, RevenueGranularity, RevenueResponse, TaxMode } from './lib/types';

const GREEN = '#00ae42';
const AMBER = '#f59e0b';
const SPARK_POINTS = 24;
const RING_R = 50;
// kpiTiles words its labels in French with this unit; tileLabel maps them back to keys.
const FR_UNIT = { day: 'Jour', week: 'Semaine', month: 'Mois', year: 'Année' } as const;
const MARGIN_LABEL = 'Marge brute HT';
const PER_HOUR_LABEL = 'Services / h machine';

const pick = (m: { ht: number; ttc: number }, mode: TaxMode) => (mode === 'ttc' ? m.ttc : m.ht);
const pctText = (v: number) => `${Math.round(v * 100)} %`;
const targetOf = (b: RevenueBucket) => (b.target != null && b.target > 0 ? b.target : null);

/** What the last bucket is compared with: the clipped range of a partial bucket, else the whole previous or year-ago bucket. */
function comparison(t: TFunction, buckets: RevenueBucket[], g: RevenueGranularity, against: 'previous' | 'year-ago'): string | null {
  // A year's previous bucket is its year-ago one, and only that label names the year.
  if (g === 'year') against = 'year-ago';
  const last = buckets[buckets.length - 1];
  const range = toDateRangeLabel(last, g, against);
  if (range) return t('revenue.hero.toDate', { range });
  if (!isBucketKey(last.key, g)) return null;
  const key = against === 'previous' ? bucketKeyFor(addDays(last.start, -1), g) : shiftBucketYear(last.key, g, -1);
  if (!key) return null;
  const prev = buckets[buckets.length - 2];
  return prev?.key === key ? prev.label : bucketLabel(key, g);
}

/** kpiTiles / insightTiles word labels and text hints in French: map them to keys; data hints (bucket labels) pass through. */
function tileText(t: TFunction, tile: KpiTile, g: RevenueGranularity, last: RevenueBucket): { label: string; hint?: string } {
  if (tile.label === MARGIN_LABEL) {
    const costed = last.costedHt || 1;
    return {
      label: t('revenue.hero.margin'),
      hint: t('revenue.hero.marginHint', {
        rate: pctText((tile.value ?? 0) / costed),
        coverage: pctText(last.ht ? costed / last.ht : 0),
      }),
    };
  }
  if (tile.label === PER_HOUR_LABEL) {
    return { label: t('revenue.table.perHour'), hint: `${new Intl.NumberFormat(i18next.language, { maximumFractionDigits: 1 }).format(last.printHours ?? 0)} h` };
  }
  if (tile.label.startsWith('Projection')) {
    return { label: t(`revenue.hero.projectionTile.${g}`), hint: t(last.projectionMethod === 'seasonal' ? 'revenue.hero.paceLastYear' : 'revenue.hero.paceCurrent') };
  }
  return { label: t(`revenue.hero.previous.${g}`), hint: tile.hint };
}

/** The sentence above the hero, from the same figures: share of the target and the change vs the previous period. */
export function RevenueFinding({ payload, taxMode }: { payload: RevenueResponse; taxMode: TaxMode }) {
  const { t } = useTranslation();
  const { buckets, granularity: g } = payload;
  const last = buckets[buckets.length - 1];
  if (!last) return null;
  const target = targetOf(last);
  const share = target ? last.ht / target : null;
  const against = comparison(t, buckets, g, 'previous');
  const change = against ? evolutionFor(last, taxMode) : null;
  const kind = findingCase(share, change);
  if (!kind) return null;
  const vars = {
    period: last.label.charAt(0).toLocaleUpperCase() + last.label.slice(1),
    share: share != null ? pctText(share) : '',
    change: change != null ? pctText(Math.abs(change)) : '',
    comparison: against,
  };
  const split = kind === 'targetAhead' || kind === 'targetBehind' || kind === 'targetLevel';
  return (
    <Finding
      testId="revenue-finding"
      lead={split ? t(`revenue.finding.${kind}.lead`, vars) : t(`revenue.finding.${kind}`, vars)}
      rest={split ? t(`revenue.finding.${kind}.rest`, vars) : null}
    />
  );
}

/** Share of the HT target reached; the lighter arc is the projection's share. */
function TargetRing({ share, projected, label }: { share: number; projected: number | null; label: string }) {
  const c = 2 * Math.PI * RING_R;
  const arc = (v: number) => `${Math.min(Math.max(v, 0), 1) * c} ${c}`;
  const color = (projected ?? share) >= 1 ? GREEN : AMBER;
  return (
    <svg viewBox="0 0 120 120" className="w-[92px] flex-none" role="img" aria-label={label}>
      <circle cx="60" cy="60" r={RING_R} fill="none" stroke="#2d2d2d" strokeWidth="11" />
      {projected != null && (
        <circle data-arc="projection" cx="60" cy="60" r={RING_R} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth="11"
          strokeDasharray={arc(projected)} transform="rotate(-90 60 60)" strokeLinecap="round" />
      )}
      <circle data-arc="share" cx="60" cy="60" r={RING_R} fill="none" stroke={color} strokeWidth="11"
        strokeDasharray={arc(share)} transform="rotate(-90 60 60)" strokeLinecap="round" />
      <text x="60" y="68" textAnchor="middle" className="fill-white text-[24px] font-semibold">{pctText(share)}</text>
    </svg>
  );
}

function Sparkline({ buckets, mode }: { buckets: RevenueBucket[]; mode: TaxMode }) {
  const vals = buckets.slice(-SPARK_POINTS).map((b) => Math.max(0, pick(b, mode)));
  const max = Math.max(1, ...vals);
  const step = vals.length > 1 ? 156 / (vals.length - 1) : 0;
  return (
    <svg data-testid="revenue-sparkline" viewBox="0 0 160 44" className="hidden w-[160px] flex-none sm:block" aria-hidden="true">
      <polyline fill="none" stroke={GREEN} strokeWidth="2" strokeLinejoin="round" points={vals.map((v, i) => `${2 + i * step},${40 - (v / max) * 36}`).join(' ')} />
    </svg>
  );
}

/** The last period in large type with its two comparisons, the target ring (or a sparkline), then the other figures as tiles. */
export function RevenueHero({ payload, taxMode, canMargin, onSetTarget }: {
  payload: RevenueResponse;
  taxMode: TaxMode;
  canMargin: boolean;
  /** Opens the targets editor; offered while the period has no target. */
  onSetTarget?: () => void;
}) {
  const { t } = useTranslation();
  const { buckets, granularity: g } = payload;
  const last = buckets[buckets.length - 1];
  if (!last) return null;
  // The running total repeats the hero figure whenever the window is one period, so it is not a tile.
  const [, previous] = kpiTiles(buckets, taxMode, g, 0, FR_UNIT[g]);
  const insights = insightTiles(buckets, taxMode, FR_UNIT[g]).filter((x) => x.kind !== 'share' && (canMargin || x.label !== MARGIN_LABEL));
  const tiles = [previous, ...insights];
  const target = targetOf(last);
  const share = target ? last.ht / target : null;
  const projectedShare = target && last.projection ? last.projection.ht / target : null;
  const deltas = [
    { value: evolutionFor(last, taxMode), what: comparison(t, buckets, g, 'previous') },
    // A year's previous period is the year ago: one badge, not the same one twice.
    ...(g === 'year' ? [] : [{ value: yearOverYear(last, taxMode), what: comparison(t, buckets, g, 'year-ago') }]),
  ].filter((d) => d.value != null && d.what);
  const title =
    last.partial && last.elapsedDays != null
      ? t('revenue.hero.partial', { period: last.label, day: last.elapsedDays, total: daysBetween(last.start, last.end) })
      : last.label;
  // The projection has its own tile; the corner names the target, or offers to set one.
  const action = target ? (
    <span className="text-[11.5px] text-bambu-gray-light tabular-nums">{t('revenue.hero.target', { amount: formatFcp(target) })}</span>
  ) : onSetTarget && (g === 'month' || g === 'year') ? (
    <button type="button" onClick={onSetTarget} className={`rounded text-[11.5px] text-bambu-green hover:text-white ${focusRingCls}`}>
      {t('revenue.hero.setTarget')}
    </button>
  ) : undefined;

  return (
    <Panel title={title} action={action}>
      <div className="flex items-center gap-4 rounded-lg bg-bambu-dark px-4 py-3">
        {share != null && (
          <TargetRing
            share={share}
            projected={projectedShare}
            label={
              projectedShare != null
                ? t('revenue.hero.ringProjected', { share: pctText(share), projected: pctText(projectedShare) })
                : t('revenue.hero.ring', { share: pctText(share) })
            }
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[28px] sm:text-[36px] font-semibold leading-[1.1] tracking-[-0.02em] text-white tabular-nums">
            <span>{formatFcp(pick(last, taxMode))}</span> <span className="text-sm font-normal text-bambu-gray">{t(`revenue.${taxMode}`)}</span>
          </p>
          {deltas.length > 0 && (
            <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs tabular-nums">
              {deltas.map((d) => (
                <span key={d.what} className="inline-flex items-baseline gap-1">
                  <DeltaBadge delta={asDelta(d.value)} />
                  <span className="text-bambu-gray">{t('revenue.hero.vs', { what: d.what })}</span>
                </span>
              ))}
            </p>
          )}
        </div>
        {share == null && <Sparkline buckets={buckets} mode={taxMode} />}
      </div>
      {/* Two per row: the card then matches the pace chart beside it, and a phone shows pairs, not a column. */}
      <div className="mt-2 grid grid-cols-2 gap-2">
        {tiles.map((tile) => (
          <div key={tile.label} className="grid">
            <Tile
              {...tileText(t, tile, g, last)}
              value={tile.value == null ? '—' : formatFcp(tile.value)}
              tone={tile.tone === 'down' ? 'alert' : undefined}
            />
          </div>
        ))}
      </div>
    </Panel>
  );
}
