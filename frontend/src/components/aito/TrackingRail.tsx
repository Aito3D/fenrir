import { useState } from 'react';
import { Check } from 'lucide-react';
import type { AitoColumnId } from '../../api/client';
import { FR, trackStages } from '../../utils/aitoTracking';

type StageState = 'done' | 'current' | 'todo';

/** One node's mark — opaque and drawn above any segment, so a check or the
 *  active dot is never crossed by the rail. Sizes are pixel-exact (28 / 32
 *  px) because this repo's root font-size (14.4 px) makes Tailwind's
 *  rem-based `h-7`/`h-8` render short of the spec's numbers. */
function StageMark({ state }: { state: StageState }) {
  if (state === 'todo') {
    return <span className="h-[28px] w-[28px] rounded-full border-2 border-aito-line bg-aito-card" />;
  }
  if (state === 'done') {
    return (
      <span className="flex h-[28px] w-[28px] items-center justify-center rounded-full bg-aito-cyan-dim text-white">
        <Check className="h-[11px] w-[11px]" strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="flex h-[32px] w-[32px] items-center justify-center rounded-full bg-aito-cyan ring-[5px] ring-aito-cyan/14">
      <span className="h-[9px] w-[9px] rounded-full bg-white motion-safe:animate-pulse" aria-hidden="true" />
    </span>
  );
}

/** Read-only progress for the public page, two markups: the seven-stage
 *  row from `sm:` up, and "Étape n sur 7 — label" with a thin bar below
 *  it, because seven labels do not fit a phone. Done stages are secondary
 *  (dim disc, small muted label); only the current stage is loud. Below
 *  560 px, a "Voir les étapes" disclosure lists all seven stages
 *  vertically for anyone who wants the detail. */
export function TrackingRail({ column, shipped }: { column: AitoColumnId; shipped: boolean }) {
  const [open, setOpen] = useState(false);
  const stages = trackStages(shipped);
  const current = stages.findIndex((s) => s.id === column);
  const currentLabel = stages[current]?.label ?? '';
  return (
    <>
      {/* The rail is SEGMENTS between nodes, never a line through them: each
          column draws a left and a right 2 px segment that stop 18 px short
          of its centre (node radius 14 + 4 px of air). Nodes are opaque and
          above the segments, so a check is never crossed. */}
      <p className="sr-only">{`${FR.stepOf(current + 1, stages.length)} : ${currentLabel}`}</p>
      <ol className="hidden grid-cols-7 sm:grid" aria-label="Étapes">
        {stages.map((stage, i) => {
          const state: StageState = i < current ? 'done' : i === current ? 'current' : 'todo';
          const segment = (on: boolean) => `absolute top-[15px] h-0.5 ${on ? 'bg-aito-cyan/55' : 'bg-aito-line'}`;
          return (
            <li
              key={stage.id}
              data-testid={`track-stage-${stage.id}`}
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              className={`relative flex flex-col items-center text-center leading-tight text-[11px] ${
                state === 'current' ? 'text-[12px] font-semibold text-aito-ink' : 'text-aito-muted/80'
              }`}
            >
              {i > 0 && <span aria-hidden="true" className={`${segment(i <= current)} left-0 right-[calc(50%+18px)]`} />}
              {i < stages.length - 1 && <span aria-hidden="true" className={`${segment(i < current)} left-[calc(50%+18px)] right-0`} />}
              <span className={`relative z-10 flex items-center justify-center ${state === 'current' ? 'mb-[6px] -mt-px' : 'mb-[8px] mt-px'}`}>
                <StageMark state={state} />
              </span>
              {stage.label}
            </li>
          );
        })}
      </ol>
      <div className="sm:hidden" aria-label="Étapes">
        <div className="mb-[8px] flex justify-between text-[13px]">
          <span>{FR.stepOf(current + 1, stages.length)}</span>
          <b className="font-semibold">{currentLabel}</b>
        </div>
        <div className="h-[3px] overflow-hidden rounded bg-aito-line">
          <span className="block h-full bg-aito-cyan" style={{ width: `${((current + 1) / stages.length) * 100}%` }} />
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="mt-[8px] min-h-[44px] rounded-[8px] text-[13px] font-semibold text-aito-cyan transition-colors duration-150 hover:text-aito-cyan/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aito-cyan"
        >
          {FR.showSteps}
        </button>
        {open && (
          <ol aria-label={FR.stepsList} className="mt-[8px] space-y-[12px]">
            {stages.map((stage, i) => {
              const state: StageState = i < current ? 'done' : i === current ? 'current' : 'todo';
              return (
                <li
                  key={stage.id}
                  aria-current={state === 'current' ? 'step' : undefined}
                  className={`flex items-center gap-[12px] text-[13px] ${
                    state === 'current' ? 'font-semibold text-aito-ink' : 'text-aito-muted/80'
                  }`}
                >
                  <StageMark state={state} />
                  {stage.label}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </>
  );
}
