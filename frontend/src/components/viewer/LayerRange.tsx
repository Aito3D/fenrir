import { useMemo, useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import { focusRingCls } from '../formStyles';

const SPEEDS = [1, 2, 4] as const;

/** One vertical track with two handles: the band between them is the layers drawn. Values are
 *  0-based layer indexes; the labels show them 1-based. A click on the track moves the nearer
 *  end; arrow keys nudge a focused handle by one layer, Page Up/Down by ten. `weights` (one
 *  per layer, seconds) draws a ridge beside the track so slow layers stand out; `speed` is the
 *  playback multiplier the play button cycles through. */
export function LayerRange({
  count,
  range,
  onChange,
  playing,
  onTogglePlay,
  weights = null,
  speed = 1,
  onSpeed,
}: {
  count: number;
  range: [number, number];
  onChange: (next: [number, number]) => void;
  playing: boolean;
  onTogglePlay: () => void;
  weights?: number[] | null;
  speed?: number;
  onSpeed?: (next: number) => void;
}) {
  const { t } = useTranslation();
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<'top' | 'bottom' | null>(null);
  const last = Math.max(0, count - 1);
  const [bottom, top] = range;
  const yOf = (layer: number) => (last === 0 ? 0 : (1 - layer / last) * 100);
  const layerAt = (clientY: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.height === 0) return 0;
    const f = Math.min(1, Math.max(0, (r.bottom - clientY) / r.height));
    return Math.round(f * last);
  };
  const setTop = (layer: number) => onChange([bottom, Math.min(last, Math.max(layer, bottom))]);
  const setBottom = (layer: number) => onChange([Math.max(0, Math.min(layer, top)), top]);

  // The ridge: one horizontal bar per layer, as wide as its time share of the slowest layer.
  const ridge = useMemo(() => {
    if (!weights || weights.length < 2) return null;
    const max = Math.max(...weights, 0.001);
    const n = weights.length;
    const parts: string[] = [`M0 ${n}`];
    for (let i = 0; i < n; i += 1) {
      const w = Math.max(0.04, weights[i] / max);
      parts.push(`L${(w * 100).toFixed(1)} ${n - i}`, `L${(w * 100).toFixed(1)} ${n - i - 1}`);
    }
    parts.push('L0 0 Z');
    return { d: parts.join(' '), n };
  }, [weights]);

  const handleProps = (which: 'top' | 'bottom') => ({
    role: 'slider' as const,
    'aria-orientation': 'vertical' as const,
    'aria-valuemin': 1,
    'aria-valuemax': count,
    'aria-valuenow': (which === 'top' ? top : bottom) + 1,
    'aria-label': which === 'top' ? t('gcodeViewer.topLayer') : t('gcodeViewer.bottomLayer'),
    tabIndex: 0,
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      dragging.current = which;
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      if (dragging.current !== which) return;
      if (which === 'top') setTop(layerAt(e.clientY));
      else setBottom(layerAt(e.clientY));
    },
    onPointerUp: () => {
      dragging.current = null;
    },
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      const d = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : e.key === 'PageUp' ? 10 : e.key === 'PageDown' ? -10 : 0;
      if (!d) return;
      e.preventDefault();
      if (which === 'top') setTop(top + d);
      else setBottom(bottom + d);
    },
    className: `absolute left-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bambu-dark bg-bambu-green shadow ${focusRingCls}`,
  });

  return (
    <div data-testid="layer-range" className="flex h-full flex-col items-center gap-2 rounded-xl border border-white/10 bg-bambu-dark/80 px-2 py-2 backdrop-blur-sm">
      <span className="text-[10px] tabular-nums text-bambu-gray">{count}</span>
      <div className="flex min-h-0 flex-1 items-stretch gap-1">
        {ridge && (
          <svg className="w-3.5 text-bambu-green/35" viewBox={`0 0 100 ${ridge.n}`} preserveAspectRatio="none" aria-hidden data-testid="layer-ridge">
            <path d={ridge.d} fill="currentColor" />
          </svg>
        )}
        <div
          ref={track}
          className="relative w-6 cursor-pointer"
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.band) return;
            const layer = layerAt(e.clientY);
            if (Math.abs(layer - top) <= Math.abs(layer - bottom)) setTop(layer);
            else setBottom(layer);
          }}
        >
          <div className="absolute bottom-0 left-1/2 top-0 w-[3px] -translate-x-1/2 rounded bg-bambu-dark-tertiary" data-band="1" />
          <div className="absolute left-1/2 w-[3px] -translate-x-1/2 rounded bg-bambu-green" data-band="1" style={{ top: `${yOf(top)}%`, height: `${yOf(bottom) - yOf(top)}%` }} />
          <button type="button" {...handleProps('top')} style={{ top: `${yOf(top)}%` }} />
          <button type="button" {...handleProps('bottom')} style={{ top: `${yOf(bottom)}%` }} />
          <span className="pointer-events-none absolute right-full mr-2 -translate-y-1/2 whitespace-nowrap rounded border border-white/10 bg-bambu-dark/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white" style={{ top: `${yOf(top)}%` }}>
            {top + 1}
          </span>
          <span className="pointer-events-none absolute right-full mr-2 -translate-y-1/2 whitespace-nowrap rounded border border-white/10 bg-bambu-dark/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white"
            style={{ top: `${yOf(bottom)}%`, visibility: top - bottom < Math.max(4, count * 0.04) ? 'hidden' : 'visible' }}>
            {bottom + 1}
          </span>
        </div>
      </div>
      <span className="text-[10px] tabular-nums text-bambu-gray">1</span>
      <Tooltip content={t('partViewer.toolpath.play')} align="end">
        <button type="button" onClick={onTogglePlay} aria-label={t('partViewer.toolpath.play')} aria-pressed={playing}
          className={`flex h-8 w-8 items-center justify-center rounded-lg text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}>
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
      </Tooltip>
      {onSpeed && (
        <Tooltip content={t('partViewer.tools.speed')} align="end">
          <button type="button" onClick={() => onSpeed(SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length])} aria-label={t('partViewer.tools.speed')}
            className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`} data-testid="layer-speed">
            {`${speed}×`}
          </button>
        </Tooltip>
      )}
    </div>
  );
}
