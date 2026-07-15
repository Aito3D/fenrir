import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Wrench } from 'lucide-react';
import { api, type ArchiveSlim } from '../../api/client';
import { parseUTCDate } from '../../utils/date';

/** Per-printer maintenance state crossed with recent reliability: due/soon
 *  badges from the maintenance overview, plus prints and failures since the
 *  last recorded maintenance (within the page's selected timeframe). */
export function MaintenanceReliabilityWidget({ archives }: { archives: ArchiveSlim[] }) {
  const { t } = useTranslation();
  const { data: overview, isLoading } = useQuery({
    queryKey: ['maintenanceOverview'],
    queryFn: api.getMaintenanceOverview,
  });

  const rows = useMemo(() => {
    if (!overview) return [];
    return overview.map((printer) => {
      const lastPerformed = printer.maintenance_items.reduce<number | null>((latest, item) => {
        if (!item.last_performed_at) return latest;
        const ts = parseUTCDate(item.last_performed_at)?.getTime();
        if (!ts) return latest;
        return latest === null || ts > latest ? ts : latest;
      }, null);

      let prints = 0;
      let failures = 0;
      archives.forEach((a) => {
        if (String(a.printer_id) !== String(printer.printer_id)) return;
        const ts = parseUTCDate(a.started_at || a.created_at)?.getTime();
        if (!ts || (lastPerformed !== null && ts < lastPerformed)) return;
        prints++;
        if (a.status === 'failed') failures++;
      });

      return {
        printerId: printer.printer_id,
        name: printer.printer_name,
        dueCount: printer.due_count,
        warningCount: printer.warning_count,
        lastPerformed,
        prints,
        failures,
      };
    });
  }, [overview, archives]);

  if (isLoading) return null;
  if (rows.length === 0) {
    return <p className="text-bambu-gray text-center py-4">{t('stats.maintenanceNoData')}</p>;
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.printerId} className="flex items-center gap-3">
          <div className={`p-1.5 rounded-lg bg-bambu-dark ${
            row.dueCount > 0 ? 'text-status-error' : row.warningCount > 0 ? 'text-status-warning' : 'text-status-ok'
          }`}>
            <Wrench className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm text-white truncate">{row.name}</span>
              {row.dueCount > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-status-error/20 text-status-error whitespace-nowrap">
                  {t('stats.maintenanceDueBadge', { n: row.dueCount })}
                </span>
              )}
              {row.warningCount > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-status-warning/20 text-status-warning whitespace-nowrap">
                  {t('stats.maintenanceWarningBadge', { n: row.warningCount })}
                </span>
              )}
            </div>
            <p className="text-xs text-bambu-gray truncate">
              {row.lastPerformed !== null
                ? t('stats.printsSinceMaintenance', {
                    prints: row.prints,
                    failures: row.failures,
                    date: new Date(row.lastPerformed).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    }),
                  })
                : t('stats.neverMaintained')}
            </p>
          </div>
        </div>
      ))}
      <p className="text-xs text-bambu-gray pt-2 border-t border-bambu-dark-tertiary">
        {t('stats.maintenanceSinceCaption')}
      </p>
    </div>
  );
}
