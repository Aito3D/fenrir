import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../api/client';
import { computeSkuForecasts, groupSpoolsBySku } from '../../utils/filamentForecast';
import { formatWeight } from '../../utils/weight';

/** Compact view of the Inventory forecast: the SKUs closest to running out.
 *  Uses the exact same computation as the Inventory page's Forecast tab
 *  (utils/filamentForecast), so both views always agree. */
export function FilamentForecastWidget() {
  const { t } = useTranslation();

  // Same query keys as InventoryPage/ForecastPanel so caches are shared
  const { data: spoolmanSettings } = useQuery({
    queryKey: ['spoolman-settings'],
    queryFn: api.getSpoolmanSettings,
    staleTime: 5 * 60 * 1000,
  });
  const spoolmanMode =
    spoolmanSettings?.spoolman_enabled === 'true' && !!spoolmanSettings?.spoolman_url;

  const { data: spools, isLoading } = useQuery({
    queryKey: spoolmanMode ? ['spoolman-inventory-spools'] : ['inventory-spools'],
    queryFn: () => (spoolmanMode ? api.getSpoolmanInventorySpools(true) : api.getSpools(true)),
    enabled: spoolmanSettings !== undefined,
  });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const { data: skuSettingsList = [] } = useQuery({
    queryKey: ['sku-settings'],
    queryFn: api.getSkuSettings,
    staleTime: 60_000,
  });
  const { data: usageHistory = [] } = useQuery({
    queryKey: ['all-usage-history-forecast'],
    queryFn: () => api.getAllUsageHistory(5000),
    staleTime: 60_000,
  });

  const rows = useMemo(() => {
    if (!spools) return [];
    const groups = groupSpoolsBySku(spools);
    const globalLeadTime = settings?.forecast_global_lead_time_days ?? 0;
    return computeSkuForecasts(groups, skuSettingsList, usageHistory, globalLeadTime)
      .filter((f) => f.totalRemainingG > 0 || f.dailyRateG !== null)
      .sort((a, b) => (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity))
      .slice(0, 5);
  }, [spools, settings, skuSettingsList, usageHistory]);

  if (isLoading) return null;
  if (!spools || spools.filter((s) => !s.archived_at).length === 0) {
    return <p className="text-bambu-gray text-center py-4">{t('stats.forecastNoInventory')}</p>;
  }

  const daysColor = (days: number | null, alert: boolean) => {
    if (alert) return 'text-status-error';
    if (days === null) return 'text-bambu-gray';
    if (days <= 7) return 'text-status-error';
    if (days <= 21) return 'text-status-warning';
    return 'text-status-ok';
  };

  return (
    <div className="space-y-2">
      {rows.map((f) => {
        const label = [f.group.material, f.group.subtype, f.group.colorName].filter(Boolean).join(' ');
        return (
          <div key={f.group.key} className="flex items-center gap-2 text-sm">
            <div className="flex-1 min-w-0">
              <span className="text-white truncate block">{label}</span>
              <span className="text-xs text-bambu-gray">
                {t('stats.forecastRemaining', { amount: formatWeight(f.totalRemainingG) })}
              </span>
            </div>
            <span className={`font-medium whitespace-nowrap ${daysColor(f.daysRemaining, f.stockBreakAlert || f.reorderAlert)}`}>
              {(f.stockBreakAlert || f.reorderAlert) && (
                <AlertTriangle className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
              )}
              {f.daysRemaining !== null
                ? t('stats.forecastDaysLeft', { days: f.daysRemaining })
                : t('stats.forecastNoUsage')}
            </span>
          </div>
        );
      })}
      <p className="text-xs text-bambu-gray pt-2 border-t border-bambu-dark-tertiary">
        {t('stats.forecastBasis')}
      </p>
    </div>
  );
}
