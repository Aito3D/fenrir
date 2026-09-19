import { useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { FOCUS } from '../../utils/trackingShell';

// Below this width the card and a 420 px panel no longer fit side by side;
// the panel becomes a bottom sheet (index.css `.track-panel`, same number).
const SHEET_QUERY = '(max-width: 1119px)';
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

/** One of the tracking page's two side panels. Always mounted beside the
 *  card so its content keeps its state; closed means tucked behind the card
 *  and out of the accessibility tree and the tab order (`inert` +
 *  `aria-hidden`), not absent. Open, it slides out to its side while the
 *  card glides the other way, keeping its inner edge under the card and
 *  sitting vertically centred, shorter than the card (index.css
 *  `.track-stage` / `.track-panel`).
 *  On phones the same element rises as a bottom sheet; its header can be
 *  dragged down to dismiss it. Focus is the page's business
 *  (useTrackingPanel): the title only takes it. */
export function TrackingPanel({
  id,
  side,
  open,
  title,
  subtitle,
  titleRef,
  onClose,
  testId,
  children,
}: {
  id: string;
  side: 'left' | 'right';
  open: boolean;
  title: string;
  subtitle?: string;
  titleRef: (el: HTMLHeadingElement | null) => void;
  onClose: () => void;
  testId: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLElement>(null);
  const drag = useSheetDrag(panel, onClose);
  return (
    <aside
      ref={panel}
      id={id}
      data-testid={testId}
      data-side={side}
      data-state={open ? 'open' : undefined}
      role="dialog"
      aria-labelledby={`${id}-title`}
      aria-hidden={!open}
      inert={!open}
      className="track-panel rounded-[12px] border border-aito-line bg-aito-panel text-aito-ink"
    >
      <div className="track-panel-grabber" aria-hidden="true" />
      <div className="flex items-start justify-between gap-[12px] touch-none" {...drag}>
        <div className="min-w-0">
          <h2 id={`${id}-title`} ref={titleRef} tabIndex={-1} className={`rounded-[4px] text-[17px] font-semibold tracking-[-0.01em] ${FOCUS}`}>
            {title}
          </h2>
          {subtitle && <p className="mt-[4px] text-[13px] text-aito-muted">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('aito.track.panel.close')}
          className={`-mt-[4px] -mr-[4px] inline-flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-full border border-aito-line bg-aito-panel text-aito-muted transition-[color,border-color,background-color,transform] duration-150 hover:border-aito-muted/55 hover:bg-white/[.03] hover:text-aito-ink active:scale-[0.94] ${FOCUS}`}
        >
          <X className="h-[14px] w-[14px]" aria-hidden="true" />
        </button>
      </div>
      {children}
    </aside>
  );
}

/** A block of panel content that rises in once the panel has cleared the
 *  card, `i` steps into the stagger (index.css `.track-panel-reveal`). */
export function PanelReveal({ i, className = '', children }: { i: number; className?: string; children: ReactNode }) {
  return (
    <div className={`track-panel-reveal ${className}`} style={{ '--i': i } as CSSProperties}>
      {children}
    </div>
  );
}

/** Drag the sheet's header down to dismiss it (phones only, never under
 *  reduced motion). The sheet follows the pointer 1:1, the scrim thins as it
 *  goes, and on release a downward flick or more than 45 % of the height
 *  closes it — otherwise it springs back. The closing transition starts from
 *  the dragged position: the inline transform is cleared in the same frame
 *  the state flips, so CSS tweens from where the finger left it. */
function useSheetDrag(panel: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const state = useRef<{ startY: number; dy: number; history: [number, number][] } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = panel.current;
    if (!el || !window.matchMedia(SHEET_QUERY).matches || window.matchMedia(REDUCE_QUERY).matches) return;
    if ((e.target as HTMLElement).closest('button')) return;
    state.current = { startY: e.clientY, dy: 0, history: [[e.clientY, performance.now()]] };
    e.currentTarget.setPointerCapture(e.pointerId);
    el.style.transition = 'none';
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = state.current;
    const el = panel.current;
    if (!s || !el) return;
    s.dy = Math.max(0, e.clientY - s.startY);
    s.history.push([e.clientY, performance.now()]);
    if (s.history.length > 6) s.history.shift();
    el.style.transform = `translateY(${s.dy}px)`;
    el.style.setProperty('--track-sheet-progress', String(Math.max(0, 1 - s.dy / el.offsetHeight)));
  };
  const onPointerEnd = () => {
    const s = state.current;
    const el = panel.current;
    state.current = null;
    if (!s || !el) return;
    const [y0, t0] = s.history[0];
    const [y1, t1] = s.history[s.history.length - 1];
    const velocity = t1 > t0 ? (y1 - y0) / (t1 - t0) : 0; // px/ms, downward positive
    const dismiss = velocity > 0.45 || s.dy > el.offsetHeight * 0.45;
    el.style.transition = '';
    el.style.removeProperty('--track-sheet-progress');
    void el.offsetWidth;
    el.style.transform = '';
    if (dismiss) onClose();
  };
  return { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd };
}
