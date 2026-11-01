import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { HourMachine } from '../../../api/client';
import { familyOf, loadShare, type fleetFacts } from '../../../utils/hoursSeries';

const TILE = 'rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3';
const LABEL = 'text-xs text-bambu-gray';
const VALUE = 'text-xl font-semibold tabular-nums text-white';

interface Props {
  facts: ReturnType<typeof fleetFacts>;
  machines: HourMachine[];
  paces: Map<number, number | null>;
  onTakeReadings: () => void;
}

interface LoadRow {
  name: string;
  pct: number | null;
}

/** Live machines grouped by family, busiest first, stale (no pace) last. */
function loadGroups(machines: HourMachine[], paces: Map<number, number | null>): { family: string; rows: LoadRow[] }[] {
  const groups = new Map<string, LoadRow[]>();
  for (const m of machines) {
    if (m.retired) continue;
    const share = loadShare(paces.get(m.id) ?? null);
    const row = { name: m.name, pct: share === null ? null : share * 100 };
    const fam = familyOf(m);
    groups.set(fam, [...(groups.get(fam) ?? []), row]);
  }
  return [...groups].map(([family, rows]) => ({
    family,
    rows: rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1)),
  }));
}

export function FleetStrip({ facts, machines, paces, onTakeReadings }: Props) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const fmt = (n: number) => Math.round(n).toLocaleString(i18n.language);
  const live = machines.filter((m) => !m.retired).length;
  const busiest = facts.busiest ? machines.find((m) => m.id === facts.busiest!.id) : undefined;
  const due = facts.due > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-stretch gap-2">
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-3 md:grid-cols-4">
          <div className={TILE}>
            <div className={LABEL}>{t('maintenance.hours.strip.lifetime')}</div>
            <div className={VALUE}>{`${fmt(facts.lifetime)} h`}</div>
            <div className={LABEL}>
              {t('maintenance.hours.strip.machinesCount', { live, sold: machines.length - live })}
            </div>
          </div>
          <div className={TILE}>
            <div className={LABEL}>{t('maintenance.hours.strip.thisMonth')}</div>
            <div className={VALUE}>{`${fmt(facts.thisMonth)} h`}</div>
            <div className={LABEL}>{t('maintenance.hours.strip.thisMonthSub')}</div>
          </div>
          <button
            type="button"
            aria-label={t('maintenance.hours.strip.takeReadings')}
            onClick={onTakeReadings}
            className={`${TILE} text-left transition-colors hover:bg-bambu-dark-tertiary ${due ? 'border-amber-400/60' : ''}`}
          >
            <div className={LABEL}>{t('maintenance.hours.strip.readingsDue')}</div>
            <div className={`text-xl font-semibold tabular-nums ${due ? 'text-amber-400' : 'text-bambu-gray'}`}>{facts.due}</div>
            <div className={LABEL}>
              {t(due ? 'maintenance.hours.strip.dueSub' : 'maintenance.hours.strip.allFresh')}
            </div>
          </button>
          <div className={TILE}>
            <div className={LABEL}>{t('maintenance.hours.strip.busiest')}</div>
            <div className={VALUE}>{busiest?.name ?? '—'}</div>
            <div className={LABEL}>
              {facts.busiest
                ? t('maintenance.hours.perMonth', { hours: fmt(facts.busiest.pace) })
                : t('maintenance.hours.noRecentReading')}
            </div>
          </div>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-label={t('maintenance.hours.strip.load')}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center rounded-lg px-1.5 text-bambu-gray hover:text-white"
        >
          <ChevronDown className={`h-5 w-5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open && (
        <div className={`${TILE} flex flex-col gap-3`}>
          {loadGroups(machines, paces).map(({ family, rows }) => (
            <div key={family} className="flex flex-col gap-1.5">
              <div className="text-xs font-medium uppercase tracking-wide text-bambu-gray">{family}</div>
              {rows.map((r) => (
                <div key={r.name} data-testid="hours-load-row" data-name={r.name} className="flex items-center gap-3 text-sm text-white">
                  <span className="w-16 shrink-0">{r.name}</span>
                  {r.pct === null ? (
                    <span className="text-xs text-bambu-gray">{t('maintenance.hours.noRecentReading')}</span>
                  ) : (
                    <>
                      <span className="h-2 flex-1 rounded bg-bambu-dark-tertiary">
                        <i className="block h-full rounded bg-bambu-green" style={{ width: `${Math.min(100, Math.round(r.pct))}%` }} />
                      </span>
                      <span className="w-12 text-right tabular-nums">{`${Math.round(r.pct)} %`}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
