// State container for the calculator page: input values, localStorage
// persistence (with migration of the legacy decimal-hours field), URL-param
// prefill ("Open in calculator" on an archive), tab ↔ URL sync and input
// validation. No pricing math lives here — see utils/pricing.ts.

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PricingInputs } from '../utils/pricing';
import { correctedTimeH } from '../utils/calculatorInsights';

export const PAGE_TABS = ['calculator', 'filaments', 'printers', 'defaults'] as const;
export type PageTab = (typeof PAGE_TABS)[number];

const STORAGE_KEY = 'calculator-state';
const PREFILL_PARAMS = ['weight', 'time', 'quantity', 'filamentId', 'printerId', 'energyKwh', 'timeSource'] as const;

export interface CalcState {
  weight: string;
  timeH: string;
  timeM: string;
  /** Measured energy in kWh from an archive prefill; '' = use the estimate. */
  energyKwh: string;
  quantity: string;
  modelingHours: string;
  modelingBasePrice: string;
  prepModel: string;
  prepSlicing: string;
  prepTransfer: string;
  postRemoval: string;
  postSupport: string;
  postAdditional: string;
  postFulfillment: string;
  stuffAmount: string;
  stuffMarkup: string;
  targetPrice: string;
  filamentId: number | null;
  printerId: number | null;
  easyMode: boolean;
  /** Reality-check session overrides; '' = use the stored default. */
  failureRateOverride: string;
  tariffOverride: string;
  /** Measured time-accuracy % applied to the slicer estimate; '' = off. */
  timeAccuracyOverride: string;
  /** Measured printer figures applied for this session; '' = use the profile. */
  powerWattsOverride: string;
  dailyHoursOverride: string;
  /** Reality-check rows the user dismissed (checkKey values). */
  dismissedChecks: string[];
  /** True when the time fields came from a slicer estimate (prefill), so the
      time-accuracy correction chip is relevant. Cleared on manual edits. */
  timeFromEstimate: boolean;
}

export const DEFAULT_STATE: CalcState = {
  weight: '',
  timeH: '',
  timeM: '',
  energyKwh: '',
  quantity: '1',
  modelingHours: '',
  modelingBasePrice: '',
  prepModel: '',
  prepSlicing: '',
  prepTransfer: '',
  postRemoval: '',
  postSupport: '',
  postAdditional: '',
  postFulfillment: '',
  stuffAmount: '',
  stuffMarkup: '',
  targetPrice: '',
  filamentId: null,
  printerId: null,
  easyMode: false,
  failureRateOverride: '',
  tariffOverride: '',
  timeAccuracyOverride: '',
  powerWattsOverride: '',
  dailyHoursOverride: '',
  dismissedChecks: [],
  timeFromEstimate: false,
};

/** Parse a numeric input string, falling back when empty or invalid. */
export const num = (s: string, fallback = 0): number => {
  if (s.trim() === '') return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};

/** Split decimal hours ("1.25") into hour/minute field values ("1" / "15"). */
export function splitDecimalHours(value: number): { timeH: string; timeM: string } {
  let h = Math.floor(value);
  let m = Math.round((value - h) * 60);
  if (m === 60) {
    h += 1;
    m = 0;
  }
  return { timeH: String(h), timeM: m > 0 ? String(m) : '' };
}

function loadState(): CalcState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_STATE;
    const legacy = parsed as Partial<CalcState> & { time?: string };
    const state: CalcState = { ...DEFAULT_STATE, ...legacy };
    // Migrate the legacy single decimal-hours field to hours + minutes.
    if (typeof legacy.time === 'string' && legacy.timeH === undefined) {
      const t = Number(legacy.time);
      if (legacy.time.trim() !== '' && Number.isFinite(t) && t >= 0) {
        Object.assign(state, splitDecimalHours(t));
      }
    }
    delete (state as unknown as Record<string, unknown>).time;
    return state;
  } catch {
    return DEFAULT_STATE;
  }
}

