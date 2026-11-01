import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardPaste, Loader2, Plus } from 'lucide-react';
import { api, type HourMachine } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { dayNumber, gapInfo, machineColors, machineSeries, seriesPoints } from '../../../utils/hoursSeries';
import { Button } from '../../Button';
import { Card, CardContent } from '../../Card';
import { ConfirmModal } from '../../ConfirmModal';
import { FocusHeader } from './FocusHeader';
import { HoursChart, type HoursChartMode, type HoursChartRange } from './HoursChart';
import { MachineList } from './MachineList';
import { PasteImportModal } from './PasteImportModal';
import { ReadingFormModal } from './ReadingFormModal';
import { ReadingLog } from './ReadingLog';

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
  const [confirmDate, setConfirmDate] = useState<string | null>(null);
  const [confirmMachine, setConfirmMachine] = useState<HourMachine | null>(null);
  const [panelId, setPanelId] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [focusPinned, setFocusPinned] = useState(false);
  const [range, setRange] = useState<HoursChartRange>('all');

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

  const saveReadings = useMutation({
    mutationFn: ({ date, entries }: { date: string; entries: { machine_id: number; hours: number | null }[] }) =>
      api.saveHourReadings(date, entries),
    onSuccess: (overview) => {
      queryClient.setQueryData(['maintenanceHours'], overview);
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
      queryClient.invalidateQueries({ queryKey: ['maintenanceSummary'] });
      setFormDate(null);
      showToast(t('maintenance.hours.saved'));
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

  if (isLoading || !data) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-bambu-green" /></div>;
  }

  const gap = gapInfo(machines, series, data.today);
  const dayFmt = new Intl.DateTimeFormat(i18n.language, { timeZone: 'UTC' });
  const fleetLine = t('maintenance.hours.fleetLine', {
    machines: machines.length,
    date: gap.lastDate ? dayFmt.format(dayNumber(gap.lastDate) * 86_400_000) : '—',
  });
  const focused = machines.find((m) => m.id === focusId) ?? null;

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
                <Button className="ml-auto" size="sm" onClick={() => setFormDate(data.today)}>
                  <Plus className="h-4 w-4" />
                  {t('maintenance.hours.newReading')}
                </Button>
              )}
            </div>
            <FocusHeader
              machine={focused}
              series={focused ? series.get(focused.id) ?? null : null}
              color={focused ? colors.get(focused.id) ?? '' : ''}
              today={data.today}
              fleetLine={fleetLine}
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
              {canEdit && (
                <Button className="ml-auto" variant="secondary" size="sm" onClick={() => setPasteOpen(true)}>
                  <ClipboardPaste className="h-4 w-4" />
                  {t('maintenance.hours.pasteFromSheet')}
                </Button>
              )}
            </div>
            <ReadingLog
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
