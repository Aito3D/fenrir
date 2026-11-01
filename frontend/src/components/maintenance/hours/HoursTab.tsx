import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { ClipboardPaste, ListChecks, Loader2, Plus } from 'lucide-react';
import { api, type HourMachine } from '../../../api/client';
import { useCurrency } from '../../../hooks/useCurrency';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { dayNumber, fleetFacts, gapInfo, machineColors, machineSeries, railOrder, ratePerMonth, seriesPoints } from '../../../utils/hoursSeries';
import { Button } from '../../Button';
import { Card, CardContent } from '../../Card';
import { ConfirmModal } from '../../ConfirmModal';
import { FleetStrip } from './FleetStrip';
import { FocusHeader } from './FocusHeader';
import { HoursChart, type HoursChartMode, type HoursChartRange } from './HoursChart';
import { MachineList } from './MachineList';
import { MachinePanel } from './MachinePanel';
import { PasteImportModal } from './PasteImportModal';
import { ReadingFormModal } from './ReadingFormModal';
import { ReadingLog } from './ReadingLog';
import { ReadingPass } from './ReadingPass';
import { ReadingTimeline } from './ReadingTimeline';

const MODES: HoursChartMode[] = ['cumulative', 'monthly', 'total', 'sameAge'];
const RANGES: HoursChartRange[] = ['3m', '12m', 'all'];
const MODE_KEY: Record<HoursChartMode, string> = {
  cumulative: 'maintenance.hours.modeCumulative',
  monthly: 'maintenance.hours.modeMonthly',
  total: 'maintenance.hours.modeTotal',
  sameAge: 'maintenance.hours.modeSameAge',
};

