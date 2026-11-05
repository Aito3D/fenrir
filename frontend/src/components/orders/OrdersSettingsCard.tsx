import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, PackageCheck, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderBoardResponse, OrderBoardSettings } from '../../api/client';
import { Button } from '../Button';
import { Card, CardContent, CardHeader } from '../Card';
import { Toggle } from '../Toggle';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { formatDateTime } from '../../utils/date';

const SETTINGS_KEY = ['order-board-settings'] as const;
const BOARD_KEY = ['order-board'] as const;
const INTERVALS = [5, 15, 60];
const MAX_AGE_LIMIT = 3650;
const inputCls =
  'rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-sm text-white focus:border-bambu-green focus:outline-none disabled:opacity-60';

/** Settings → Orders. Its own endpoints, gated on orders:update, because
 *  Operators hold settings:read only and must still be able to tune the board. */
export function OrdersSettingsCard() {
  const { loading, hasPermission } = useAuth();
  // hasPermission allows everything while auth is loading, so wait for it.
  if (loading || !hasPermission('orders:update')) return null;
  return <OrdersSettingsBody />;
}

function OrdersSettingsBody() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const ids = { interval: useId(), days: useId(), brand: useId() };

  const { data: settings } = useQuery<OrderBoardSettings>({ queryKey: SETTINGS_KEY, queryFn: api.getOrderBoardSettings });
  const { data: board } = useQuery<OrderBoardResponse>({ queryKey: BOARD_KEY, queryFn: api.getOrderBoard });

  // Every change saves at once; the server answers with the cleaned values.
  const save = useMutation({
    mutationFn: api.updateOrderBoardSettings,
    onSuccess: saved => {
      queryClient.setQueryData(SETTINGS_KEY, saved);
      queryClient.invalidateQueries({ queryKey: BOARD_KEY });
      showToast(t('orders.settings.saved'));
    },
    onError: () => showToast(t('orders.settings.saveFailed'), 'error'),
  });
  const sync = useMutation({
    mutationFn: api.refreshOrderBoard,
    onSuccess: fresh => queryClient.setQueryData(BOARD_KEY, fresh),
    onError: () => showToast(t('orders.refreshFailed'), 'error'),
  });

  const [daysDraft, setDaysDraft] = useState<string | null>(null);
  const [brandDraft, setBrandDraft] = useState('');

  if (!settings) {
    return (
      <Card>
        <CardContent>
          <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin text-bambu-gray" />
        </CardContent>
      </Card>
    );
  }

  // Each save sends the whole object built from the last saved values, so a
  // second change made before the first answer would undo it. Lock until then.
  const busy = save.isPending;

  const commitDays = () => {
    const days = Number(daysDraft);
    const valid = daysDraft !== null && daysDraft.trim() !== '' && Number.isInteger(days) && days >= 0 && days <= MAX_AGE_LIMIT;
    if (valid && days !== settings.max_age_days) save.mutate({ ...settings, max_age_days: days });
    setDaysDraft(null); // back to the saved value until the server answers
  };
  const addBrand = () => {
    const brand = brandDraft.trim();
    setBrandDraft('');
    if (!brand || settings.core_brands.some(b => b.toLowerCase() === brand.toLowerCase())) return;
    save.mutate({ ...settings, core_brands: [...settings.core_brands, brand] });
  };

  return (
    <>
      <Card id="card-orders-sync">
        <CardHeader>
          <div className="flex items-center gap-2">
            <PackageCheck className="h-5 w-5 text-gray-400" />
            <h2 className="text-lg font-semibold text-white">{t('orders.settings.syncTitle')}</h2>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-white">{t('orders.settings.syncEnabled')}</div>
              <div className="mt-0.5 text-sm text-bambu-gray">{t('orders.settings.syncEnabledHint')}</div>
            </div>
            <Toggle
              checked={settings.sync_enabled}
              onChange={sync_enabled => save.mutate({ ...settings, sync_enabled })}
              disabled={busy}
              aria-label={t('orders.settings.syncEnabled')}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <label htmlFor={ids.interval} className="text-white">
                {t('orders.settings.interval')}
              </label>
              <div className="mt-0.5 text-sm text-bambu-gray">{t('orders.settings.intervalHint')}</div>
            </div>
            <select
              id={ids.interval}
              value={settings.sync_minutes}
              onChange={e => save.mutate({ ...settings, sync_minutes: Number(e.target.value) })}
              disabled={busy}
              className={inputCls}
            >
              {INTERVALS.map(minutes => (
                <option key={minutes} value={minutes}>
                  {minutes === 60 ? t('orders.settings.hour') : t('orders.settings.minutes', { n: minutes })}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-bambu-dark px-3 py-2.5">
            <span className="text-sm text-bambu-gray">
              {board?.sync.last_success_at
                ? t('orders.settings.lastSync', { when: formatDateTime(board.sync.last_success_at) })
                : t('orders.settings.neverSynced')}
            </span>
            <Button variant="secondary" size="sm" onClick={() => sync.mutate()} disabled={sync.isPending}>
              <RefreshCw aria-hidden="true" className={`h-4 w-4 ${sync.isPending ? 'animate-spin' : ''}`} />
              {t('orders.settings.syncNow')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card id="card-orders-shows">
        <CardHeader>
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-5 w-5 text-gray-400" />
            <h2 className="text-lg font-semibold text-white">{t('orders.settings.showsTitle')}</h2>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <label htmlFor={ids.days} className="text-white">
                {t('orders.settings.maxAge')}
              </label>
              <div className="mt-0.5 text-sm text-bambu-gray">{t('orders.settings.maxAgeHint')}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <input
                id={ids.days}
                type="number"
                min={0}
                max={MAX_AGE_LIMIT}
                step={1}
                value={daysDraft ?? String(settings.max_age_days)}
                onChange={e => setDaysDraft(e.target.value)}
                onBlur={commitDays}
                disabled={busy}
                onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
                className={`${inputCls} w-24 text-right tabular-nums`}
              />
              <span className="text-sm text-bambu-gray">{t('orders.settings.days')}</span>
            </div>
          </div>
          <div>
            <label htmlFor={ids.brand} className="text-white">
              {t('orders.settings.coreBrands')}
            </label>
            <div className="mt-0.5 text-sm text-bambu-gray">{t('orders.settings.coreBrandsHint')}</div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {settings.core_brands.map(brand => (
                <span key={brand} className="inline-flex items-center gap-1 rounded-full border border-bambu-dark-tertiary bg-bambu-dark py-1 pl-3 pr-1.5 text-xs text-white">
                  <span>{brand}</span>
                  <button
                    type="button"
                    aria-label={t('orders.settings.removeBrand', { brand })}
                    onClick={() => save.mutate({ ...settings, core_brands: settings.core_brands.filter(b => b !== brand) })}
                    disabled={busy}
                    className="rounded-full p-0.5 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"
                  >
                    <X aria-hidden="true" className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                id={ids.brand}
                type="text"
                value={brandDraft}
                maxLength={60}
                onChange={e => setBrandDraft(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addBrand()}
                disabled={busy}
                placeholder={t('orders.settings.addBrand')}
                aria-label={t('orders.settings.addBrand')}
                className="w-40 rounded-full border border-dashed border-bambu-dark-tertiary bg-transparent px-3 py-1 text-xs text-white placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
