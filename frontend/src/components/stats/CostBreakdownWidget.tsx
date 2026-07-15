import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { api, type ArchiveSlim } from '../../api/client';
import { estimateArchiveSalePrice } from '../../utils/archivePricing';
import { CHART_TOOLTIP_STYLE } from './chartTheme';

const SEGMENT_COLORS = {
  filament: '#00ae42',
  energy: '#eab308',
  machine: '#60a5fa',
} as const;

/** Production-cost breakdown over the timeframe, priced by the calculator:
 *  filament line, energy line, and the rest of the machine cost
 *  (depreciation + repairs). No markups/labor — this is cost, not price. */
export function CostBreakdownWidget({
  archives,
  printerMap,
  currency,
}: {
  archives: ArchiveSlim[];
  printerMap: Map<string, string>;
  currency: string;
}) {
  const { t } = useTranslation();

  // Shares cache keys with CalculatorPage/ArchivesPage
  const { data: filaments } = useQuery({
    queryKey: ['calculatorFilaments'],
    queryFn: api.getCalculatorFilaments,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const { data: printers } = useQuery({
    queryKey: ['calculatorPrinters'],
    queryFn: api.getCalculatorPrinters,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const { data: defaults } = useQuery({
    queryKey: ['calculatorDefaults'],
    queryFn: api.getCalculatorDefaults,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const breakdown = useMemo(() => {
    if (!filaments?.length || !printers?.length || !defaults) return null;
    let filament = 0;
    let energy = 0;
    let machine = 0;
    let hours = 0;
    let grams = 0;
    let priced = 0;
    archives.forEach((a) => {
      const est = estimateArchiveSalePrice(a, filaments, printers, defaults, [
        a.printer_id ? printerMap.get(String(a.printer_id)) : undefined,
      ]);
      if (!est) return;
      filament += est.filamentCost;
      energy += est.energyCost;
      machine += Math.max(0, est.machineCost - est.filamentCost - est.energyCost);
      hours += est.timeH;
      grams += est.weightG;
      priced++;
    });
    return { filament, energy, machine, hours, grams, priced, total: filament + energy + machine };
  }, [archives, filaments, printers, defaults, printerMap]);

  if (!breakdown) {
    return <p className="text-bambu-gray text-center py-4">{t('stats.costNoData')}</p>;
  }
  if (breakdown.priced === 0 || breakdown.total <= 0) {
    return <p className="text-bambu-gray text-center py-4">{t('stats.costNoData')}</p>;
  }

  const allSegments: { key: keyof typeof SEGMENT_COLORS; name: string; value: number }[] = [
    { key: 'filament', name: t('stats.costFilament'), value: breakdown.filament },
    { key: 'energy', name: t('stats.costEnergy'), value: breakdown.energy },
    { key: 'machine', name: t('stats.costMachine'), value: breakdown.machine },
  ];
  const segments = allSegments.filter((s) => s.value > 0);

  const fmt = (v: number) => `${currency} ${v.toFixed(2)}`;

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative flex-shrink-0" style={{ width: 160, height: 160 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={segments}
              dataKey="value"
              nameKey="name"
              innerRadius={52}
              outerRadius={72}
              paddingAngle={2}
              strokeWidth={0}
            >
              {segments.map((s) => (
                <Cell key={s.key} fill={SEGMENT_COLORS[s.key]} />
              ))}
            </Pie>
            <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v: number | undefined) => fmt(Number(v ?? 0))} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-lg font-bold text-white">{fmt(breakdown.total)}</span>
        </div>
      </div>

      <div className="flex-1 min-w-[180px] space-y-2">
        {segments.map((s) => (
          <div key={s.key} className="flex items-center gap-2 text-sm">
            <span
              className="w-3 h-3 rounded-sm flex-shrink-0"
              style={{ backgroundColor: SEGMENT_COLORS[s.key] }}
            />
            <span className="text-bambu-gray flex-1">{s.name}</span>
            <span className="text-white font-medium">{fmt(s.value)}</span>
            <span className="text-bambu-gray text-xs w-10 text-right">
              {((s.value / breakdown.total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
        <div className="pt-2 border-t border-bambu-dark-tertiary space-y-1 text-sm">
          {breakdown.hours > 0 && (
            <div className="flex justify-between">
              <span className="text-bambu-gray">{t('stats.costPerPrintHour')}</span>
              <span className="text-white font-medium">{fmt(breakdown.total / breakdown.hours)}</span>
            </div>
          )}
          {breakdown.grams > 0 && (
            <div className="flex justify-between">
              <span className="text-bambu-gray">{t('stats.costPerKg')}</span>
              <span className="text-white font-medium">{fmt((breakdown.total / breakdown.grams) * 1000)}</span>
            </div>
          )}
          <p className="text-xs text-bambu-gray pt-1">
            {t('stats.costCoverage', { priced: breakdown.priced, total: archives.length })}
          </p>
        </div>
      </div>
    </div>
  );
}
