import { focusRingCls } from '../formStyles';

/** The revenue page's segmented control, in the `ScreenTabs` look: `role="tab"` when it switches
 *  views (`tabs`), pressed buttons otherwise. */
export function RevenueSegmented<T extends string>(p: {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  tabs?: boolean;
}) {
  return (
    <div role={p.tabs ? 'tablist' : 'group'} aria-label={p.label} className="inline-flex shrink-0 gap-0.5 rounded-[10px] bg-bambu-dark-secondary/60 p-[3px]">
      {p.options.map((o) => {
        const on = o.id === p.value;
        return (
          <button
            key={o.id}
            type="button"
            {...(p.tabs ? { role: 'tab', 'aria-selected': on } : { 'aria-pressed': on })}
            onClick={() => p.onChange(o.id)}
            className={`rounded-lg px-3.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 ${
              on ? 'bg-bambu-dark-secondary text-white shadow-sm' : 'text-bambu-gray-light hover:text-white'
            } ${focusRingCls}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
