import type { KeyboardEvent } from 'react';
import { focusRingCls } from '../formStyles';
import { panelTabId, panelTabPanelId } from './panelTabIds';

export interface PanelTab<T extends string = string> {
  id: T;
  label: string;
  /** Paints a small error-toned dot beside the label: something behind this
   *  tab needs the operator, and a tab is otherwise the one place a problem
   *  can hide without a trace. */
  attention?: boolean;
}

/** The project panel's right-column tab strip.
 *
 *  Eyebrow typography, same as every PanelCard heading, so the strip reads as
 *  the column's heading rather than as a new kind of control — and an accent
 *  underline that slides between tabs, because a colour change alone is
 *  invisible on the muted-to-white step this palette gives it.
 *
 *  WAI-ARIA tabs, manual activation: arrow keys move focus AND select, since
 *  both panels are cheap to render and a roving focus that changes nothing
 *  reads as broken. Only the selected tab is in the tab order.
 *
 *  Renders the tabs only. The panels are the caller's — it decides which one
 *  mounts, and mounts only the selected one, so the Activity rail's infinite
 *  query never runs behind a tab nobody opened. */
export function PanelTabs<T extends string>({
  tabs,
  selected,
  onSelect,
  attentionLabel,
}: {
  tabs: readonly PanelTab<T>[];
  selected: T;
  onSelect: (id: T) => void;
  /** aria-label for the attention dot; the dot itself is a bare glyph. */
  attentionLabel: string;
}) {
  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    const target = tabs[next];
    onSelect(target.id);
    document.getElementById(panelTabId(target.id))?.focus();
  };

  return (
    <div role="tablist" className="mb-4 flex gap-5 border-b border-bambu-dark-tertiary">
      {tabs.map((tab, index) => {
        const isSelected = tab.id === selected;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={panelTabId(tab.id)}
            aria-selected={isSelected}
            aria-controls={panelTabPanelId(tab.id)}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => move(e, index)}
            className={`relative -mb-px inline-flex items-center gap-1.5 pb-2 text-xs uppercase tracking-wide transition-colors ${
              isSelected ? 'text-white' : 'text-bambu-gray hover:text-white'
            } ${focusRingCls}`}
          >
            {tab.label}
            {tab.attention && (
              <span
                data-testid="panel-tab-attention"
                role="img"
                aria-label={attentionLabel}
                className="h-1.5 w-1.5 rounded-full bg-status-error"
              />
            )}
            {/* The underline. Scaled rather than shown/hidden so it can
                animate; `transition-transform` covers Tailwind v4's native
                `scale` property (a hand-written `transition: transform` would
                not — see the Tailwind scale note in memory). */}
            <span
              aria-hidden="true"
              className={`absolute inset-x-0 -bottom-px h-0.5 origin-left rounded-full bg-bambu-green transition-transform duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                isSelected ? 'scale-x-100' : 'scale-x-0'
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}
