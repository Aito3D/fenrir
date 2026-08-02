import { useState, useEffect } from 'react';
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

export function AiSettings() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useTranslation();
  const { authEnabled, hasPermission } = useAuth();
  const canUpdate = !authEnabled || hasPermission('settings:update');

  // Model — prefilled from settings.
  const [model, setModel] = useState('');

  // Write-only secret field — always starts empty (server returns "").
  const [apiKey, setApiKey] = useState('');

  const { data: settings, isLoading: settingsLoading } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  useEffect(() => {
    if (settings) {
      setModel(settings.openrouter_model ?? '');
      // The API key is never returned by the API — always leave blank.
      setApiKey('');
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (data: AppSettingsUpdate) => api.updateSettings(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      showToast(t('settings.toast.settingsSaved'), 'success');
      setApiKey('');
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  const handleSave = () => {
    saveMutation.mutate({
      openrouter_model: model.trim() || DEFAULT_MODEL,
      // Omit an untouched key so saving never wipes the stored secret.
      ...(apiKey.trim() ? { openrouter_api_key: apiKey.trim() } : {}),
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
