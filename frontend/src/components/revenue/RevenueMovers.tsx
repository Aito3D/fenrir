import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Facts, Panel } from '../aito/stats/primitives';
import { Skeleton } from '../Skeleton';
import { PICK_CLS } from './RevenueControls';
import { dateInputCls } from './styles';
import { REVENUE_HISTORY_START } from './lib/dates';
import { formatFcp, formatPct } from './lib/format';
import type { DayRange, Mover, MoversResponse, RevenueGranularity } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

type Compare = { from: string; to: string; cfrom: string; cto: string };

const signed = (n: number) => `${n > 0 ? '+' : ''}${formatFcp(n)}`;
const tone = (up: boolean) => (up ? 'text-status-ok' : 'text-status-error');

/** Same rule as the range popover: an incomplete, inverted or out-of-bounds pair is flagged and not requested. */
function rangeFlags(from: string, to: string, today: string) {
  const inverted = !!from && !!to && from > to;
  return { fromBad: !from || from < REVENUE_HISTORY_START || inverted, toBad: !to || to > today || inverted };
}
const pairValid = (c: Compare, today: string) => {
  const a = rangeFlags(c.from, c.to, today);
  const b = rangeFlags(c.cfrom, c.cto, today);
  return !a.fromBad && !a.toBad && !b.fromBad && !b.toBad;
};

function MoverList({ title, movers, up }: { title: string; movers: Mover[]; up: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <p className={`text-xs font-medium ${tone(up)}`}>{`${up ? '▲' : '▼'} ${title}`}</p>
      {movers.length === 0 ? (
        <p className="px-3 text-xs text-bambu-gray">{t('revenue.movers.none')}</p>
      ) : (
        <Facts
          rows={movers.map((m) => ({
            label: <span className="block truncate" title={m.label}>{m.label}</span>,
            value: <span className={tone(up)}>{`${up ? '▲' : '▼'} ${signed(m.delta)}`}</span>,
            note: m.change == null ? t('revenue.movers.new') : formatPct(m.change),
          }))}
        />
      )}
    </div>
  );
}

function RangeInputs({ name, from, to, today, onChange }: { name: string; from: string; to: string; today: string; onChange: (from: string, to: string) => void }) {
  const { t } = useTranslation();
  const { fromBad, toBad } = rangeFlags(from, to, today);
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-4 text-xs text-bambu-gray">{name}</span>
      <input type="date" aria-label={t('revenue.movers.rangeStart', { name })} aria-invalid={fromBad || undefined} className={dateInputCls(fromBad)}
        min={REVENUE_HISTORY_START} max={today} value={from} onChange={(e) => onChange(e.target.value, to)} />
      <span aria-hidden className="text-sm text-bambu-gray">→</span>
      <input type="date" aria-label={t('revenue.movers.rangeEnd', { name })} aria-invalid={toBad || undefined} className={dateInputCls(toBad)}
        min={REVENUE_HISTORY_START} max={today} value={to} onChange={(e) => onChange(from, e.target.value)} />
    </div>
  );
}

/** « Mouvements »: the biggest movers of the last bucket vs the one before it, or of two free periods A and B. */
export function RevenueMovers(p: { granularity: RevenueGranularity; bucketKey: string | null; bucketLabel: string; filterParams: string; version: unknown; today: string }) {
  const { t, i18n } = useTranslation();
  // `draft` is what the inputs show; `compare` the last valid pair, the one requested.
  const [draft, setDraft] = useState<Compare | null>(null);
  const [compare, setCompare] = useState<Compare | null>(null);
  const bucketUrl = `/api/v1/revenue/movers?granularity=${p.granularity}${p.bucketKey ? `&key=${encodeURIComponent(p.bucketKey)}` : ''}${p.filterParams}`;
  const url = compare ? `/api/v1/revenue/movers?from=${compare.from}&to=${compare.to}&cfrom=${compare.cfrom}&cto=${compare.cto}${p.filterParams}` : bucketUrl;
  const { data, error } = useRevenueResource<MoversResponse>(url, p.version);
  const totals = data?.totals;
  const delta = totals ? totals.current - totals.previous : 0;
  const date = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const fmtRange = (r: DayRange) => {
    const f = date.format(new Date(`${r.from}T00:00:00Z`));
    return r.from === r.to ? f : `${f} – ${date.format(new Date(`${r.to}T00:00:00Z`))}`;
  };
  const edit = (next: Compare) => {
    setDraft(next);
    if (pairValid(next, p.today)) setCompare(next);
  };
  const toggle = () => {
    if (draft) {
      setDraft(null);
      setCompare(null);
    } else if (data) {
      const c = { from: data.current.from, to: data.current.to, cfrom: data.previous.from, cto: data.previous.to };
      setDraft(c);
      setCompare(c);
    }
  };

  return (
    <Panel
      title={draft ? t('revenue.movers.compareTitle') : t('revenue.movers.title')}
      action={
        <button type="button" aria-pressed={draft !== null} disabled={!data && !draft} onClick={toggle} className={`${PICK_CLS} px-2.5 py-1 text-xs`}>
          {draft ? t('revenue.movers.back') : t('revenue.movers.compare')}
        </button>
      }
    >
      <div className="space-y-3">
        {draft ? (
          <div className="space-y-2">
            <RangeInputs name="A" from={draft.from} to={draft.to} today={p.today} onChange={(from, to) => edit({ ...draft, from, to })} />
            <RangeInputs name="B" from={draft.cfrom} to={draft.cto} today={p.today} onChange={(cfrom, cto) => edit({ ...draft, cfrom, cto })} />
            {totals && (
              <p className="text-xs tabular-nums text-bambu-gray-light">
                {`A ${formatFcp(totals.current)} · B ${formatFcp(totals.previous)} · ${signed(delta)}${totals.previous > 0 ? ` (${formatPct(delta / totals.previous)})` : ''} ${t('revenue.ht')}`}
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-bambu-gray">
            {t('revenue.movers.subtitle', { label: p.bucketLabel })}
            {data && <span className="block tabular-nums">{`${fmtRange(data.current)} ${t('revenue.hero.vs', { what: fmtRange(data.previous) })}`}</span>}
          </p>
        )}
        {error && !data ? (
          <p className="text-sm text-status-error">{error}</p>
        ) : !data ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            {(['items', 'brands'] as const).map((k) => (
              <section key={k} className="space-y-2">
                <h3 className="text-[13px] font-medium text-white">{t(k === 'items' ? 'revenue.movers.products' : 'revenue.filters.brands')}</h3>
                <MoverList title={t('revenue.movers.up')} movers={data[k].up} up />
                <MoverList title={t('revenue.movers.down')} movers={data[k].down} up={false} />
              </section>
            ))}
          </>
        )}
      </div>
    </Panel>
  );
}