export function useCalculatorState() {
  const { t } = useTranslation();
  const [state, setState] = useState<CalcState>(loadState);
  const [searchParams, setSearchParams] = useSearchParams();

  // The active tab lives in the URL so refresh, back button and deep links
  // all keep it; the plain calculator tab is the clean URL.
  const tabParam = searchParams.get('tab');
  const tab: PageTab = PAGE_TABS.includes(tabParam as PageTab) ? (tabParam as PageTab) : 'calculator';
  const setTab = (next: PageTab) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === 'calculator') params.delete('tab');
        else params.set('tab', next);
        return params;
      },
      { replace: true },
    );
  };

  // Prefill from URL params (e.g. "Open in calculator" on an archive):
  // overwrite only what the archive knows, keep saved labor fields intact,
  // then strip just the prefill params (the tab param survives).
  useEffect(() => {
    if (!PREFILL_PARAMS.some((key) => searchParams.get(key) !== null)) return;
    const weight = searchParams.get('weight');
    const time = searchParams.get('time');
    const quantity = searchParams.get('quantity');
    const filamentId = searchParams.get('filamentId');
    const printerId = searchParams.get('printerId');
    const patch: Partial<CalcState> = {};
    if (weight !== null && Number.isFinite(Number(weight)) && Number(weight) >= 0) patch.weight = weight;
    if (time !== null && Number.isFinite(Number(time)) && Number(time) >= 0) {
      Object.assign(patch, splitDecimalHours(Number(time)));
      // Slicer estimates can be corrected by the measured time-accuracy chip;
      // an actual (measured) duration needs no correction.
      patch.timeFromEstimate = searchParams.get('timeSource') === 'est';
    }
    if (quantity !== null && Number.isInteger(Number(quantity)) && Number(quantity) >= 1) patch.quantity = quantity;
    const energyKwh = searchParams.get('energyKwh');
    if (energyKwh !== null && Number.isFinite(Number(energyKwh)) && Number(energyKwh) > 0) {
      patch.energyKwh = energyKwh;
    }
    if (filamentId !== null && Number.isInteger(Number(filamentId))) patch.filamentId = Number(filamentId);
    if (printerId !== null && Number.isInteger(Number(printerId))) patch.printerId = Number(printerId);
    if (Object.keys(patch).length > 0) setState((s) => ({ ...s, ...patch }));
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        for (const key of PREFILL_PARAMS) params.delete(key);
        return params;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced persistence of every input to localStorage.
  useEffect(() => {
    const handle = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        // Storage unavailable (private mode, quota) — inputs just won't persist.
      }
    }, 500);
    return () => clearTimeout(handle);
  }, [state]);

  const set = (patch: Partial<CalcState>) => setState((s) => ({ ...s, ...patch }));

  const reset = () => {
    setState((s) => ({ ...DEFAULT_STATE, easyMode: s.easyMode }));
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
  };

  const errors = useMemo(() => {
    const e: Partial<Record<keyof CalcState, string>> = {};
    const nonNegative: Array<keyof CalcState> = [
      'weight', 'timeH', 'timeM', 'energyKwh', 'modelingHours', 'modelingBasePrice', 'prepModel', 'prepSlicing',
      'prepTransfer', 'postRemoval', 'postSupport', 'postAdditional', 'postFulfillment',
      'stuffAmount', 'stuffMarkup', 'targetPrice',
    ];
    for (const key of nonNegative) {
      const raw = state[key] as string;
      if (raw.trim() !== '' && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
        e[key] = t('calculator.valNonNegative');
      }
    }
    const qty = Number(state.quantity);
    if (state.quantity.trim() === '' || !Number.isInteger(qty) || qty < 1) {
      e.quantity = t('calculator.valQuantityMin');
    }
    return e;
  }, [state, t]);

  return { state, set, reset, errors, tab, setTab };
}

/** Read the persisted calculator state without mounting the hook (quote page). */
export function loadCalculatorState(): CalcState {
  return loadState();
}

/** Synchronous persist for navigation flows that outrun the 500ms debounce. */
export function persistCalculatorStateNow(state: CalcState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is best-effort (private mode, quota).
  }
}

/**
 * Fold the reality-check session overrides into the pricing inputs. The
 * pricing engine is untouched — an applied measured value is just a different
 * input. Shared by the calculator and quote pages so their totals can't
 * diverge. Failure/tariff replace stored defaults; power/daily-hours replace
 * the selected printer profile's figures; the time-accuracy correction
 * rescales the slicer estimate (only while it still IS an estimate).
 */
export function foldSessionOverrides<
  D extends { failure_rate_pct: number; electricity_tariff: number },
  P extends { power_watts: number; daily_usage_hours: number },
>(state: CalcState, defaults: D, printer: P, inputs: PricingInputs): { defaults: D; printer: P; inputs: PricingInputs } {
  let d = defaults;
  if (state.failureRateOverride !== '' || state.tariffOverride !== '') {
    d = {
      ...defaults,
      failure_rate_pct:
        state.failureRateOverride !== ''
          ? num(state.failureRateOverride, defaults.failure_rate_pct)
          : defaults.failure_rate_pct,
      electricity_tariff:
        state.tariffOverride !== ''
          ? num(state.tariffOverride, defaults.electricity_tariff)
          : defaults.electricity_tariff,
    };
  }
  let p = printer;
  if (state.powerWattsOverride !== '' || state.dailyHoursOverride !== '') {
    p = {
      ...printer,
      power_watts:
        state.powerWattsOverride !== '' ? num(state.powerWattsOverride, printer.power_watts) : printer.power_watts,
      daily_usage_hours:
        state.dailyHoursOverride !== ''
          ? num(state.dailyHoursOverride, printer.daily_usage_hours)
          : printer.daily_usage_hours,
    };
  }
  let i = inputs;
  if (state.timeAccuracyOverride !== '' && state.timeFromEstimate) {
    const accuracy = num(state.timeAccuracyOverride);
    if (accuracy > 0) i = { ...inputs, printing_time_h: correctedTimeH(inputs.printing_time_h, accuracy) };
  }
  return { defaults: d, printer: p, inputs: i };
}

/** CalcState → PricingInputs mapping shared by the calculator and quote pages. */
export function buildPricingInputs(state: CalcState, defaults: { stuff_markup_pct: number }): PricingInputs {
  return {
    weight_g: Math.max(0, num(state.weight)),
    printing_time_h: Math.max(0, num(state.timeH)) + Math.max(0, num(state.timeM)) / 60,
    measured_energy_kwh: num(state.energyKwh) > 0 ? num(state.energyKwh) : undefined,
    quantity: Math.max(1, Math.floor(num(state.quantity, 1))),
    modeling_hours: Math.max(0, num(state.modelingHours)),
    modeling_base_price: Math.max(0, num(state.modelingBasePrice)),
    prep_model_min: Math.max(0, num(state.prepModel)),
    prep_slicing_min: Math.max(0, num(state.prepSlicing)),
    prep_transfer_min: Math.max(0, num(state.prepTransfer)),
    post_removal_min: Math.max(0, num(state.postRemoval)),
    post_support_min: Math.max(0, num(state.postSupport)),
    post_additional_min: Math.max(0, num(state.postAdditional)),
    post_fulfillment_min: Math.max(0, num(state.postFulfillment)),
    stuff_amount: Math.max(0, num(state.stuffAmount)),
    stuff_markup_pct: Math.max(0, num(state.stuffMarkup, defaults.stuff_markup_pct)),
  };
}
