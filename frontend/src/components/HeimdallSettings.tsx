import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, CreditCard, Loader2, XCircle } from 'lucide-react';
import { api } from '../api/client';
import type { AppSettings, AppSettingsUpdate, HeimdallStatus } from '../api/client';
import { Card, CardContent, CardHeader } from './Card';
import { Button } from './Button';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';

const INPUT =
  'w-full h-10 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none';

function clampInt(raw: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** The Heimdall payment bridge: where Aito mints an OSB payment link per
 *  quote. Same shape as ZohoSettings — prefilled text fields, a write-only
 *  token that always starts blank and is omitted from the save when
 *  untouched, and a Test button. The test sends the URL and token as typed
 *  (not what is saved) so a mistyped key is caught before Save. */
export function HeimdallSettings() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useTranslation();
  const { authEnabled, hasPermission } = useAuth();
  const canUpdate = !authEnabled || hasPermission('settings:update');

  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [depositPct, setDepositPct] = useState('0');
  const [validityDays, setValidityDays] = useState('15');
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<HeimdallStatus | null>(null);

  const { data: settings, isLoading } = useQuery<AppSettings>({ queryKey: ['settings'], queryFn: api.getSettings });

  // Seed once, the first time settings arrive — a later refetch of the
  // shared ['settings'] query must not blank whatever the user is mid-typing.
  const seededRef = useRef(false);
  useEffect(() => {
    if (settings && !seededRef.current) {
      seededRef.current = true;
      setBaseUrl(settings.heimdall_base_url ?? '');
      setToken('');
      setDepositPct(String(settings.aito_deposit_pct ?? 0));
      setValidityDays(String(settings.aito_quote_validity_days ?? 15));
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (data: AppSettingsUpdate) => api.updateSettings(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      showToast(t('heimdall.saved'), 'success');
      setToken('');
      setTestResult(null);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const handleSave = () => {
    saveMutation.mutate({
      heimdall_base_url: baseUrl.trim(),
      // Omit an untouched token so saving never wipes the stored one.
      ...(token.trim() ? { heimdall_api_token: token.trim() } : {}),
      aito_deposit_pct: clampInt(depositPct, settings?.aito_deposit_pct ?? 0, 0, 100),
      aito_quote_validity_days: clampInt(validityDays, settings?.aito_quote_validity_days ?? 15, 1, 365),
    });
  };

  const handleTest = async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const body: { base_url?: string; token?: string } = {};
      if (baseUrl.trim()) body.base_url = baseUrl.trim();
      if (token.trim()) body.token = token.trim();
      setTestResult(await api.testHeimdall(body));
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Unknown error', 'error');
    } finally {
      setTestLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-bambu-green" />
      </div>
    );
  }

  const resultKey = testResult
    ? !testResult.configured
      ? 'heimdall.testNotConfigured'
      : testResult.reachable
        ? 'heimdall.testOk'
        : testResult.error === 'unauthorized'
          ? 'heimdall.testUnauthorized'
          : testResult.error === 'forbidden'
            ? 'heimdall.testForbidden'
            : 'heimdall.testUnreachable'
    : null;

  return (
    <Card id="card-heimdall">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CreditCard className="w-5 h-5 text-gray-400" />
          <h2 className="text-lg font-semibold text-white">{t('heimdall.title')}</h2>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-bambu-gray">{t('heimdall.subtitle')}</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="heimdall-url" className="block text-sm text-bambu-gray mb-1">
              {t('heimdall.baseUrl')}
            </label>
            <input
              id="heimdall-url"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://192.168.1.20:8081"
              className={INPUT}
            />
          </div>
          <div>
            <label htmlFor="heimdall-token" className="block text-sm text-bambu-gray mb-1">
              {t('heimdall.token')}
            </label>
            <input
              id="heimdall-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t('heimdall.tokenHint')}
              autoComplete="off"
              className={INPUT}
            />
          </div>
          <div>
            <label htmlFor="heimdall-deposit" className="block text-sm text-bambu-gray mb-1">
              {t('heimdall.depositPct')}
            </label>
            <input
              id="heimdall-deposit"
              type="number"
              min={0}
              max={100}
              step={1}
              value={depositPct}
              onChange={(e) => setDepositPct(e.target.value)}
              className={INPUT}
            />
            <p className="text-sm text-bambu-gray mt-1">{t('heimdall.depositPctDescription')}</p>
          </div>
          <div>
            <label htmlFor="heimdall-validity" className="block text-sm text-bambu-gray mb-1">
              {t('heimdall.validityDays')}
            </label>
            <input
              id="heimdall-validity"
              type="number"
              min={1}
              max={365}
              step={1}
              value={validityDays}
              onChange={(e) => setValidityDays(e.target.value)}
              className={INPUT}
            />
            <p className="text-sm text-bambu-gray mt-1">{t('heimdall.validityDaysDescription')}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-bambu-dark-tertiary">
          <Button variant="primary" size="sm" onClick={handleSave} disabled={!canUpdate || saveMutation.isPending}>
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {t('heimdall.save')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleTest}
            disabled={testLoading || (!baseUrl.trim() && !settings?.heimdall_base_url)}
          >
            {testLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {t('heimdall.test')}
          </Button>
          {resultKey && (
            <span
              className={`inline-flex items-center gap-1 text-sm ${testResult?.reachable ? 'text-bambu-green' : 'text-status-error'}`}
              role="status"
            >
              {testResult?.reachable ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
              {t(resultKey)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
