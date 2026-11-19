import type { KeyboardEvent } from 'react';
import { focusRingCls } from '../formStyles';
import { segmentPanelId, segmentTabId } from './lib/dashboard';


/** The revenue page's segmented control, in the `ScreenTabs` look. With `tabs` (pass `idPrefix`) it
 *  is a WAI-ARIA tablist like `ScreenTabs`: arrows / Home / End move focus and select, only the
 *  selected tab is in the tab order. Otherwise pressed buttons. */
export function RevenueSegmented<T extends string>(p: {
  label: string;
  options: readonly { id: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  tabs?: boolean;
  idPrefix?: string;
  /** Inside a panel: the track one step darker, the selection one step lighter. */
  inPanel?: boolean;
}) {
  const prefix = p.idPrefix ?? 'segment';
  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const n = p.options.length;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % n;
    else if (e.key === 'ArrowLeft') next = (index - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next === null) return;
    e.preventDefault();
    const target = p.options[next].id;
    p.onChange(target);
    document.getElementById(segmentTabId(prefix, target))?.focus();
  };

  return (
    <div role={p.tabs ? 'tablist' : 'group'} aria-label={p.label} className={`inline-flex shrink-0 gap-0.5 rounded-[10px] p-[3px] ${p.inPanel ? 'bg-bambu-dark' : 'bg-bambu-dark-secondary/60'}`}>
      {p.options.map((o, index) => {
        const on = o.id === p.value;
        return (
          <button
            key={o.id}
            type="button"
            {...(p.tabs
              ? {
                  role: 'tab',
                  id: segmentTabId(prefix, o.id),
                  'aria-selected': on,
                  'aria-controls': segmentPanelId(prefix, o.id),
                  tabIndex: on ? 0 : -1,
                  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => move(e, index),
                }
              : { 'aria-pressed': on })}
            title={o.title}
            onClick={() => p.onChange(o.id)}
            className={`rounded-lg px-3.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 ${
              on ? `${p.inPanel ? 'bg-bambu-dark-tertiary' : 'bg-bambu-dark-secondary'} text-white shadow-sm` : 'text-bambu-gray-light hover:text-white'
            } ${focusRingCls}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
