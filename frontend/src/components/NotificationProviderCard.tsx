import { useState } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bell, Trash2, Settings2, Edit2, Send, Loader2, CheckCircle, XCircle, Moon, Clock, ChevronDown, ChevronUp, Calendar, Camera, CameraOff } from 'lucide-react';
import { api } from '../api/client';
import { formatDateOnly, parseUTCDate } from '../utils/date';
import type { NotificationProvider, NotificationProviderUpdate } from '../api/client';
import { Card, CardContent } from './Card';
import { Button } from './Button';
import { ConfirmModal } from './ConfirmModal';
import { Toggle } from './Toggle';
import { useToast } from '../contexts/ToastContext';
import { EVENT_FLAGS, CARD_BADGES_BEFORE_VERDICT, CARD_BADGES_AFTER_VERDICT, CARD_SECTIONS, type CardFlag } from './notificationEventFlags';
import { isNotifyPushOnlyTarget, isNotifyPhotoUnsupported } from '../utils/notify';

interface NotificationProviderCardProps {
  provider: NotificationProvider;
  onEdit: (provider: NotificationProvider) => void;
}

export function NotificationProviderCard({ provider, onEdit }: NotificationProviderCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Fetch printers for linking
  const { data: printers } = useQuery({
    queryKey: ['printers'],
    queryFn: api.getPrinters,
  });

  const notifyPhotosUnsupported = provider.provider_type === 'notify' && isNotifyPhotoUnsupported(String(provider.config.device_id || ''));

  const linkedPrinter = printers?.find(p => p.id === provider.printer_id);

  const { showToast } = useToast();

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: (data: NotificationProviderUpdate) => api.updateNotificationProvider(provider.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-providers'] });
    },
    onError: (err: Error) => {
      showToast(err.message, 'error');
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: () => api.deleteNotificationProvider(provider.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-providers'] });
    },
    onError: (err: Error) => {
      showToast(err.message, 'error');
    },
  });

  // Test mutation
  const testMutation = useMutation({
    mutationFn: () => api.testNotificationProvider(provider.id),
    onSuccess: (result) => {
      setTestResult(result);
      queryClient.invalidateQueries({ queryKey: ['notification-providers'] });
    },
    onError: (err: Error) => {
      setTestResult({ success: false, message: err.message });
    },
  });

  // Format time for display
  const formatTime = (time: string | null) => {
    if (!time) return '';
    return time;
  };

  return (
    <>
      <Card className="relative">
        <CardContent className="p-3">
          {/* Header Row */}
          <div className={`flex items-start justify-between ${provider.enabled ? 'mb-3' : 'mb-0'}`}>
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${provider.enabled ? 'bg-bambu-green/20' : 'bg-bambu-dark'}`}>
                <Bell className={`w-5 h-5 ${provider.enabled ? 'text-bambu-green' : 'text-bambu-gray'}`} />
              </div>
              <div>
                <h3 className="font-medium text-white">{provider.name}</h3>
                <p className="text-sm text-bambu-gray">{t(`notifications.providerTypes.${provider.provider_type}`, provider.provider_type)}</p>
              </div>
            </div>

            {/* Quick enable/disable toggle + Status indicator */}
            <div className="flex items-center gap-3">
              {provider.last_success && (
                <span className="text-xs text-status-ok hidden sm:inline">{t('notifications.lastSuccess', { date: formatDateOnly(provider.last_success) })}</span>
              )}
              {/* Only show error if it's more recent than last success */}
              {provider.last_error && provider.last_error_at && (
                !provider.last_success || (parseUTCDate(provider.last_error_at)?.getTime() || 0) > (parseUTCDate(provider.last_success)?.getTime() || 0)
              ) && (
                <span className="text-xs text-status-error" title={provider.last_error}>{t('notifications.error')}</span>
              )}
              <Toggle
                checked={provider.enabled}
                onChange={(checked) => updateMutation.mutate({ enabled: checked })}
              />
            </div>
          </div>

          {provider.enabled && (<>
          {/* Linked Printer */}
          {linkedPrinter && (
            <div className="mb-3 px-2 py-1.5 bg-bambu-dark rounded-lg">
              <span className="text-xs text-bambu-gray">{t('notifications.printer')} </span>
              <span className="text-sm text-white">{linkedPrinter.name}</span>
            </div>
          )}
          {!linkedPrinter && !provider.printer_id && (
            <div className="mb-3 px-2 py-1.5 bg-bambu-dark rounded-lg">
              <span className="text-xs text-bambu-gray">{t('notifications.allPrinters')}</span>
            </div>
          )}

          {/* Event summary - show all event tags */}
          <div className="mb-3 flex flex-wrap gap-1">
            {provider.provider_type === 'notify' && provider.config.live_activities === true && !isNotifyPushOnlyTarget(String(provider.config.device_id || '')) && (
              <span className="px-2 py-0.5 bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-400 text-xs rounded">{t('notifications.notifyLiveActivities')}</span>
            )}
            {provider.provider_type === 'notify' && provider.config.lock_screen_widgets === true && !isNotifyPushOnlyTarget(String(provider.config.device_id || '')) && (
              <span className="px-2 py-0.5 bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-400 text-xs rounded">{t('notifications.notifyLockScreenWidgets')}</span>
            )}
            {CARD_BADGES_BEFORE_VERDICT.map((key) => provider[key] && (
              <span key={key} className={`px-2 py-0.5 ${EVENT_FLAGS[key].badge.cls} text-xs rounded`}>{t(EVENT_FLAGS[key].badge.label)}</span>
            ))}
            {provider.provider_type === 'telegram' && provider.on_print_confirm_request && provider.telegram_verdict_mode === 'reactions' && (
              <span className="px-2 py-0.5 bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-400 text-xs rounded">{t('notifications.telegramVerdictBadgeReactions')}</span>
            )}
            {provider.provider_type === 'telegram' && provider.on_print_confirm_request && provider.telegram_verdict_mode === 'both' && (
              <span className="px-2 py-0.5 bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-400 text-xs rounded">{t('notifications.telegramVerdictBadgeBoth')}</span>
            )}
            {CARD_BADGES_AFTER_VERDICT.map((key) => provider[key] && (
              <span key={key} className={`px-2 py-0.5 ${EVENT_FLAGS[key].badge.cls} text-xs rounded`}>{t(EVENT_FLAGS[key].badge.label)}</span>
            ))}
            {provider.quiet_hours_enabled && (
              <span className="px-2 py-0.5 bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-400 text-xs rounded flex items-center gap-1">
                <Moon className="w-3 h-3" />
                {t('notifications.quiet')}
              </span>
            )}
            {provider.daily_digest_enabled && (
              <span className="px-2 py-0.5 bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 text-xs rounded flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                {t('notifications.digest', { time: provider.daily_digest_time })}
              </span>
            )}
            {(provider.attach_photo === false || notifyPhotosUnsupported) && (
              <span className="px-2 py-0.5 bg-bambu-dark-tertiary text-bambu-gray text-xs rounded flex items-center gap-1">
                <CameraOff className="w-3 h-3" />
                {t('notifications.noPhoto')}
              </span>
            )}
          </div>

          {/* Test Button */}
          <div className="mb-3">
            <Button
              size="sm"
              variant="secondary"
              disabled={testMutation.isPending}
              onClick={() => {
                setTestResult(null);
                testMutation.mutate();
              }}
              className="w-full"
            >
              {testMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              {t('notifications.sendTestNotification')}
            </Button>
          </div>

          {/* Test Result */}
          {testResult && (
            <div className={`mb-3 p-2 rounded-lg flex items-center gap-2 text-sm ${
              testResult.success
                ? 'bg-bambu-green/20 text-bambu-green'
                : 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400'
            }`}>
              {testResult.success ? (
                <CheckCircle className="w-4 h-4" />
              ) : (
                <XCircle className="w-4 h-4" />
              )}
              <span>{testResult.message}</span>
            </div>
          )}

          </>)}
          {/* Toggle Settings Panel */}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className={`w-full flex items-center justify-between py-2 text-sm text-bambu-gray hover:text-white transition-colors ${provider.enabled ? 'border-t border-bambu-dark-tertiary' : 'mt-2 border-t border-bambu-dark-tertiary'}`}
          >
            <span className="flex items-center gap-2">
              <Settings2 className="w-4 h-4" />
              {t('notifications.eventSettings')}
            </span>
            {isExpanded ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>

          {/* Expanded Settings */}
          {isExpanded && (
            <div className="pt-3 border-t border-bambu-dark-tertiary space-y-4">
              {/* Enabled Toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-white">{t('notifications.enabled')}</p>
                  <p className="text-xs text-bambu-gray">{t('notifications.sendFromProvider')}</p>
                </div>
                <Toggle
                  checked={provider.enabled}
                  onChange={(checked) => updateMutation.mutate({ enabled: checked })}
                />
              </div>

              {/* Quick toggles per event, grouped by section (see notificationEventFlags.ts) */}
              {CARD_SECTIONS.map((section) => (
                <div key={section.title} className="space-y-2">
                  <p className="text-xs text-bambu-gray uppercase tracking-wide">{t(section.title)}</p>

                  {section.keys.map((key) => {
                    const flag: CardFlag = EVENT_FLAGS[key].card;
                    return (
                      <div key={key} className="flex items-center justify-between">
                        {flag.desc ? (
                          <div>
                            <p className="text-sm text-white">{t(flag.label)}</p>
                            <p className="text-xs text-bambu-gray">{t(flag.desc)}</p>
                          </div>
                        ) : (
                          <p className="text-sm text-white">{t(flag.label)}</p>
                        )}
                        <Toggle
                          checked={provider[key] ?? flag.default}
                          onChange={(checked) => updateMutation.mutate({ [key]: checked })}
                        />
                      </div>
                    );
                  })}
                  {section.keys.includes('on_printer_error') && provider.on_printer_error && (
                    <select
                      aria-label={t('notifications.printerError')}
                      value={provider.printer_error_max_level ?? 2}
                      onChange={(e) => updateMutation.mutate({ printer_error_max_level: Number(e.target.value) })}
                      className="w-full px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-sm text-white focus:border-bambu-green focus:outline-none"
                    >
                      <option value={1}>{t('notifications.printerErrorLevel1')}</option>
                      <option value={2}>{t('notifications.printerErrorLevel2')}</option>
                      <option value={3}>{t('notifications.printerErrorLevel3')}</option>
                    </select>
                  )}
                </div>
              ))}

              {/* Quiet Hours */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Moon className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                    <p className="text-sm text-white">{t('notifications.quietHours')}</p>
                  </div>
                  <Toggle
                    checked={provider.quiet_hours_enabled}
                    onChange={(checked) => updateMutation.mutate({ quiet_hours_enabled: checked })}
                  />
                </div>

                {provider.quiet_hours_enabled && (
                  <div className="pl-4 border-l-2 border-bambu-dark-tertiary space-y-2">
                    <p className="text-xs text-bambu-gray">{t('notifications.noNotificationsDuring')}</p>
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-bambu-gray" />
                      <span className="text-sm text-white">
                        {formatTime(provider.quiet_hours_start) || '22:00'} - {formatTime(provider.quiet_hours_end) || '07:00'}
                      </span>
                    </div>
                    <p className="text-xs text-bambu-gray">{t('notifications.editProviderToChangeQuietHours')}</p>
                  </div>
                )}
              </div>

              {/* Daily Digest */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <p className="text-sm text-white">{t('notifications.dailyDigest')}</p>
                  </div>
                  <Toggle
                    checked={provider.daily_digest_enabled}
                    onChange={(checked) => updateMutation.mutate({ daily_digest_enabled: checked })}
                  />
                </div>

                {provider.daily_digest_enabled && (
                  <div className="pl-4 border-l-2 border-bambu-dark-tertiary space-y-2">
                    <p className="text-xs text-bambu-gray">{t('notifications.batchNotifications')}</p>
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-bambu-gray" />
                      <span className="text-sm text-white">
                        {t('notifications.sendAt', { time: formatTime(provider.daily_digest_time) || '08:00' })}
                      </span>
                    </div>
                    <p className="text-xs text-bambu-gray">{t('notifications.editProviderToChangeDigestTime')}</p>
                  </div>
                )}
              </div>

              {/* Attach Photo */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Camera className="w-4 h-4 text-bambu-gray" />
                  <div>
                    <p className="text-sm text-white">{t('notifications.attachPhotoLabel')}</p>
                    <p className="text-xs text-bambu-gray">{t(notifyPhotosUnsupported ? 'notifications.notifyPhotoUnavailable' : 'notifications.attachPhotoDescription')}</p>
                  </div>
                </div>
                <Toggle
                  checked={!notifyPhotosUnsupported && (provider.attach_photo ?? true)}
                  disabled={notifyPhotosUnsupported}
                  onChange={(checked) => updateMutation.mutate({ attach_photo: checked })}
                />
              </div>

              {/* Action Buttons */}
              <div className="flex gap-2 pt-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onEdit(provider)}
                  className="flex-1"
                >
                  <Edit2 className="w-4 h-4" />
                  {t('notifications.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="text-red-700 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation */}
      {showDeleteConfirm && (
        <ConfirmModal
          title={t('notifications.deleteProvider')}
          message={t('notifications.deleteConfirm', { name: provider.name })}
          confirmText={t('notifications.delete')}
          variant="danger"
          onConfirm={() => {
            deleteMutation.mutate();
            setShowDeleteConfirm(false);
          }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </>
  );
}
