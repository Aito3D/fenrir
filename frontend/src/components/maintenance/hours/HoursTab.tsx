import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardPaste, Loader2, Plus } from 'lucide-react';
import { api, type HourMachine } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { machineColors, machineSeries, ratePerMonth, seriesPoints } from '../../../utils/hoursSeries';
import { Button } from '../../Button';
import { Card, CardContent } from '../../Card';
import { ConfirmModal } from '../../ConfirmModal';
import { HoursChart, type HoursChartMode } from './HoursChart';
import { MachineList, type MachineStat } from './MachineList';
import { ReadingLog } from './ReadingLog';

const MODES: HoursChartMode[] = ['cumulative', 'monthly', 'total'];
const MODE_KEY: Record<HoursChartMode, string> = {
  cumulative: 'maintenance.hours.modeCumulative',
  monthly: 'maintenance.hours.modeMonthly',
  total: 'maintenance.hours.modeTotal',
};

export function HoursTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('maintenance:update');
  const canDelete = hasPermission('maintenance:delete');

  const { data, isLoading } = useQuery({ queryKey: ['maintenanceHours'], queryFn: api.getPrinterHours });
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<HoursChartMode>('cumulative');
  const [formDate, setFormDate] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [confirmDate, setConfirmDate] = useState<string | null>(null);
  const [confirmMachine, setConfirmMachine] = useState<HourMachine | null>(null);

  const machines = useMemo(() => data?.machines ?? [], [data]);
  const series = useMemo(
    () => new Map(machines.map((m) => [m.id, machineSeries(data?.readings ?? [], m.id)])),
    [machines, data],
  );
  const colors = useMemo(() => machineColors(machines), [machines]);
  const stats = useMemo(() => {
    const out = new Map<number, MachineStat>();
    for (const m of machines) {
      const pts = seriesPoints(series.get(m.id)!);
      out.set(m.id, {
        hours: m.current_hours ?? (pts.length ? pts[pts.length - 1].hours : null),
        rate: data ? ratePerMonth(pts, data.today) : null,
      });
    }
    return out;
  }, [machines, series, data]);

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

  const toggle = (id: number) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="grid gap-4 md:grid-cols-[280px_1fr]">
      <Card className="md:max-h-[640px] md:overflow-auto">
        <CardContent>
          <MachineList
            machines={machines}
            colors={colors}
            hidden={hidden}
            stats={stats}
            canDelete={canDelete}
            onToggle={toggle}
            onShowAll={() => setHidden(new Set())}
            onHideAll={() => setHidden(new Set(machines.map((m) => m.id)))}
            onDeleteRetired={setConfirmMachine}
          />
        </CardContent>
      </Card>
      <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardContent>
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
              {canEdit && (
                <Button className="ml-auto" size="sm" onClick={() => setFormDate(data.today)}>
                  <Plus className="h-4 w-4" />
                  {t('maintenance.hours.newReading')}
                </Button>
              )}
            </div>
            <HoursChart mode={mode} machines={machines} hidden={hidden} series={series} colors={colors} today={data.today} />
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

      {/* Task 8 mounts ReadingFormModal on formDate; Task 9 mounts PasteImportModal on pasteOpen. */}
      {formDate === null && pasteOpen === false ? null : null}

      {confirmDate && (
        <ConfirmModal
          title={t('maintenance.hours.deleteTitle')}
          message={t('maintenance.hours.deleteMessage', { date: confirmDate })}
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