export function HoursTab() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('maintenance:update');
  const canDelete = hasPermission('maintenance:delete');

  const { data, isLoading } = useQuery({
    queryKey: ['maintenanceHours'],
    queryFn: api.getPrinterHours,
    refetchInterval: 15 * 60 * 1000, // keep the server's "today" fresh across midnight
  });
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<HoursChartMode>('cumulative');
  const [formDate, setFormDate] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [passOpen, setPassOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const wantsPass = searchParams.get('pass') === '1';
  const closePass = useCallback(() => {
    setPassOpen(false);
    setSearchParams((prev) => { prev.delete('pass'); return prev; }, { replace: true });
  }, [setSearchParams]);
  const [confirmDate, setConfirmDate] = useState<string | null>(null);
  const [confirmMachine, setConfirmMachine] = useState<HourMachine | null>(null);
  const [panelId, setPanelId] = useState<number | null>(() => {
    const n = Number(searchParams.get('machine'));
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  // The panel mirrors ?machine= so a machine can be linked to.
  useEffect(() => {
    setSearchParams((prev) => {
      if (panelId) prev.set('machine', String(panelId));
      else prev.delete('machine');
      return prev;
    }, { replace: true });
  }, [panelId, setSearchParams]);
  const currency = useCurrency();
  const [focusId, setFocusId] = useState<number | null>(null);
  const [focusPinned, setFocusPinned] = useState(false);
  const [range, setRange] = useState<HoursChartRange>('all');
  const serverInterval = data?.reading_interval_days;
  const [intervalDraft, setIntervalDraft] = useState('');
  useEffect(() => {
    if (serverInterval !== undefined) setIntervalDraft(String(serverInterval));
  }, [serverInterval]);

  const machines = useMemo(() => data?.machines ?? [], [data]);
  const series = useMemo(
    () => new Map(machines.map((m) => [m.id, machineSeries(data?.readings ?? [], m.id)])),
    [machines, data],
  );
  const colors = useMemo(() => machineColors(machines), [machines]);
  const values = useMemo(() => {
    const out = new Map<number, number | null>();
    for (const m of machines) {
      const mine = series.get(m.id)!;
      const pts = seriesPoints(mine);
      const lastManual = mine.manual.at(-1);
      const counterOk = m.current_hours != null && (!lastManual || m.current_hours >= lastManual.hours);
      out.set(m.id, counterOk ? m.current_hours : pts.length ? pts[pts.length - 1].hours : null);
    }
    return out;
  }, [machines, series]);

  // Hover moves the focus only while nothing is pinned by a click on a curve.
  const hoverFocus = useCallback((id: number | null) => { if (!focusPinned) setFocusId(id); }, [focusPinned]);
  const pinFocus = useCallback((id: number) => { setFocusId(id); setFocusPinned(true); }, []);
  const clearOnEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { setFocusId(null); setFocusPinned(false); }
  };

  const passMachines = useMemo(() => railOrder(machines), [machines]);
  // ?pass=1 opens the pass once the data is there.
  const loaded = data !== undefined;
  useEffect(() => {
    if (loaded && wantsPass) setPassOpen(true);
  }, [loaded, wantsPass]);

  const saveReadings = useMutation({
    mutationFn: ({ date, entries }: { date: string; entries: { machine_id: number; hours: number | null }[] }) =>
      api.saveHourReadings(date, entries),
    onSuccess: (overview) => {
      queryClient.setQueryData(['maintenanceHours'], overview);
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
      queryClient.invalidateQueries({ queryKey: ['maintenanceSummary'] });
      setFormDate(null);
      closePass();
      showToast(t('maintenance.hours.saved'));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const updateInterval = useMutation({
    mutationFn: (days: number) => api.updateHourSettings({ reading_interval_days: days }),
    onSuccess: (overview) => {
      queryClient.setQueryData(['maintenanceHours'], overview);
      showToast(t('maintenance.hours.intervalSaved'));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const addEvent = useMutation({
    mutationFn: ({ machineId, body }: { machineId: number; body: { event_date: string; label: string } }) =>
      api.createHourEvent(machineId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['maintenanceHours'] }),
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const deleteEvent = useMutation({
    mutationFn: (id: number) => api.deleteHourEvent(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['maintenanceHours'] }),
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const savePurchase = useMutation({
    mutationFn: ({ machineId, body }: { machineId: number; body: { purchase_price: number | null; purchase_date: string | null } }) =>
      api.updateHourMachine(machineId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceHours'] });
      showToast(t('maintenance.hours.cost.saved'));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const importReadings = useMutation({
    mutationFn: api.importHourReadings,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceHours'] });
      setPasteOpen(false);
      showToast(t('maintenance.hours.paste.imported', { n: result.readings_written }));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const deleteDate = useMutation({
    mutationFn: (date: string) => api.deleteHourReadings(date),
    onSuccess: (overview) => {
      queryClient.setQueryData(['maintenanceHours'], overview);
      showToast(t('maintenance.hours.deleted'));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
    onSettled: () => setConfirmDate(null),
  });
  const deleteMachine = useMutation({
    mutationFn: (id: number) => api.deleteHourMachine(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceHours'] });
      showToast(t('maintenance.hours.machineDeleted'));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
    onSettled: () => setConfirmMachine(null),
  });

  // An unknown ?machine= id (deleted machine, stale link) clears itself.
  useEffect(() => {
    if (loaded && panelId !== null && !machines.some((m) => m.id === panelId)) setPanelId(null);
  }, [loaded, panelId, machines]);

  if (isLoading || !data) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-bambu-green" /></div>;
  }

  const gap = gapInfo(machines, series, data.today);
  const facts = fleetFacts(machines, series, data.readings, data.today, data.due_machine_ids);
  const paces = new Map(machines.map((m) => [m.id, ratePerMonth(seriesPoints(series.get(m.id)!), data.today)]));
  const dayFmt = new Intl.DateTimeFormat(i18n.language, { timeZone: 'UTC' });
  const fleetLine = t('maintenance.hours.fleetLine', {
    machines: machines.length,
    date: gap.lastDate ? dayFmt.format(dayNumber(gap.lastDate) * 86_400_000) : '—',
  });
  const focused = machines.find((m) => m.id === focusId) ?? null;
  const panelMachine = machines.find((m) => m.id === panelId) ?? null;

  const commitInterval = () => {
    const days = Number(intervalDraft);
    if (Number.isInteger(days) && days >= 7 && days <= 365) {
      if (days !== data.reading_interval_days) updateInterval.mutate(days);
    } else {
      setIntervalDraft(String(data.reading_interval_days));
    }
  };

  const toggle = (id: number) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div
      className="grid grid-cols-1 gap-4 md:grid-cols-[280px_minmax(0,1fr)]"
      data-panel-id={panelId ?? undefined}
      data-focus-id={focusId ?? undefined}
    >
      <Card className="min-w-0 md:max-h-[640px] md:overflow-auto">
        <CardContent>
          <MachineList
            machines={machines}
            colors={colors}
            hidden={hidden}
            series={series}
            values={values}
            canDelete={canDelete}
            onToggle={toggle}
            onShowAll={() => setHidden(new Set())}
            onHideAll={() => setHidden(new Set(machines.map((m) => m.id)))}
            onDeleteRetired={setConfirmMachine}
            onOpen={(m) => setPanelId(m.id)}
            onHover={hoverFocus}
          />
        </CardContent>
      </Card>
      <div className="flex min-w-0 flex-col gap-4">
        <FleetStrip facts={facts} machines={machines} paces={paces} onTakeReadings={() => setPassOpen(true)} />
        <Card>
          <CardContent>
            <div tabIndex={0} onKeyDown={clearOnEscape} className="outline-none">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-0.5">
                {MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`rounded-md px-3 py-1 text-sm ${mode === m ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'}`}
                  >
                    {t(MODE_KEY[m])}
                  </button>
                ))}
              </div>
              <div role="group" aria-label={t('maintenance.hours.range.label')} className="inline-flex rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-0.5">
                {RANGES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={range === r}
                    onClick={() => setRange(r)}
                    className={`rounded-md px-3 py-1 text-sm ${range === r ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'}`}
                  >
                    {t(`maintenance.hours.range.${r}`)}
                  </button>
                ))}
              </div>
              {canEdit && (
                <div className="ml-auto flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setPassOpen(true)}>
                    <ListChecks className="h-4 w-4" />
                    {t('maintenance.hours.pass.title')}
                  </Button>
                  <Button size="sm" onClick={() => setFormDate(data.today)}>
                    <Plus className="h-4 w-4" />
                    {t('maintenance.hours.newReading')}
                  </Button>
                </div>
              )}
            </div>
            <FocusHeader
              machine={focused}
              series={focused ? series.get(focused.id) ?? null : null}
              color={focused ? colors.get(focused.id) ?? '' : ''}
              today={data.today}
              fleetLine={fleetLine}
              onOpen={setPanelId}
            />
            <HoursChart
              mode={mode} machines={machines} hidden={hidden} series={series} colors={colors} today={data.today}
              range={range} focusId={focusId} onFocus={hoverFocus} onPin={pinFocus} events={data.events} gap={gap}
            />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="mb-1 flex items-center">
              <h3 className="font-semibold text-white">{t('maintenance.hours.readingLog')}</h3>
              {canEdit ? (
                <label className="ml-3 flex items-center gap-1 text-xs text-bambu-gray">
                  {t('maintenance.hours.readingsEvery')}
                  <input
                    type="number"
                    min={7}
                    max={365}
                    aria-label={t('maintenance.hours.readingsEvery')}
                    className="w-14 rounded border border-bambu-dark-tertiary bg-bambu-dark px-1 py-0.5 text-right text-white"
                    value={intervalDraft}
                    onChange={(e) => setIntervalDraft(e.target.value)}
                    onBlur={commitInterval}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitInterval(); }}
                  />
                  {t('maintenance.hours.days')}
                </label>
              ) : (
                <span className="ml-3 text-xs text-bambu-gray">
                  {t('maintenance.hours.readingsEveryRead', { days: data.reading_interval_days })}
                </span>
              )}
              {canEdit && (
                <Button className="ml-auto" variant="secondary" size="sm" onClick={() => setPasteOpen(true)}>
                  <ClipboardPaste className="h-4 w-4" />
                  {t('maintenance.hours.pasteFromSheet')}
                </Button>
              )}
            </div>
            <ReadingTimeline readings={data.readings} today={data.today} due={data.due_machine_ids.length > 0} onPick={setFormDate} />
            <ReadingLog
              limit={2}
              readings={data.readings}
              today={data.today}
              canEdit={canEdit}
              canDelete={canDelete}
              onEdit={setFormDate}
              onDelete={setConfirmDate}
            />
          </CardContent>
        </Card>
      </div>

      {panelMachine && (
        <MachinePanel
          machine={panelMachine}
          series={series.get(panelMachine.id)!}
          readings={data.readings}
          events={data.events.filter((ev) => ev.machine_id === panelMachine.id)}
          today={data.today}
          color={colors.get(panelMachine.id) ?? ''}
          currency={currency}
          canEdit={canEdit}
          onEditDate={setFormDate}
          onAddEvent={(machineId, body) => addEvent.mutate({ machineId, body })}
          onDeleteEvent={(id) => deleteEvent.mutate(id)}
          onSavePurchase={(machineId, body) => savePurchase.mutate({ machineId, body })}
          onClose={() => setPanelId(null)}
        />
      )}
      {formDate !== null && (
        <ReadingFormModal
          initialDate={formDate}
          today={data.today}
          machines={machines}
          readings={data.readings}
          colors={colors}
          isSaving={saveReadings.isPending}
          onSave={(date, entries) => saveReadings.mutate({ date, entries })}
          onClose={() => setFormDate(null)}
        />
      )}
      {passOpen && (
        <ReadingPass
          machines={passMachines}
          readings={data.readings}
          today={data.today}
          colors={colors}
          isSaving={saveReadings.isPending}
          onSave={async (entries) => {
            // The pass may have crossed midnight: save under the server's current date.
            try {
              const fresh = await queryClient.fetchQuery({ queryKey: ['maintenanceHours'], queryFn: api.getPrinterHours, staleTime: 0 });
              saveReadings.mutate({ date: fresh.today, entries });
            } catch (e) {
              showToast((e as Error).message, 'error');
            }
          }}
          onClose={closePass}
        />
      )}
      {pasteOpen && (
        <PasteImportModal
          machines={machines}
          today={data.today}
          isImporting={importReadings.isPending}
          onImport={(body) => importReadings.mutate(body)}
          onClose={() => setPasteOpen(false)}
        />
      )}

      {confirmDate && (
        <ConfirmModal
          title={t('maintenance.hours.deleteTitle')}
          message={t('maintenance.hours.deleteMessage', {
            date: new Intl.DateTimeFormat(i18n.language, { timeZone: 'UTC' }).format(new Date(`${confirmDate}T00:00:00Z`)),
          })}
          confirmText={t('common.delete')}
          variant="danger"
          isLoading={deleteDate.isPending}
          onConfirm={() => deleteDate.mutate(confirmDate)}
          onCancel={() => setConfirmDate(null)}
        />
      )}
      {confirmMachine && (
        <ConfirmModal
          title={t('maintenance.hours.deleteMachineTitle')}
          message={t('maintenance.hours.deleteMachineMessage', { name: confirmMachine.name })}
          confirmText={t('common.delete')}
          variant="danger"
          isLoading={deleteMachine.isPending}
          onConfirm={() => deleteMachine.mutate(confirmMachine.id)}
          onCancel={() => setConfirmMachine(null)}
        />
      )}
    </div>
  );
}
