import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { focusRingCls } from '../formStyles';
import { RevenueSegmented } from './RevenueSegmented';
import { RANGE_PRESETS } from './lib/buckets';
import { REVENUE_HISTORY_START } from './lib/dates';
import type { RangeChoice } from './lib/dashboard';
import type { CustomerSegment, RangePresetId, RevenueGranularity, RevenueKind } from './lib/types';

export const PICK_CLS = `inline-flex items-center gap-1.5 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 py-1.5 text-[13px] text-bambu-gray-light hover:text-white disabled:opacity-40 disabled:hover:text-bambu-gray-light ${focusRingCls}`;
const MENU_ITEM = `w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors ${focusRingCls}`;
const menuItemCls = (on: boolean) => `${MENU_ITEM} ${on ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray-light hover:bg-bambu-dark-tertiary hover:text-white'}`;
const DATE_INPUT = `rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-sm text-white ${focusRingCls}`;

/** A trigger and the menu hanging under it, the `TimeframeSelector` way (backdrop click and Escape close it). */
export function RevenuePopover(p: {
  label: string;
  trigger: ReactNode;
  haspopup?: 'dialog' | 'listbox';
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup={p.haspopup ?? 'dialog'}
        aria-pressed={p.pressed}
        disabled={p.disabled}
        onClick={() => setOpen((o) => !o)}
        className={`${PICK_CLS} ${p.pressed ? 'text-white' : ''}`}
      >
        {p.trigger}
        <ChevronDown aria-hidden className="h-3 w-3" />
      </button>
      {open && <div className="fixed inset-0 z-10" onClick={close} />}
      <div
        role="dialog"
        aria-label={p.label}
        hidden={!open}
        data-align="start"
        className={`aito-tf-menu absolute left-0 top-full z-20 mt-1 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-2 shadow-xl ${p.className ?? ''}`}
      >
        {p.children(close)}
      </div>
    </div>
  );
}

const GRANULARITIES: readonly RevenueGranularity[] = ['day', 'week', 'month', 'year'];
/** The keyboard shortcuts the row binds: loki's French initials (Jour, Semaine, Mois, Année). */
const SHORTCUT: Record<string, RevenueGranularity> = { j: 'day', s: 'week', m: 'month', a: 'year' };
const SHORTCUT_LETTER: Record<RevenueGranularity, string> = { day: 'J', week: 'S', month: 'M', year: 'A' };
const PRESET_KEY: Record<RangePresetId, string> = { 'this-year': 'thisYear', 'last-12-months': 'last12Months', all: 'all' };
const SEGMENTS: readonly (CustomerSegment | null)[] = [null, 'pro', 'particulier', 'passage'];

/**
 * The page's control rows: ‹ range › and the granularity with the window shown (the view tabs at the
 * right), then goods / services,
 * the customer segment and whatever the page adds (brand filter, product search, chips).
 * Binds J S M A and ← → on the window, never while typing or with a modifier held.
 */
