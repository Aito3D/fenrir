import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { bearerAuthHeaders } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { focusRingCls } from '../formStyles';
import { Toggle } from '../Toggle';
import { RevenueClosablePanel } from './RevenueClosablePanel';
import { failureMessage, readJsonBody } from './lib/dashboard';
import { formatFcp, formatPerMinute } from './lib/format';
import type { DepreciationAsset, DepreciationState } from './lib/types';

const URL = '/api/v1/revenue/depreciation';
const DASH = '—';
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** First day after the asset's life. shortcut: a 31st can land a few days late, the server's clamped date decides the charge. */
function lifeEnd(a: DepreciationAsset): string | null {
  if (!a.start || !a.months) return null;
  const d = new Date(`${a.start}T00:00:00`);
  d.setMonth(d.getMonth() + a.months);
  return iso(d);
}
type Phase = 'running' | 'inactive' | 'notStarted' | 'ended' | 'unknown';
function phase(a: DepreciationAsset, today: string): Phase {
  const end = lifeEnd(a);
  if (a.status !== 'active') return 'inactive';
  if (!end || !a.start || !a.cost) return 'unknown';
  return today < a.start ? 'notStarted' : today >= end ? 'ended' : 'running';
}
const monthly = (a: DepreciationAsset, today: string) => (phase(a, today) === 'running' ? (a.cost ?? 0) / (a.months ?? 1) : 0);
const frDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

/** Zoho's fixed assets, by asset type: the ones switched on are charged to 3D printing by the minute, like rent. */
export function RevenueDepreciation({ canManage, onChanged, onClose, returnFocus }: {
  canManage: boolean;
  onChanged: () => void;
  onClose?: () => void;
  returnFocus?: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [dep, setDep] = useState<DepreciationState | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; retry: () => void } | null>(null);
  const today = iso(new Date());

  const call = useCallback(async (url: string, init?: RequestInit): Promise<DepreciationState> => {
    const res = await fetch(url, { ...init, headers: { ...bearerAuthHeaders(), ...init?.headers } });
    const body = await readJsonBody(res);
    if (!res.ok) throw new Error(failureMessage(res.status, body));
    const state = body as DepreciationState;
    setDep(state);
    setSelected(new Set(state.selected));
    setDirty(false);
    setError(null);
    return state;
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await call(`${URL}/refresh`, { method: 'POST' });
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e), retry: () => void refresh() });
    } finally {
      setBusy(false);
    }
  }, [call]);

  const load = useCallback(async () => {
    try {
      const state = await call(URL);
      // Nothing read from Zoho yet: the first opening fetches the list.
      if (canManage && state.assets.length === 0) await refresh();
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e), retry: () => void load() });
    }
  }, [call, canManage, refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!dep || busy) return;
    setBusy(true);
    try {
      await call(URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected: dep.assets.filter((a) => selected.has(a.id)).map((a) => a.id) }),
      });
      showToast(t('revenue.depreciation.saved'), 'success');
      onChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('revenue.depreciation.failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const set = (ids: string[], on: boolean) => {
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    setDirty(true);
  };

  const groups = new Map<string, DepreciationAsset[]>();
  for (const a of dep?.assets ?? []) groups.set(a.type, [...(groups.get(a.type) ?? []), a]);
  const locked = !canManage || busy;

  return (
    <RevenueClosablePanel
      title={t('revenue.depreciation.title')}
      onClose={onClose}
      returnFocus={returnFocus}
      action={
        canManage && dep ? (
          <>
            {/* A refresh replaces the selection on screen with the stored one: unsaved switches go first. */}
            <button type="button" disabled={busy || dirty} onClick={() => void refresh()}
              className={`text-xs text-bambu-gray-light underline underline-offset-2 hover:text-white disabled:opacity-40 ${focusRingCls}`}>
              {t('revenue.depreciation.refresh')}
            </button>
            <button type="button" disabled={!dirty || busy} onClick={() => void save()}
              className={`rounded-md bg-bambu-green px-3 py-1 text-sm text-white disabled:opacity-40 ${focusRingCls}`}>
              {busy ? '…' : t('revenue.fixedCosts.save')}
            </button>
          </>
        ) : null
      }
    >
      <p className="mb-2 text-xs text-bambu-gray">{t('revenue.depreciation.intro')}</p>
      {error && (
        <p role="alert" className="mb-2 text-sm text-red-400">
          {error.message}{' '}
          <button type="button" className={`ml-2 underline underline-offset-2 ${focusRingCls}`} onClick={error.retry}>
            {t('revenue.sync.retry')}
          </button>
        </p>
      )}
      {!dep ? (
        !error && <p className="text-sm text-bambu-gray">{t('revenue.state.loading')}</p>
      ) : dep.assets.length === 0 ? (
        !busy && <p className="text-sm text-bambu-gray">{t('revenue.depreciation.empty')}</p>
      ) : (
        <div className="max-w-3xl space-y-3 text-sm">
          {[...groups].map(([type, assets]) => {
            const usable = assets.filter((a) => a.status === 'active').map((a) => a.id);
            const sum = assets.reduce((s, a) => s + (selected.has(a.id) ? monthly(a, today) : 0), 0);
            return (
              <div key={type} role="group" aria-label={type}>
                <div className="flex items-center gap-2 border-b border-bambu-dark-tertiary pb-1 text-white">
                  <Toggle aria-label={`${type} (${assets.length})`} disabled={locked || usable.length === 0}
                    checked={usable.length > 0 && usable.every((id) => selected.has(id))} onChange={(on) => set(usable, on)} />
                  <span className="flex-1 font-medium">{type} ({assets.length})</span>
                  <span className="tabular-nums">{formatFcp(sum)}</span>
                  <span className="w-28 text-right tabular-nums text-bambu-gray-light">{formatPerMinute(sum)}</span>
                </div>
                {assets.map((a) => {
                  const p = phase(a, today);
                  const end = lifeEnd(a);
                  return (
                    <div key={a.id} className="flex items-center gap-2 py-1 pl-4 text-bambu-gray-light">
                      <Toggle aria-label={a.name} disabled={locked || a.status !== 'active'} checked={selected.has(a.id)} onChange={(on) => set([a.id], on)} />
                      <span className="min-w-0 flex-1 truncate" title={`${a.number} · ${a.cost == null ? DASH : formatFcp(a.cost)}`}>{a.name}</span>
                      <span className="hidden text-xs text-bambu-gray sm:inline">
                        {p === 'running' || p === 'unknown'
                          ? a.start && end ? `${frDay(a.start)} → ${end.slice(5, 7)}/${end.slice(0, 4)}` : DASH
                          : t(`revenue.depreciation.${p}`)}
                      </span>
                      <span className="w-28 text-right tabular-nums">{p === 'running' ? formatFcp(monthly(a, today)) : DASH}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {dep.readAt && <p className="text-xs text-bambu-gray">{t('revenue.depreciation.readAt', { date: new Date(dep.readAt).toLocaleString() })}</p>}
        </div>
      )}
    </RevenueClosablePanel>
  );
}
