import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { X, History, Loader2, Clock, ExternalLink, ChevronRight, FilePlus2 } from 'lucide-react';
import { api, type LibraryFileHistoryEvent } from '../api/client';
import { parseUTCDate } from '../utils/date';

interface FileHistoryModalProps {
  fileId: number;
  filename: string;
  onClose: () => void;
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(isoString: string | null): string {
  if (!isoString) return '—';
  const d = parseUTCDate(isoString);
  return d ? d.toLocaleString() : '—';
}

function eventDotClass(event: LibraryFileHistoryEvent): string {
  if (event.type === 'queued') return 'bg-blue-400/70';
  switch (event.status) {
    case 'completed':
      return 'bg-bambu-green';
    case 'failed':
      return 'bg-red-400';
    case 'stopped':
    case 'cancelled':
      return 'bg-amber-400';
    default:
      return 'bg-bambu-gray';
  }
}

function eventStatusClass(event: LibraryFileHistoryEvent): string {
  if (event.type === 'queued') return 'text-blue-400';
  switch (event.status) {
    case 'completed':
      return 'text-bambu-green';
    case 'failed':
      return 'text-red-400';
    case 'stopped':
    case 'cancelled':
      return 'text-amber-400';
    default:
      return 'text-bambu-gray';
  }
}

export function FileHistoryModal({ fileId, filename, onClose }: FileHistoryModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['library-file-history', fileId],
    queryFn: () => api.getLibraryFileHistory(fileId),
  });

  const statusLabel = (event: LibraryFileHistoryEvent): string => {
    if (event.type === 'queued' && event.status === 'pending') {
      return t('fileManager.fileHistory.statusPending');
    }
    return t(`archives.runLog.status.${event.status}`, { defaultValue: event.status });
  };

  const openArchive = (archiveId: number) => {
    onClose();
    navigate(`/archives?highlight=${archiveId}`);
  };

  const successRate =
    data && data.total_prints > 0 ? Math.round((data.success_count / data.total_prints) * 100) : null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in" onClick={onClose}>
      <div
        className="bg-bambu-dark-secondary rounded-xl border border-bambu-dark-tertiary w-full max-w-2xl max-h-[85vh] flex flex-col animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-bambu-dark-tertiary">
          <div className="flex items-center gap-2 min-w-0">
            <History className="w-5 h-5 text-bambu-green flex-shrink-0" />
            <h2 className="text-lg font-semibold text-white truncate" title={filename}>
              {t('fileManager.fileHistory.title', { name: filename })}
            </h2>
          </div>
          <button onClick={onClose} className="text-bambu-gray hover:text-white transition-colors" title={t('common.close')}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Stat strip — only meaningful once something was printed */}
        {data && data.total_prints > 0 && (
          <div className="px-6 py-3 border-b border-bambu-dark-tertiary flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <span className="text-bambu-gray">
              {t('fileManager.fileHistory.stats.prints')}{' '}
              <span className="text-white font-medium">{data.total_prints}</span>
            </span>
            {successRate !== null && (
              <span className="text-bambu-gray">
                {t('fileManager.fileHistory.stats.success')}{' '}
                <span className={`font-medium ${successRate >= 80 ? 'text-bambu-green' : successRate >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                  {successRate}%
                </span>
              </span>
            )}
            {data.total_filament_grams != null && (
              <span className="text-bambu-gray">
                {t('fileManager.fileHistory.stats.filament')}{' '}
                <span className="text-white font-medium">{data.total_filament_grams.toFixed(1)} g</span>
              </span>
            )}
            {data.last_printed_at && (
              <span className="text-bambu-gray">
                {t('fileManager.fileHistory.stats.lastPrinted')}{' '}
                <span className="text-white font-medium">{formatDate(data.last_printed_at)}</span>
              </span>
            )}
          </div>
        )}

        <div className="p-6 overflow-y-auto flex-1">
          {isLoading && (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 text-bambu-gray animate-spin" />
            </div>
          )}
          {isError && (
            <p className="text-sm text-red-400 py-2">{t('fileManager.fileHistory.loadFailed')}</p>
          )}
          {data && (
            <div className="relative">
              {/* Vertical timeline spine */}
              <div className="absolute left-[5px] top-2 bottom-2 w-px bg-bambu-dark-tertiary" aria-hidden="true" />
              <div className="space-y-1">
                {data.events.length === 0 && data.history_available && (
                  <div className="flex items-center gap-3 py-2 pl-6 relative">
                    <Clock className="w-4 h-4 text-bambu-gray opacity-50 flex-shrink-0" />
                    <span className="text-sm text-bambu-gray italic">
                      {t('fileManager.fileHistory.noPrintsYet')}
                    </span>
                  </div>
                )}
                {!data.history_available && (
                  <div className="flex items-center gap-3 py-2 pl-6 relative">
                    <Clock className="w-4 h-4 text-bambu-gray opacity-50 flex-shrink-0" />
                    <span className="text-sm text-bambu-gray italic">
                      {t('fileManager.fileHistory.externalUnavailable')}
                    </span>
                  </div>
                )}
                {data.events.map((event, idx) => {
                  const clickable = event.archive_id != null;
                  const row = (
                    <>
                      <span
                        className={`absolute left-0 top-2.5 w-[11px] h-[11px] rounded-full border-2 border-bambu-dark-secondary ${eventDotClass(event)} ${event.type === 'queued' && event.status === 'printing' ? 'animate-pulse' : ''}`}
                        aria-hidden="true"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className={`text-sm font-medium ${eventStatusClass(event)}`}>{statusLabel(event)}</span>
                          <span className="text-xs text-bambu-gray-light">{formatDate(event.event_at)}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 text-xs text-bambu-gray">
                          {event.printer_name && <span className="truncate">{event.printer_name}</span>}
                          {event.type === 'print' && event.duration_seconds != null && (
                            <span>{formatDuration(event.duration_seconds)}</span>
                          )}
                          {event.filament_used_grams != null && <span>{event.filament_used_grams.toFixed(1)} g</span>}
                          {event.created_by_username && (
                            <span>{t('fileManager.fileHistory.bySomeone', { name: event.created_by_username })}</span>
                          )}
                        </div>
                        {event.failure_reason && (
                          <div className="text-[10px] text-bambu-gray">
                            {t(`editArchive.failureReasons.${event.failure_reason}`, { defaultValue: event.failure_reason })}
                          </div>
                        )}
                      </div>
                      {clickable && <ChevronRight className="w-4 h-4 text-bambu-gray flex-shrink-0 self-center" />}
                    </>
                  );
                  return clickable ? (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => openArchive(event.archive_id!)}
                      title={t('fileManager.fileHistory.openArchive')}
                      className="w-full text-left relative pl-6 pr-2 py-1.5 rounded-lg flex gap-2 hover:bg-bambu-dark transition-colors"
                    >
                      {row}
                    </button>
                  ) : (
                    <div key={idx} className={`relative pl-6 pr-2 py-1.5 flex gap-2 ${event.type === 'queued' ? 'opacity-80' : ''}`}>
                      {row}
                    </div>
                  );
                })}

                {/* Provenance anchor — always the last line */}
                <div className="relative pl-6 pr-2 py-1.5 flex gap-2">
                  <span className="absolute -left-[1px] top-2 text-bambu-green bg-bambu-dark-secondary" aria-hidden="true">
                    <FilePlus2 className="w-3.5 h-3.5" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium text-white">
                        {t('fileManager.fileHistory.addedToLibrary')}
                      </span>
                      <span className="text-xs text-bambu-gray-light">{formatDate(data.added_at)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-bambu-gray">
                      {data.added_by_username && (
                        <span>{t('fileManager.fileHistory.bySomeone', { name: data.added_by_username })}</span>
                      )}
                      {data.source_url && (
                        <a
                          href={data.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-bambu-green hover:underline"
                        >
                          <ExternalLink className="w-3 h-3" />
                          {t('fileManager.fileHistory.viewSource')}
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
