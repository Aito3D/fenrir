import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Loader2 } from 'lucide-react';
import { api } from '../api/client';
import type { AppSettings, AppSettingsUpdate } from '../api/client';
import { Card, CardContent, CardHeader } from './Card';
import { Button } from './Button';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';

const DEFAULT_MODEL = 'mistralai/mistral-small';

/** A whole number of days in the server's 1..365 range, or the default. */
function clampDays(raw: string, fallback: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 && n <= 365 ? n : fallback;
}

export function AiSettings() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useTranslation();
  const { authEnabled, hasPermission } = useAuth();
  const canUpdate = !authEnabled || hasPermission('settings:update');

  // Model — prefilled from settings.
  const [model, setModel] = useState('');

  // Write-only secret fields — always start empty (server returns "").
  const [apiKey, setApiKey] = useState('');
  // The Pushcut webhook URL embeds its secret token, so it gets the same
  // write-only treatment as the API key beside it.
  const [pushcutUrl, setPushcutUrl] = useState('');

  // Follow-up thresholds — prefilled from settings, kept as strings for the inputs.
  const [quoteDays, setQuoteDays] = useState('5');
  const [pickupDays, setPickupDays] = useState('7');

  const { data: settings, isLoading: settingsLoading } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  // Seed once, the first time settings arrive. A later refetch of the shared
  // ['settings'] query (e.g. saving an unrelated card on the same tab) must
  // not re-run this — it would blank whatever the user is mid-typing here.
  const seededRef = useRef(false);
  useEffect(() => {
    if (settings && !seededRef.current) {
      seededRef.current = true;
      setModel(settings.openrouter_model ?? '');
      // The API key is never returned by the API — always leave blank.
      setApiKey('');
      setQuoteDays(String(settings.aito_followup_quote_days ?? 5));
      setPickupDays(String(settings.aito_followup_pickup_days ?? 7));
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (data: AppSettingsUpdate) => api.updateSettings(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      showToast(t('settings.toast.settingsSaved'), 'success');
      setApiKey('');
      setPushcutUrl('');
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  const handleSave = () => {
    saveMutation.mutate({
      openrouter_model: model.trim() || DEFAULT_MODEL,
      // Omit an untouched secret so saving never wipes the stored one.
      ...(apiKey.trim() ? { openrouter_api_key: apiKey.trim() } : {}),
      ...(pushcutUrl.trim() ? { pushcut_sms_url: pushcutUrl.trim() } : {}),
      aito_followup_quote_days: clampDays(quoteDays, 5),
      aito_followup_pickup_days: clampDays(pickupDays, 7),
    });
  };

  if (settingsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-bambu-green" />
      </div>
    );
  }

  return (
    <Card id="card-openrouter">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-gray-400" />
          <h2 className="text-lg font-semibold text-white">{t('settings.openrouterTitle')}</h2>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-bambu-gray mb-1">{t('settings.openrouterApiKey')}</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t('settings.openrouterApiKeyHint')}
              className="w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-bambu-gray mb-1">{t('settings.openrouterModel')}</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={DEFAULT_MODEL}
              className="w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            />
          </div>
        </div>

        <p className="text-sm text-bambu-gray">{t('settings.openrouterModelHint')}</p>

        <div>
          <label className="block text-sm text-bambu-gray mb-1">{t('settings.pushcutUrl')}</label>
          <input
            type="password"
            value={pushcutUrl}
            onChange={(e) => setPushcutUrl(e.target.value)}
            placeholder={t('settings.pushcutUrlHint')}
            className="w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
          />
          <p className="text-sm text-bambu-gray mt-1">{t('settings.pushcutUrlDescription')}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="aito-followup-quote-days" className="block text-sm text-bambu-gray mb-1">
              {t('settings.aitoFollowupQuoteDays')}
            </label>
            <input
              id="aito-followup-quote-days"
              type="number"
              min={1}
              max={365}
              step={1}
              value={quoteDays}
              onChange={(e) => setQuoteDays(e.target.value)}
              className="w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            />
            <p className="text-sm text-bambu-gray mt-1">{t('settings.aitoFollowupQuoteDaysDescription')}</p>
          </div>
          <div>
            <label htmlFor="aito-followup-pickup-days" className="block text-sm text-bambu-gray mb-1">
              {t('settings.aitoFollowupPickupDays')}
            </label>
            <input
              id="aito-followup-pickup-days"
              type="number"
              min={1}
              max={365}
              step={1}
              value={pickupDays}
              onChange={(e) => setPickupDays(e.target.value)}
              className="w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            />
            <p className="text-sm text-bambu-gray mt-1">{t('settings.aitoFollowupPickupDaysDescription')}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-bambu-dark-tertiary">
          <Button variant="primary" size="sm" onClick={handleSave} disabled={!canUpdate || saveMutation.isPending}>
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {t('common.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
