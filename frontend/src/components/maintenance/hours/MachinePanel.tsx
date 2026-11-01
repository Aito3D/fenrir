import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { HourEvent, HourMachine, HourReading } from '../../../api/client';
import { useDismissableDialog } from '../../../hooks/useDismissableDialog';
import {
  behaviourFlag, dayNumber, familyOf, forecastDate, loadShare, periodPaces, ratePerMonth, seriesPoints, type MachineSeries,
} from '../../../utils/hoursSeries';
import { Button } from '../../Button';
import { focusRingCls } from '../../formStyles';
import { MachineCost } from './MachineCost';
import { MachineEvents } from './MachineEvents';
import { TrustMark } from './TrustMark';

interface MachinePanelProps {
  machine: HourMachine;
  series: MachineSeries;
  readings: HourReading[];
  events: HourEvent[];
  today: string;
  color: string;
  currency: string;
  canEdit: boolean;
  onEditDate: (date: string) => void;
  onAddEvent: (machineId: number, body: { event_date: string; label: string }) => void;
  onDeleteEvent: (id: number) => void;
  onSavePurchase: (machineId: number, body: { purchase_price: number | null; purchase_date: string | null }) => void;
  onClose: () => void;
  /** True while a dialog opened from the panel (the reading form) is on top: Escape and backdrop clicks are its. */
  suspendDismiss?: boolean;
}