export function RevenueControls(p: {
  granularity: RevenueGranularity;
  onGranularity: (g: RevenueGranularity) => void;
  range: RangeChoice;
  onRange: (r: RangeChoice) => void;
  /** The window shown ("" before the first payload). */
  from: string;
  to: string;
  today: string;
  canPrev: boolean;
  canNext: boolean;
  onShift: (delta: number) => void;
  kind: RevenueKind | null;
  onKind: (k: RevenueKind | null) => void;
  segment: CustomerSegment | null;
  onSegment: (s: CustomerSegment | null) => void;
  showSegment: boolean;
  /** Set at the right end of the first row (the page's view tabs). */
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();

  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    onKey.current = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      const g = SHORTCUT[e.key.toLowerCase()];
      if (e.key === 'ArrowLeft' && p.canPrev) p.onShift(-1);
      else if (e.key === 'ArrowRight' && p.canNext) p.onShift(1);
      else if (g) p.onGranularity(g);
      else return;
      e.preventDefault();
    };
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const short = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
  const day = (d: string) => short.format(new Date(`${d}T00:00:00Z`));
  const rangeLabel =
    p.range.preset === 'custom' ? t('revenue.controls.custom') : p.range.preset === 'default' ? t('revenue.controls.auto') : t(`revenue.controls.${PRESET_KEY[p.range.preset]}`);
  // An incomplete or inverted pair stays a local draft; only a valid one becomes the range.
  const [draft, setDraft] = useState<{ from: string; to: string } | null>(null);
  const customFrom = draft?.from ?? (p.range.preset === 'custom' ? p.range.from : p.from);
  const customTo = draft?.to ?? (p.range.preset === 'custom' ? p.range.to : p.to);
  const editCustom = (next: { from: string; to: string }) => {
    const valid = next.from && next.to && REVENUE_HISTORY_START <= next.from && next.from <= next.to && next.to <= p.today;
    setDraft(valid ? null : next);
    if (valid) p.onRange({ preset: 'custom', ...next });
  };
  const segmentLabel = (s: CustomerSegment | null) => t(`revenue.filters.segments.${s ?? 'all'}`);
  const navCls = `${PICK_CLS} px-2`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={navCls} aria-label={t('revenue.controls.prev')} title={t('revenue.controls.prev')} disabled={!p.canPrev} onClick={() => p.onShift(-1)}>
          <ChevronLeft aria-hidden className="h-4 w-4" />
        </button>
        <RevenuePopover label={t('revenue.controls.range')} trigger={<><Calendar aria-hidden className="h-3.5 w-3.5" />{rangeLabel}</>} className="w-72 space-y-2">
          {(close) => (
            <>
              <div className="grid gap-0.5">
                {RANGE_PRESETS.map((r) => (
                  <button key={r.id} type="button" aria-pressed={p.range.preset === r.id} className={menuItemCls(p.range.preset === r.id)}
                    onClick={() => { p.onRange({ preset: r.id }); setDraft(null); close(); }}>
                    {t(`revenue.controls.${PRESET_KEY[r.id]}`)}
                  </button>
                ))}
                <button type="button" aria-pressed={p.range.preset === 'default'} className={menuItemCls(p.range.preset === 'default')}
                  onClick={() => { p.onRange({ preset: 'default' }); setDraft(null); close(); }}>
                  {t('revenue.controls.auto')} <span className="text-xs text-bambu-gray">{t('revenue.controls.autoHint')}</span>
                </button>
              </div>
              <div className="space-y-1.5 border-t border-bambu-dark-tertiary pt-2">
                <p className="px-1 text-xs uppercase tracking-wide text-bambu-gray">{t('revenue.controls.custom')}</p>
                <div className="flex items-center gap-1.5">
                  <input type="date" aria-label={t('revenue.controls.from')} className={DATE_INPUT} min={REVENUE_HISTORY_START} max={p.today} value={customFrom}
                    onChange={(e) => editCustom({ from: e.target.value, to: customTo })} />
                  <span aria-hidden className="text-sm text-bambu-gray">→</span>
                  <input type="date" aria-label={t('revenue.controls.to')} className={DATE_INPUT} min={REVENUE_HISTORY_START} max={p.today} value={customTo}
                    onChange={(e) => editCustom({ from: customFrom, to: e.target.value })} />
                </div>
              </div>
            </>
          )}
        </RevenuePopover>
        <button type="button" className={navCls} aria-label={t('revenue.controls.next')} title={t('revenue.controls.next')} disabled={!p.canNext} onClick={() => p.onShift(1)}>
          <ChevronRight aria-hidden className="h-4 w-4" />
        </button>
        <RevenueSegmented
          label={t('revenue.controls.granularity')}
          value={p.granularity}
          onChange={p.onGranularity}
          options={GRANULARITIES.map((g) => ({ id: g, label: t(`revenue.controls.${g}`), title: `${t(`revenue.controls.${g}`)} (${SHORTCUT_LETTER[g]})` }))}
        />
        <span aria-live="polite" className="text-[12.5px] tabular-nums text-bambu-gray">
          {p.from && p.to ? `${day(p.from)} – ${day(p.to)}` : '…'}
        </span>
      </div>
      {p.aside}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <RevenueSegmented
          label={t('revenue.filters.kind')}
          value={p.kind ?? 'all'}
          onChange={(k) => p.onKind(k === 'all' ? null : k)}
          options={[
            { id: 'all', label: t('revenue.filters.all') },
            { id: 'goods', label: t('revenue.filters.goods') },
            { id: 'services', label: t('revenue.filters.services') },
          ]}
        />
        {p.showSegment && (
          <RevenuePopover label={t('revenue.filters.segment')} trigger={segmentLabel(p.segment)} pressed={p.segment !== null} className="w-56">
            {(close) => (
              <div className="grid gap-0.5">
                {SEGMENTS.map((s) => (
                  <button key={s ?? 'all'} type="button" aria-pressed={p.segment === s} className={menuItemCls(p.segment === s)}
                    onClick={() => { p.onSegment(s); close(); }}>
                    {segmentLabel(s)}
                  </button>
                ))}
              </div>
            )}
          </RevenuePopover>
        )}
        {p.children}
      </div>
    </div>
  );
}
