import { useTranslation } from 'react-i18next';
import type { PrinterUtilization } from './printerUtilization';

export function PrinterUtilizationWidget({ rows }: { rows: PrinterUtilization[] }) {
  const { t } = useTranslation();

  if (rows.length === 0) {
    return <p className="text-bambu-gray text-center py-4">{t('stats.utilizationNoData')}</p>;
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.printerId}>
          <div className="flex items-baseline justify-between text-sm mb-1">
            <span className="text-white truncate max-w-[60%]">{row.name}</span>
            <span className="text-bambu-gray">
              <span className="text-white font-medium">{row.pct.toFixed(row.pct < 10 ? 1 : 0)}%</span>
              {' · '}
              {t('stats.utilizationBusy', { hours: (row.busySeconds / 3600).toFixed(1) })}
            </span>
          </div>
          <div className="h-2 rounded-full bg-bambu-dark overflow-hidden">
            <div
              className="h-full rounded-full bg-bambu-green"
              style={{ width: `${Math.min(100, row.pct)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
