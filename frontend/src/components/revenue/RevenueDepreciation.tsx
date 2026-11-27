import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { bearerAuthHeaders } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { focusRingCls } from '../formStyles';
import { Toggle } from '../Toggle';
import { CHARGES_CARD, CHARGES_LINK, RevenueChargesSection } from './RevenueChargesSection';
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
/** Share of the asset's life already behind it (0–1). */
function lifeSpent(a: DepreciationAsset, today: string): number {
  const end = lifeEnd(a);
  if (!a.start || !end) return 0;
  const [from, to, now] = [a.start, end, today].map((d) => new Date(`${d}T00:00:00`).getTime());
  return Math.min(1, Math.max(0, (now - from) / (to - from)));
}
const frDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

/** Zoho's fixed assets, by asset type: the ones switched on are charged to 3D printing by the minute, like rent. */
export function RevenueDepreciation({ canManage, onChanged, footer }: {
  canManage: boolean;
  onChanged: () => void;
  /** The dialog's footer, for the unsaved-changes bar. */
  footer?: HTMLElement | null;
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
    <RevenueChargesSection
      title={t('revenue.depreciation.title')}
      intro={t('revenue.depreciation.intro')}
      footer={footer}
      save={canManage && dep ? { dirty, busy, onSave: () => void save(), onDiscard: () => void load() } : undefined}
      action={
        <>
          {dep?.readAt && <span className="text-xs text-bambu-gray">{t('revenue.depreciation.readAt', { date: new Date(dep.readAt).toLocaleString() })}</span>}
          {canManage && dep && (
            // A refresh replaces the selection on screen with the stored one: unsaved switches go first.
            <button type="button" disabled={busy || dirty} onClick={() => void refresh()} className={CHARGES_LINK}>
              {t('revenue.depreciation.refresh')}
            </button>
          )}
        </>
      }
    >
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
        <div className={`${CHARGES_CARD} text-sm`}>
          {[...groups].map(([type, assets]) => {
            const usable = assets.filter((a) => a.status === 'active').map((a) => a.id);
            const sum = assets.reduce((s, a) => s + (selected.has(a.id) ? monthly(a, today) : 0), 0);
            return (
              <div key={type} role="group" aria-label={type}>
                <div className="flex items-center gap-3 border-b border-bambu-dark-tertiary bg-bambu-dark/40 px-3 py-2.5 text-white">
                  <Toggle aria-label={`${type} (${assets.length})`} disabled={locked || usable.length === 0}
                    checked={usable.length > 0 && usable.every((id) => selected.has(id))} onChange={(on) => set(usable, on)} />
                  <span className="flex-1 font-medium">{type} ({assets.length})</span>
                  <span className="font-semibold tabular-nums">{formatFcp(sum)}</span>
                  <span className="w-28 text-right tabular-nums text-bambu-gray-light">{formatPerMinute(sum)}</span>
                </div>
                {assets.map((a) => {
                  const p = phase(a, today);
                  const end = lifeEnd(a);
                  return (
                    <div key={a.id} className={`flex items-center gap-3 border-b border-bambu-dark-tertiary/60 px-3 py-2 ${selected.has(a.id) ? 'text-white' : 'text-bambu-gray'}`}>
                      <Toggle aria-label={a.name} disabled={locked || a.status !== 'active'} checked={selected.has(a.id)} onChange={(on) => set([a.id], on)} />
                      <span className="min-w-0 flex-1 truncate" title={`${a.number} · ${a.cost == null ? DASH : formatFcp(a.cost)}`}>{a.name}</span>
                      {(p === 'running' || p === 'ended') && (
                        <span aria-hidden className="hidden h-1 w-28 overflow-hidden rounded-full bg-bambu-dark-tertiary md:block">
                          <span className="block h-full bg-violet-400" style={{ width: `${100 * lifeSpent(a, today)}%` }} />
                        </span>
                      )}
                      <span className="hidden w-44 text-xs text-bambu-gray sm:inline">
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
        </div>
      )}
    </RevenueChargesSection>
  );
}
