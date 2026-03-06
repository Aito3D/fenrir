import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { History, CheckCircle, XCircle, Loader2, Trash2, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { parseUTCDate, formatTimeOnly, formatDateTime, type TimeFormat } from '../utils/date';
import type { NotificationLogEntry } from '../api/client';
import { Button } from './Button';
import { useToast } from '../contexts/ToastContext';

const getEventLabel = (eventType: string, t: (k: string) => string): string => {
  const labels: Record<string, string> = {
    print_start: t('notificationLog.events.printStart'),
    print_complete: t('notificationLog.events.printComplete'),
    print_failed: t('notificationLog.events.printFailed'),
    print_stopped: t('notificationLog.events.printStopped'),
    print_progress: t('notificationLog.events.progress'),
    printer_offline: t('notificationLog.events.printerOffline'),
    printer_error: t('notificationLog.events.printerError'),
    filament_low: t('notificationLog.events.filamentLow'),
    maintenance_due: t('notificationLog.events.maintenanceDue'),
    test: t('notificationLog.events.test'),
  };
  return labels[eventType] || eventType;
};

const EVENT_COLORS: Record<string, string> = {
  print_start: 'text-blue-400',
  print_complete: 'text-bambu-green',
  print_failed: 'text-red-400',
  print_stopped: 'text-orange-400',
  print_progress: 'text-yellow-400',
  printer_offline: 'text-gray-400',
  printer_error: 'text-rose-400',
  filament_low: 'text-cyan-400',
  maintenance_due: 'text-purple-400',
  test: 'text-bambu-gray',
};

interface NotificationLogViewerProps {
  onClose: () => void;
}

export function NotificationLogViewer({ onClose }: NotificationLogViewerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [days, setDays] = useState(7);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showFailedOnly, setShowFailedOnly] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  const timeFormat: TimeFormat = settings?.time_format || 'system';

  const { data: logs, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['notification-logs', days, showFailedOnly],
    queryFn: () => api.getNotificationLogs({
      days,
      limit: 100,
      success: showFailedOnly ? false : undefined,
    }),
  });

  const { data: stats } = useQuery({
    queryKey: ['notification-log-stats', days],
    queryFn: () => api.getNotificationLogStats(days),
  });

  const clearMutation = useMutation({
    mutationFn: () => api.clearNotificationLogs(30),
    onSuccess: (data) => {
      showToast(data.message, 'success');
      queryClient.invalidateQueries({ queryKey: ['notification-logs'] });
      queryClient.invalidateQueries({ queryKey: ['notification-log-stats'] });
    },
    onError: (error: Error) => {
      showToast(`Failed to clear logs: ${error.message}`, 'error');
    },
  });

  const formatDate = (dateStr: string) => {
    const date = parseUTCDate(dateStr);
    if (!date) return '';
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    if (diff < 60000) return t('notificationLog.time.justNow');
    if (diff < 3600000) return t('notificationLog.time.minutesAgo', { count: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('notificationLog.time.hoursAgo', { count: Math.floor(diff / 3600000) });

    return date.toLocaleDateString() + ' ' + formatTimeOnly(date, timeFormat);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between">
          <div className="flex items-center gap-3">
            <History className="w-5 h-5 text-bambu-green" />
            <h2 className="text-lg font-semibold text-white">{t('notificationLog.title')}</h2>
          </div>
          <button
            onClick={onClose}
            className="text-bambu-gray hover:text-white transition-colors"
          >
            &times;
          </button>
        </div>

        {/* Stats Bar */}
        {stats && (
          <div className="px-4 py-3 border-b border-bambu-dark-tertiary bg-bambu-dark/50">
            <div className="flex items-center gap-6 text-sm">
              <span className="text-bambu-gray">
                {t('notificationLog.stats.lastDays', { days })}: <span className="text-white font-medium">{stats.total}</span> {t('notificationLog.stats.notifications')}
              </span>
              <span className="flex items-center gap-1 text-bambu-green">
                <CheckCircle className="w-4 h-4" />
                {stats.success_count} {t('notificationLog.stats.sent')}
              </span>
              {stats.failure_count > 0 && (
                <span className="flex items-center gap-1 text-red-400">
                  <XCircle className="w-4 h-4" />
                  {stats.failure_count} {t('notificationLog.stats.failed')}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="px-4 py-3 border-b border-bambu-dark-tertiary flex items-center gap-4">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-bambu-green"
          >
            <option value={1}>{t('notificationLog.period.last24h')}</option>
            <option value={7}>{t('notificationLog.period.last7d')}</option>
            <option value={30}>{t('notificationLog.period.last30d')}</option>
            <option value={90}>{t('notificationLog.period.last90d')}</option>
          </select>

          <label className="flex items-center gap-2 text-sm text-bambu-gray cursor-pointer">
            <input
              type="checkbox"
              checked={showFailedOnly}
              onChange={(e) => setShowFailedOnly(e.target.checked)}
              className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
            />
            {t('notificationLog.showFailedOnly')}
          </label>

          <div className="flex-1" />

          <Button
            size="sm"
            variant="secondary"
            onClick={() => refetch()}
            disabled={isRefetching}
          >
            {isRefetching ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            {t('common.refresh')}
          </Button>

          <Button
            size="sm"
            variant="secondary"
            onClick={() => clearMutation.mutate()}
            disabled={clearMutation.isPending}
            className="text-red-400 hover:text-red-300"
          >
            {clearMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
            {t('notificationLog.clearOld')}
          </Button>
        </div>

        {/* Log List */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-6 h-6 text-bambu-green animate-spin" />
            </div>
          ) : logs && logs.length > 0 ? (
            <div className="space-y-2">
              {logs.map((log) => (
                <LogEntry
                  key={log.id}
                  log={log}
                  isExpanded={expandedId === log.id}
                  onToggle={() => setExpandedId(expandedId === log.id ? null : log.id)}
                  formatDate={formatDate}
                  formatFullDate={(dateStr) => formatDateTime(dateStr, timeFormat)}
                  t={t}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-bambu-gray">
              <History className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">
                {showFailedOnly ? t('notificationLog.noFailed') : t('notificationLog.noLogs')}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LogEntry({
  log,
  isExpanded,
  onToggle,
  formatDate,
  formatFullDate,
  t,
}: {
  log: NotificationLogEntry;
  isExpanded: boolean;
  onToggle: () => void;
  formatDate: (date: string) => string;
  formatFullDate: (date: string) => string;
  t: (k: string) => string;
}) {
  return (
    <div
      className={`border rounded-lg overflow-hidden transition-colors ${
        log.success
          ? 'border-bambu-dark-tertiary bg-bambu-dark/30'
          : 'border-red-500/30 bg-red-500/5'
      }`}
    >
      <button
        className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-bambu-dark/50 transition-colors"
        onClick={onToggle}
      >
        {log.success ? (
          <CheckCircle className="w-4 h-4 text-bambu-green shrink-0" />
        ) : (
          <XCircle className="w-4 h-4 text-red-400 shrink-0" />
        )}

        <span className={`text-xs font-medium ${EVENT_COLORS[log.event_type] || 'text-bambu-gray'}`}>
          {getEventLabel(log.event_type, t)}
        </span>

        <span className="text-sm text-white truncate flex-1">
          {log.provider_name || 'Unknown Provider'}
        </span>

        {log.printer_name && (
          <span className="text-xs text-bambu-gray">
            {log.printer_name}
          </span>
        )}

        <span className="text-xs text-bambu-gray shrink-0">
          {formatDate(log.created_at)}
        </span>

        {isExpanded ? (
          <ChevronUp className="w-4 h-4 text-bambu-gray shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-bambu-gray shrink-0" />
        )}
      </button>

      {isExpanded && (
        <div className="px-3 py-2 border-t border-bambu-dark-tertiary bg-bambu-dark/20 space-y-2">
          <div>
            <p className="text-xs text-bambu-gray mb-1">Title</p>
            <p className="text-sm text-white">{log.title}</p>
          </div>
          <div>
            <p className="text-xs text-bambu-gray mb-1">Message</p>
            <p className="text-sm text-white whitespace-pre-wrap">{log.message}</p>
          </div>
          {!log.success && log.error_message && (
            <div>
              <p className="text-xs text-red-400 mb-1">Error</p>
              <p className="text-sm text-red-300">{log.error_message}</p>
            </div>
          )}
          <div className="flex gap-4 text-xs text-bambu-gray pt-1">
            <span>Provider: {log.provider_type}</span>
            <span>Time: {formatFullDate(log.created_at)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
