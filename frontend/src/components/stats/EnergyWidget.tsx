import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { api } from '../../api/client';
import { parseLocalDateKey } from '../../utils/date';
import { CHART_TOOLTIP_STYLE } from './chartTheme';

/** Energy consumption over the selected timeframe, from the hourly
 *  smart-plug snapshot history (kWh/day area chart + headline stats). */
export function EnergyWidget({
  dateFrom,
  dateTo,
  currency,
  totalPrints,
}: {
  dateFrom?: string;
  dateTo?: string;
  currency: string;
  totalPrints: number;
}) {
  const { t } = useTranslation();

  const { data, isLoading } = useQuery({
    queryKey: ['energyHistory', dateFrom, dateTo],
    queryFn: () => api.getEnergyHistory({ dateFrom, dateTo, bucket: 'day' }),
  });

  const chartData = useMemo(
    () =>
      (data?.buckets ?? []).map((b) => ({
        label: parseLocalDateKey(b.period).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        kwh: b.kwh,
      })),
    [data],
  );

  if (isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="w-6 h-6 text-bambu-green animate-spin" />
      </div>
    );
  }

  if (!data || data.plugs.length === 0) {
    return <p className="text-bambu-gray text-center py-4">{t('stats.energyNoPlugs')}</p>;
  }
  if (data.total_kwh <= 0) {
    return <p className="text-bambu-gray text-center py-4">{t('stats.energyNoData')}</p>;
  }

  const daysWithData = data.buckets.filter((b) => b.kwh > 0).length;
  const stats: { label: string; value: string; warning?: boolean }[] = [
    { label: t('stats.energyTotalLabel'), value: `${data.total_kwh.toFixed(2)} kWh`, warning: data.warming_up },
    { label: t('stats.energyCostLabel'), value: `${currency} ${data.total_cost.toFixed(2)}` },
    {
      label: t('stats.energyAvgPerDay'),
      value: daysWithData > 0 ? `${(data.total_kwh / daysWithData).toFixed(2)} kWh` : '—',
    },
    ...(totalPrints > 0
      ? [{ label: t('stats.energyAvgPerPrint'), value: `${(data.total_kwh / totalPrints).toFixed(2)} kWh` }]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        {stats.map((s) => (
          <div key={s.label}>
            <p className="text-xs text-bambu-gray flex items-center gap-1">
              {s.label}
              {s.warning && (
                <AlertTriangle
                  className="w-3 h-3 text-yellow-400"
                  aria-label={t('stats.energyWarmingUpTooltip')}
                />
              )}
            </p>
            <p className="text-lg font-bold text-white">{s.value}</p>
          </div>
        ))}
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id="energyGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#eab308" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#eab308" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#3d3d3d" />
          <XAxis dataKey="label" stroke="#9ca3af" tick={{ fontSize: 11 }} />
          <YAxis stroke="#9ca3af" tick={{ fontSize: 11 }} unit=" kWh" width={70} />
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            labelStyle={{ color: '#fff' }}
            formatter={(v: number | undefined) => [`${Number(v ?? 0).toFixed(3)} kWh`, t('stats.energyUsed')]}
          />
          <Area
            type="monotone"
            dataKey="kwh"
            stroke="#eab308"
            strokeWidth={2}
            fill="url(#energyGradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
