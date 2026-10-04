import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { HourMachine } from '../../../api/client';
import { familyOf } from '../../../utils/hoursSeries';

export interface MachineStat {
  hours: number | null;
  rate: number | null;
}

interface MachineListProps {
  machines: HourMachine[];
  colors: Map<number, string>;
  hidden: Set<number>;
  stats: Map<number, MachineStat>;
  canDelete: boolean;
  onToggle: (id: number) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  onDeleteRetired: (machine: HourMachine) => void;
}

const fmt = (n: number) => Math.round(n).toLocaleString();

export function MachineList({
  machines, colors, hidden, stats, canDelete, onToggle, onShowAll, onHideAll, onDeleteRetired,
}: MachineListProps) {
  const { t } = useTranslation();
  const active = machines.filter((m) => !m.retired);
  const families = [...new Set(active.map(familyOf))].sort();
  const groups: { label: string; items: HourMachine[] }[] = [
    ...families.map((f) => ({
      label: f === 'OTHER' ? '—' : f,
      items: active.filter((m) => familyOf(m) === f).sort((a, b) => a.name.localeCompare(b.name)),
    })),
    { label: t('maintenance.hours.retired'), items: machines.filter((m) => m.retired) },
  ].filter((g) => g.items.length > 0);

  return (
    <div data-testid="hours-machine-list" className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-2 text-xs text-bambu-gray">
        <span>{t('maintenance.hours.machines')}</span>
        <span className="flex gap-2">
          <button type="button" className="text-bambu-green hover:underline" onClick={onShowAll}>
            {t('maintenance.hours.showAll')}
          </button>
          <button type="button" className="text-bambu-green hover:underline" onClick={onHideAll}>
            {t('maintenance.hours.showNone')}
          </button>
        </span>
      </div>
      <div className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {groups.map((g) => (
          <div key={g.label} className="flex gap-1 md:flex-col">
            <div className="hidden px-2 pt-3 text-[0.7rem] uppercase tracking-wider text-bambu-gray md:block">
              {g.label}
            </div>
            {g.items.map((m) => {
              const on = !hidden.has(m.id);
              const stat = stats.get(m.id);
              return (
                <div key={m.id} className="group flex shrink-0 items-center">
                  <button
                    type="button"
                    data-testid="hours-machine-row"
                    data-name={m.name}
                    aria-pressed={on}
                    onClick={() => onToggle(m.id)}
                    className={`flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-opacity hover:bg-bambu-dark-tertiary ${on ? '' : 'opacity-40'}`}
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colors.get(m.id) }} />
                    <span className="text-white">{m.name}</span>
                    <span className="ml-auto hidden text-right tabular-nums md:block">
                      {stat?.hours != null && <span className="text-white">{fmt(stat.hours)} h</span>}
                      {stat?.rate != null && (
                        <span className="block text-[0.7rem] text-bambu-gray">
                          {t('maintenance.hours.perMonth', { hours: fmt(stat.rate) })}
                        </span>
                      )}
                    </span>
                  </button>
                  {m.retired && canDelete && (
                    <button
                      type="button"
                      aria-label={t('maintenance.hours.deleteMachineTitle')}
                      onClick={() => onDeleteRetired(m)}
                      className="hidden p-1 text-bambu-gray opacity-0 hover:text-red-400 group-hover:opacity-100 md:block"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
