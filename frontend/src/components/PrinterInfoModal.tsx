import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Signal, Cable } from 'lucide-react';
import { Card, CardContent } from './Card';
import { CopyButton } from './CopyButton';
import { formatDateOnly, formatRelativeTime } from '../utils/date';
import { getPrinterImage, getWifiStrength } from '../utils/printer';
import { api } from '../api/client';
import type { Printer, PrinterStatus } from '../api/client';

interface PrinterInfoModalProps {
  printer: Printer;
  status?: PrinterStatus;
  totalPrintHours?: number;
  onClose: () => void;
}

export function PrinterInfoModal({ printer, status, totalPrintHours, onClose }: PrinterInfoModalProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const rows: { label: string; value: React.ReactNode }[] = [];

  // Model
  rows.push({
    label: t('printers.model'),
    value: printer.model ?? '—',
  });

  // Connection Status
  rows.push({
    label: t('common.status'),
    value: (
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
        status?.connected
          ? 'bg-bambu-green/20 text-bambu-green'
          : 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400'
      }`}>
        <span className={`w-1.5 h-1.5 rounded-full ${status?.connected ? 'bg-bambu-green' : 'bg-red-400'}`} />
        {status?.connected ? t('printers.status.available') : t('printers.status.offline')}
      </span>
    ),
  });

  // State
  if (status?.state) {
    const stateMap: Record<string, string> = {
      IDLE: 'printers.status.idle',
      RUNNING: 'printers.status.printing',
      PAUSE: 'printers.status.paused',
      FINISH: 'printers.status.finished',
      FAILED: 'printers.status.error',
    };
    rows.push({
      label: t('printers.state'),
      value: t(stateMap[status.state] ?? 'printers.status.unknown'),
    });
  }

  // IP Address
  rows.push({
    label: t('printers.ipAddress'),
    value: (
      <span className="flex items-center">
        <span className="font-mono">{printer.ip_address}</span>
        <CopyButton value={printer.ip_address} />
      </span>
    ),
  });

  // Serial Number
  rows.push({
    label: t('printers.serialNumber'),
    value: (
      <span className="flex items-center">
        <span className="font-mono truncate">{printer.serial_number}</span>
        <CopyButton value={printer.serial_number} />
      </span>
    ),
  });

  // Network connection
  if (status?.wired_network) {
    rows.push({
      label: t('printers.networkLabel', 'Network'),
      value: (
        <span className="flex items-center gap-2">
          <Cable className="w-4 h-4 text-bambu-green" />
          <span className="text-bambu-green">{t('printers.connection.ethernet', 'Ethernet')}</span>
        </span>
      ),
    });
  } else if (status?.wifi_signal != null) {
    const wifi = getWifiStrength(status.wifi_signal);
    rows.push({
      label: t('printers.wifiSignalLabel'),
      value: (
        <span className="flex items-center gap-2">
          <Signal className={`w-4 h-4 ${wifi.color}`} />
          <span className={wifi.color}>{t(wifi.labelKey)}</span>
          <span className="text-bambu-gray text-xs">({status.wifi_signal} dBm)</span>
        </span>
      ),
    });
  }

  // Firmware
  rows.push({
    label: t('printers.firmware'),
    value: status?.firmware_version ?? '—',
  });

  // Developer Mode
  if (status?.developer_mode != null) {
    rows.push({
      label: t('printers.developerMode'),
      value: (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          status.developer_mode
            ? 'bg-bambu-green/20 text-bambu-green'
            : 'bg-bambu-dark-tertiary text-bambu-gray'
        }`}>
          {status.developer_mode ? t('printers.enabled') : t('printers.disabled')}
        </span>
      ),
    });
  }

  // Nozzle Count
  rows.push({
    label: t('printers.nozzleCount'),
    value: printer.nozzle_count,
  });

  // Auto-Archive
  rows.push({
    label: t('printers.autoArchive'),
    value: (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
        printer.auto_archive
          ? 'bg-bambu-green/20 text-bambu-green'
          : 'bg-bambu-dark-tertiary text-bambu-gray'
      }`}>
        {printer.auto_archive ? t('printers.enabled') : t('printers.disabled')}
      </span>
    ),
  });

  // Total Print Hours
  if (totalPrintHours != null && totalPrintHours > 0) {
    rows.push({
      label: t('printers.totalPrintHours'),
      value: `${Math.round(totalPrintHours)}h`,
    });
  }

  // Location
  if (printer.location) {
    rows.push({
      label: t('printers.sort.location'),
      value: printer.location,
    });
  }

  // Added date
  rows.push({
    label: t('printers.addedOn'),
    value: formatDateOnly(printer.created_at),
  });

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-overlay-in"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <Card className="w-full max-w-md max-h-[90vh] overflow-y-auto animate-modal-in" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        <CardContent>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">
              {printer.name}
            </h2>
            <button onClick={onClose} className="p-1 hover:bg-bambu-dark rounded flex-shrink-0">
              <X className="w-5 h-5 text-bambu-gray" />
            </button>
          </div>

          {/* Printer Image */}
          <div className="flex justify-center mb-4">
            <img
              src={getPrinterImage(printer.model)}
              alt={printer.model ?? printer.name}
              className="h-24 object-contain"
            />
          </div>

          <div className="space-y-0">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center justify-between gap-4 py-2.5 border-b border-bambu-dark-tertiary last:border-0">
                <span className="text-sm text-bambu-gray whitespace-nowrap">{row.label}</span>
                <span className="text-sm text-white text-right">{row.value}</span>
              </div>
            ))}
          </div>

          <HmsHistorySection printerId={printer.id} />
        </CardContent>
      </Card>
    </div>
  );
}

// Bambu's alert level: 1 error, 2 warning, else notification.
const SEVERITY_DOT: Record<number, string> = { 1: 'bg-red-400', 2: 'bg-amber-400' };

function HmsHistorySection({ printerId }: { printerId: number }) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['hmsHistory', printerId],
    queryFn: () => api.getHMSHistory(printerId),
  });
  if (!data) return null;

  const dot = (severity: number) => (
    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${SEVERITY_DOT[severity] ?? 'bg-bambu-gray'}`} />
  );
  const label = (code: string, description: string | null) => description ?? <span className="font-mono">{code}</span>;

  return (
    <div className="mt-4 pt-4 border-t border-bambu-dark-tertiary">
      <h3 className="text-sm font-semibold text-white mb-2">{t('printers.errorHistory')}</h3>
      {data.recent.length === 0 ? (
        <p className="text-sm text-bambu-gray">{t('printers.errorHistoryEmpty')}</p>
      ) : (
        <>
          {data.top_codes.length > 0 && (
            <>
              <p className="text-xs text-bambu-gray mb-1">{t('printers.errorHistoryTop')}</p>
              <ul className="mb-3">
                {data.top_codes.map((c) => (
                  <li key={c.code} className="flex items-center gap-2 py-1 text-sm" title={c.code}>
                    {dot(c.severity)}
                    <span className="text-white flex-1 min-w-0 truncate">{label(c.code, c.description)}</span>
                    <span className="text-bambu-gray tabular-nums">×{c.count}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="text-xs text-bambu-gray mb-1">{t('printers.errorHistoryRecent')}</p>
          <ul>
            {data.recent.map((o, i) => (
              <li key={i} className="flex items-center gap-2 py-1 text-sm" title={o.code}>
                {dot(o.severity)}
                <span className="text-white flex-1 min-w-0 truncate">{label(o.code, o.description)}</span>
                <span className="text-bambu-gray text-xs whitespace-nowrap">{formatRelativeTime(o.first_seen, 'system', t)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