/** Slide-over (bottom sheet on phones) for digging into one machine. */
export function MachinePanel({
  machine, series, readings, events, today, color, currency, canEdit,
  onEditDate, onAddEvent, onDeleteEvent, onSavePurchase, onClose, suspendDismiss = false,
}: MachinePanelProps) {
  const { t, i18n } = useTranslation();
  const { requestClose, dialogRef } = useDismissableDialog(onClose, {
    onEscape: (close) => { if (!suspendDismiss) close(); },
  });
  const fmt = (n: number) => Math.round(n).toLocaleString(i18n.language);
  const fullFmt = new Intl.DateTimeFormat(i18n.language, { timeZone: 'UTC' });
  const shortFmt = new Intl.DateTimeFormat(i18n.language, { timeZone: 'UTC', day: 'numeric', month: 'short' });
  const date = (iso: string) => fullFmt.format(dayNumber(iso) * 86_400_000);
  const short = (iso: string) => shortFmt.format(dayNumber(iso) * 86_400_000);

  const live = !machine.retired;
  const last = series.manual.at(-1) ?? null;
  const periods = periodPaces(series.manual);
  const flag = live ? behaviourFlag(periods) : null;
  const pace = ratePerMonth(seriesPoints(series), today);
  const load = loadShare(pace);
  const forecast = live && last && machine.next_service_hours != null && pace !== null && pace > 0
    ? forecastDate(last, pace, machine.next_service_hours)
    : null;

  const rawOn = new Map(
    readings
      .filter((r) => r.machine_id === machine.id && r.source === 'auto' && r.raw_hours != null)
      .map((r) => [r.reading_date, r.raw_hours as number]),
  );
  const paceTo = new Map(periods.map((p) => [p.to, p.pace]));
  const rows = [...series.manual].reverse().map((p) => ({ ...p, rate: paceTo.get(p.date) ?? null, raw: rawOn.get(p.date) }));
  const showCost = live && (canEdit || machine.purchase_price != null);
  const titleId = `hours-panel-title-${machine.id}`;
  const drifting = machine.trust === 'drifting';

  return (
    <div data-testid="hours-panel-backdrop" className="fixed inset-0 z-40 bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget && !suspendDismiss) requestClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fixed inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-2xl focus:outline-none sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:max-h-none sm:w-full sm:max-w-[420px] sm:rounded-none sm:border-y-0 sm:border-r-0"
      >
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <header data-testid="hours-panel-header" className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
              <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold text-white">{machine.name}</h2>
              {live && <TrustMark machine={machine} size="md" />}
              <button type="button" aria-label={t('common.close')} onClick={requestClose} className={`rounded p-1 text-bambu-gray hover:text-white ${focusRingCls}`}>
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <p className="text-xs text-bambu-gray">
              {familyOf(machine)}
              {machine.added_on && ` · ${t('maintenance.hours.panel.added', { date: date(machine.added_on) })}`}
            </p>
            {live && machine.trust === 'uncalibrated' && (
              <p className="text-xs text-bambu-gray">{t('maintenance.hours.trust.notCalibratedHelp')}</p>
            )}
            {live && drifting && (
              <p className="text-xs text-bambu-gray">
                {t('maintenance.hours.trust.driftHelp')}{' '}
                {t('maintenance.hours.trust.drifting', { hours: Math.round(Math.abs(machine.last_drift_hours ?? 0)) })}
              </p>
            )}
            {live && machine.trust !== 'calibrated' && (
              <Button variant="secondary" size="sm" onClick={() => onEditDate(today)}>{t('maintenance.hours.panel.takeReading')}</Button>
            )}
            {last && (
              <p className="text-sm text-white">
                <span className="font-medium">{`${fmt(last.hours)} h`}</span>{' '}
                <span className="text-bambu-gray">{t('maintenance.hours.panel.lifetimeOn', { date: date(last.date) })}</span>
              </p>
            )}
          </header>

          {live && (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-white">{t('maintenance.hours.panel.pace')}</h3>
              <div className="flex items-start gap-3">
                {periods.slice(-3).map((p) => (
                  <div key={p.to} className="min-w-0 flex-1 text-xs text-bambu-gray">
                    <div className="truncate">{`${short(p.from)} → ${short(p.to)}`}</div>
                    <div className="text-sm font-medium text-white">{t('maintenance.hours.perMonth', { hours: fmt(p.pace) })}</div>
                  </div>
                ))}
                {flag && (
                  <span className="shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-xs text-amber-400">
                    {t(`maintenance.hours.flag.${flag}`)}
                  </span>
                )}
              </div>
              {load !== null ? (
                <div className="flex items-center gap-2 text-xs text-bambu-gray">
                  <span>{t('maintenance.hours.panel.load')}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-bambu-dark">
                    <div className="h-full rounded" style={{ width: `${Math.min(100, load * 100)}%`, background: color }} />
                  </div>
                  <span className="tabular-nums text-white">{`${Math.round(load * 100)} %`}</span>
                </div>
              ) : (
                <p className="text-xs text-bambu-gray">{t('maintenance.hours.noRecentReading')}</p>
              )}
              {forecast && pace !== null && (
                <p className="text-sm text-white">
                  {t('maintenance.hours.panel.forecast', { pace: fmt(pace), hours: fmt(machine.next_service_hours as number), date: date(forecast) })}
                </p>
              )}
            </section>
          )}

          <section className="space-y-1">
            <h3 className="text-sm font-semibold text-white">{t('maintenance.hours.panel.readings')}</h3>
            {rows.map((r) => {
              const body = (
                <>
                  <span className="w-24 shrink-0 text-bambu-gray">{date(r.date)}</span>
                  <span className="flex-1 tabular-nums text-white">{`${fmt(r.hours)} h`}</span>
                  <span className="w-24 text-right tabular-nums text-bambu-gray">
                    {r.rate !== null ? t('maintenance.hours.perMonth', { hours: fmt(r.rate) }) : '—'}
                  </span>
                  <span className="w-20 text-right tabular-nums text-xs text-bambu-gray/70">
                    {r.raw !== undefined && `${t('maintenance.hours.panel.rawOnDate')} ${fmt(r.raw)}`}
                  </span>
                </>
              );
              const cls = 'flex w-full items-center gap-2 rounded px-1 py-1 text-left text-sm';
              return canEdit ? (
                <button
                  key={r.date}
                  type="button"
                  data-testid="hours-panel-reading"
                  aria-label={`${t('common.edit')} ${date(r.date)}`}
                  onClick={() => onEditDate(r.date)}
                  className={`${cls} hover:bg-bambu-dark-tertiary ${focusRingCls}`}
                >
                  {body}
                </button>
              ) : (
                <div key={r.date} data-testid="hours-panel-reading" className={cls}>{body}</div>
              );
            })}
          </section>

          <MachineEvents
            events={events}
            today={today}
            canEdit={canEdit}
            onAdd={(body) => onAddEvent(machine.id, body)}
            onDelete={onDeleteEvent}
          />

          {showCost && (
            <MachineCost
              machine={machine}
              lifetime={last}
              currency={currency}
              canEdit={canEdit}
              onSave={(body) => onSavePurchase(machine.id, body)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
