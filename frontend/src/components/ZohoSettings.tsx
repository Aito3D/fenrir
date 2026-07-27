import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Briefcase, Loader2, CheckCircle, XCircle, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import type { AppSettings, AppSettingsUpdate, ZohoStatus } from '../api/client';
import { Card, CardContent, CardHeader } from './Card';
import { Button } from './Button';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';

export function ZohoSettings() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useTranslation();
  const { authEnabled, hasPermission } = useAuth();
  const canUpdate = !authEnabled || hasPermission('settings:update');

  // Text fields — prefilled from settings
  const [clientId, setClientId] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [accountsUrl, setAccountsUrl] = useState('');
  const [defaultContactId, setDefaultContactId] = useState('');
  const [defaultContactName, setDefaultContactName] = useState('');

  // Write-only secret fields — always start empty
  const [clientSecret, setClientSecret] = useState('');
  const [refreshToken, setRefreshToken] = useState('');

  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<ZohoStatus | null>(null);

  const { data: settings, isLoading: settingsLoading } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  const { data: zohoStatus } = useQuery<ZohoStatus>({
    queryKey: ['zoho-status'],
    queryFn: api.getZohoStatus,
  });

  useEffect(() => {
    if (settings) {
      setClientId(settings.zoho_client_id ?? '');
      setOrganizationId(settings.zoho_organization_id ?? '');
      setBaseUrl(settings.zoho_base_url ?? '');
      setAccountsUrl(settings.zoho_accounts_url ?? '');
      setDefaultContactId(settings.zoho_default_contact_id ?? '');
      setDefaultContactName(settings.zoho_default_contact_name ?? '');
      // Secrets are never returned by the API — always leave blank.
      setClientSecret('');
      setRefreshToken('');
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (data: AppSettingsUpdate) => api.updateSettings(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['zoho-status'] });
      showToast(t('zoho.saved'));
      setClientSecret('');
      setRefreshToken('');
      setTestResult(null);
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  const handleSave = () => {
    // Only send fields that changed / are non-empty — omitting empty secret
    // fields keeps already-saved secrets from being wiped on save.
    const payload: AppSettingsUpdate = {};

    if (clientId !== (settings?.zoho_client_id ?? '')) payload.zoho_client_id = clientId;
    if (organizationId !== (settings?.zoho_organization_id ?? '')) payload.zoho_organization_id = organizationId;
    if (baseUrl !== (settings?.zoho_base_url ?? '')) payload.zoho_base_url = baseUrl;
    if (accountsUrl !== (settings?.zoho_accounts_url ?? '')) payload.zoho_accounts_url = accountsUrl;
    if (defaultContactId !== (settings?.zoho_default_contact_id ?? '')) payload.zoho_default_contact_id = defaultContactId;
    if (defaultContactName !== (settings?.zoho_default_contact_name ?? ''))
      payload.zoho_default_contact_name = defaultContactName;
    if (clientSecret) payload.zoho_client_secret = clientSecret;
    if (refreshToken) payload.zoho_refresh_token = refreshToken;

    if (Object.keys(payload).length === 0) {
      showToast(t('zoho.saved'));
      return;
    }

    saveMutation.mutate(payload);
  };

  const handleTestConnection = async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await queryClient.fetchQuery({
        queryKey: ['zoho-status'],
        queryFn: api.getZohoStatus,
        staleTime: 0,
      });
      setTestResult(result);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Unknown error', 'error');
    } finally {
      setTestLoading(false);
    }
  };

  if (settingsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-bambu-green" />
      </div>
    );
  }

  return (
    <Card id="card-zoho">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Briefcase className="w-5 h-5 text-gray-400" />
          <h2 className="text-lg font-semibold text-white">{t('zoho.title')}</h2>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-bambu-gray">{t('zoho.subtitle')}</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-bambu-gray mb-1">{t('zoho.clientId')}</label>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-bambu-gray mb-1">
              {t('zoho.clientSecret')}
              {zohoStatus?.configured && (
                <span className="ml-2 text-xs text-green-700 dark:text-green-400">{t('zoho.secretSaved')}</span>
              )}
            </label>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={zohoStatus?.configured ? '••••••••' : ''}
              className="w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-bambu-gray mb-1">
              {t('zoho.refreshToken')}
              {zohoStatus?.configured && (
                <span className="ml-2 text-xs text-green-700 dark:text-green-400">{t('zoho.secretSaved')}</span>
              )}
            </label>
            <input
              type="password"
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              placeholder={zohoStatus?.configured ? '••••••••' : ''}
              className="w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-bambu-gray mb-1">{t('zoho.organizationId')}</label>
            <input
              type="text"
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
              className="w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-bambu-gray mb-1">{t('zoho.defaultContactId')}</label>
            <input
              type="text"
              value={defaultContactId}
              onChange={(e) => setDefaultContactId(e.target.value)}
              className="w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-bambu-gray mb-1">{t('zoho.defaultContactName')}</label>
            <input
              type="text"
              value={defaultContactName}
              onChange={(e) => setDefaultContactName(e.target.value)}
              className="w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-bambu-gray mb-1">{t('zoho.baseUrl')}</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://www.zohoapis.eu"
              className="w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-bambu-gray mb-1">{t('zoho.accountsUrl')}</label>
            <input
              type="text"
              value={accountsUrl}
              onChange={(e) => setAccountsUrl(e.target.value)}
              placeholder="https://accounts.zoho.eu"
              className="w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            />
          </div>
        </div>

        <p className="text-sm text-bambu-gray">{t('zoho.defaultContactHint')}</p>

        {testResult && (
          <div
            className={`text-sm flex items-center gap-1 ${
              testResult.configured && testResult.reachable
                ? 'text-green-700 dark:text-green-400'
                : testResult.configured
                ? 'text-status-error'
                : 'text-bambu-gray'
            }`}
          >
            {testResult.configured && testResult.reachable ? (
              <CheckCircle className="w-4 h-4" />
            ) : (
              <XCircle className="w-4 h-4" />
            )}
            {testResult.configured && testResult.reachable
              ? t('zoho.testOk')
              : testResult.configured
              ? t('zoho.testUnreachable')
              : t('zoho.testNotConfigured')}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-bambu-dark-tertiary">
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!canUpdate || saveMutation.isPending}
          >
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {t('zoho.save')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleTestConnection}
            disabled={testLoading}
          >
            {testLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {t('zoho.test')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
