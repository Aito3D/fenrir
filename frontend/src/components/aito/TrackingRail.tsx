import { Check } from 'lucide-react';
import type { AitoColumnId } from '../../api/client';
import { FR, trackStages } from '../../utils/aitoTracking';

/** Read-only progress for the public page, two markups: the seven-stage
 *  row from `sm:` up, and "Étape n sur 7 — label" with a thin bar below
 *  it, because seven labels do not fit a phone. Done stages are secondary
 *  (dim disc, small muted label); only the current stage is loud. */
export function TrackingRail({ column, shipped }: { column: AitoColumnId; shipped: boolean }) {
  const stages = trackStages(shipped);
  const current = stages.findIndex((s) => s.id === column);
  return (
    <>
      {/* The rail is SEGMENTS between nodes, never a line through them: each
          column draws a left and a right 2 px segment that stop 18 px short
          of its centre (node radius 14 + 4 px of air). Nodes are opaque and
          above the segments, so a check is never crossed. */}
      <ol className="hidden grid-cols-7 sm:grid" aria-label="Étapes">
        {stages.map((stage, i) => {
          const state = i < current ? 'done' : i === current ? 'current' : 'todo';
          const segment = (on: boolean) => `absolute top-[15px] h-0.5 ${on ? 'bg-aito-cyan/55' : 'bg-aito-line'}`;
          return (
            <li
              key={stage.id}
              data-testid={`track-stage-${stage.id}`}
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              className={`relative flex flex-col items-center text-center leading-tight ${
                state === 'current' ? 'text-[12px] font-semibold text-aito-ink' : state === 'done' ? 'text-[11px] text-aito-muted/80' : 'text-[11px] text-aito-muted/70'
              }`}
            >
              {i > 0 && <span aria-hidden="true" className={`${segment(i <= current)} left-0 right-[calc(50%+18px)]`} />}
              {i < stages.length - 1 && <span aria-hidden="true" className={`${segment(i < current)} left-[calc(50%+18px)] right-0`} />}
              <span
                className={`relative z-10 flex items-center justify-center rounded-full ${
                  state === 'todo'
                    ? 'mb-2 mt-px h-7 w-7 border-2 border-aito-line bg-aito-card'
                    : state === 'done'
                      ? 'mb-2 mt-px h-7 w-7 bg-aito-cyan-dim text-white'
                      : 'mb-1.5 -mt-px h-8 w-8 bg-aito-cyan ring-[5px] ring-aito-cyan/15'
                }`}
              >
                {state === 'done' && <Check className="h-[11px] w-[11px]" strokeWidth={3} aria-hidden="true" />}
                {state === 'current' && <span className="h-[9px] w-[9px] rounded-full bg-white motion-safe:animate-pulse" aria-hidden="true" />}
              </span>
              {stage.label}
            </li>
          );
        })}
      </ol>
      <div className="sm:hidden" aria-label="Étapes">
        <div className="mb-2 flex justify-between text-sm">
          <span>{FR.stepOf(current + 1, stages.length)}</span>
          <b className="font-semibold">{stages[current]?.label}</b>
        </div>
        <div className="h-[3px] overflow-hidden rounded bg-aito-line">
          <span className="block h-full bg-aito-cyan" style={{ width: `${((current + 1) / stages.length) * 100}%` }} />
        </div>
      </div>
    </>
  );
}
