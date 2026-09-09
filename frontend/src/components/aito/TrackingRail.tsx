import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AitoColumnId } from '../../api/client';
import { TRACK_MOTION, trackNodeDelay, trackStages } from '../../utils/aitoTracking';
import { TrackCollapse } from './TrackCollapse';

type StageState = 'done' | 'current' | 'todo';

/** lucide's Check path, inlined so the stroke can carry pathLength="1" and
 *  draw itself (index.css `.animate-track-check`); lucide forwards extra
 *  props to the <svg>, never to the <path>. */
function CheckStroke({ size, draw, delay }: { size: number; draw: boolean; delay?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path
        d="M20 6 9 17l-5-5"
        pathLength={1}
        className={draw ? 'animate-track-check' : undefined}
        style={draw ? { animationDelay: `${delay ?? 0}ms` } : undefined}
        data-testid={draw ? 'track-check' : undefined}
      />
    </svg>
  );
}

/** One node's mark — opaque and drawn above any segment, so a check or the
 *  active dot is never crossed by the rail. Sizes are pixel-exact (28 / 32
 *  px) because this repo's root font-size (14.4 px) makes Tailwind's
 *  rem-based `h-7`/`h-8` render short of the spec's numbers.
 *
 *  `finished` is the current node of an order that is over: the disc stays
 *  cyan but carries a check instead of the "in progress" pulse. With
 *  `delay` set the mark plays its first-load entrance at that offset. */
function StageMark({ state, finished = false, delay }: { state: StageState; finished?: boolean; delay?: number }) {
  const animate = delay !== undefined;
  const at = (ms: number) => (animate ? { animationDelay: `${ms}ms` } : undefined);
  if (state === 'todo') {
    return <span className="h-[28px] w-[28px] rounded-full border-2 border-aito-line bg-aito-card" />;
  }
  // While a mark is still hidden through its delay, the empty ring it is
  // about to fill sits underneath — the track exists before progress does.
  const track = animate ? (
    <span className="absolute left-1/2 top-1/2 h-[28px] w-[28px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-aito-line" aria-hidden="true" />
  ) : null;
  if (state === 'done') {
    return (
      <span className="relative flex h-[28px] w-[28px] items-center justify-center">
        {track}
        <span className={`relative flex h-[28px] w-[28px] items-center justify-center rounded-full bg-aito-cyan-dim text-white ${animate ? 'animate-track-pop' : ''}`} style={at(delay ?? 0)}>
          <CheckStroke size={11} draw={false} />
        </span>
      </span>
    );
  }
  const landAt = (delay ?? 0) + TRACK_MOTION.land;
  return (
    <span className="relative flex h-[32px] w-[32px] items-center justify-center">
      {track}
      <span className={`absolute inset-[-5px] rounded-full bg-aito-cyan/14 ${animate ? 'animate-track-ring' : ''}`} style={at(landAt)} aria-hidden="true" />
      <span className={`relative flex h-[32px] w-[32px] items-center justify-center rounded-full bg-aito-cyan ${animate ? 'animate-track-land' : ''}`} style={at(landAt)}>
        {finished ? (
          <span className="text-white">
            <CheckStroke size={13} draw={animate} delay={landAt + 120} />
          </span>
        ) : (
          <span className="h-[9px] w-[9px] rounded-full bg-white motion-safe:animate-pulse" aria-hidden="true" />
        )}
      </span>
    </span>
  );
}

/** Read-only progress for the public page, two markups: the seven-stage
 *  row from `sm:` up, and "Étape n sur 7 — label" with a thin bar below
 *  it, because seven labels do not fit a phone. Done stages are secondary
 *  (dim disc, small muted label); only the current stage is loud. Below
 *  560 px, a "Voir les étapes" disclosure lists all seven stages
 *  vertically for anyone who wants the detail.
 *
 *  `animateFrom` plays the choreography from that node on: the cyan
 *  segments draw left → right one beat per node, each done mark pops behind
 *  the head of the draw, and the current node lands last. 0 on the first
 *  data is the whole walk; on a refetch that brought a later stage the page
 *  passes the node that WAS current, so only the new ground is walked —
 *  the client watching their order advance sees it advance, not restart.
 *  Undefined plays nothing. */
export function TrackingRail({ column, shipped, animateFrom }: { column: AitoColumnId; shipped: boolean; animateFrom?: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const stages = trackStages(shipped, t);
  const current = stages.findIndex((s) => s.id === column);
  const currentLabel = stages[current]?.label ?? '';
  const finished = column === 'done';
  const animate = animateFrom !== undefined;
  const origin = animateFrom ?? 0;
  const markDelay = (i: number) => (animate && i >= origin ? trackNodeDelay(i, origin) : undefined);
  return (
    <>
      {/* The rail is SEGMENTS between nodes, never a line through them: each
          column draws a left and a right 2 px segment that stop 18 px short
          of its centre (node radius 14 + 4 px of air). Nodes are opaque and
          above the segments, so a check is never crossed. */}
      <p className="sr-only">{`${t('aito.track.stepOf', { n: current + 1, total: stages.length })} : ${currentLabel}`}</p>
      <ol className="hidden grid-cols-7 sm:grid" aria-label={t('aito.track.stepsAria')}>
        {stages.map((stage, i) => {
          const state: StageState = i < current ? 'done' : i === current ? 'current' : 'todo';
          const segment = (on: boolean) => `absolute top-[15px] h-[2px] ${on ? 'bg-aito-cyan/55' : 'bg-aito-line'}`;
          // The two halves between node i-1 and node i fill node i's beat:
          // the right half of i-1 first, the left half of i second, so the
          // head of the draw reaches node i exactly as its mark pops. Ground
          // before the origin node is already drawn and stays still.
          const halfAt = (ms: number) => ({ animationDelay: `${ms}ms` });
          const leftOn = i <= current;
          const rightOn = i < current;
          const leftDraws = animate && leftOn && i > origin;
          const rightDraws = animate && rightOn && i >= origin;
          return (
            <li
              key={stage.id}
              data-testid={`track-stage-${stage.id}`}
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              className={`relative flex flex-col items-center px-[2px] text-center leading-tight text-[11px] hyphens-auto [overflow-wrap:anywhere] ${
                state === 'current'
                  ? 'text-[12px] font-semibold text-aito-ink'
                  : state === 'done'
                    ? 'text-aito-muted/80'
                    : 'text-aito-muted/70'
              }`}
            >
              {i > 0 && leftDraws && <span aria-hidden="true" className={`${segment(false)} left-0 right-[calc(50%+18px)]`} />}
              {i > 0 && (
                <span
                  aria-hidden="true"
                  className={`${segment(leftOn)} ${leftDraws ? 'animate-track-draw' : ''} left-0 right-[calc(50%+18px)]`}
                  style={leftDraws ? halfAt(trackNodeDelay(i, origin) - TRACK_MOTION.beat / 2) : undefined}
                />
              )}
              {i < stages.length - 1 && rightDraws && <span aria-hidden="true" className={`${segment(false)} left-[calc(50%+18px)] right-0`} />}
              {i < stages.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`${segment(rightOn)} ${rightDraws ? 'animate-track-draw' : ''} left-[calc(50%+18px)] right-0`}
                  style={rightDraws ? halfAt(trackNodeDelay(i, origin)) : undefined}
                />
              )}
              <span className={`relative z-10 flex items-center justify-center ${state === 'current' ? 'mb-[6px] -mt-px' : 'mb-[8px] mt-px'}`}>
                <StageMark state={state} finished={state === 'current' && finished} delay={state === 'todo' ? undefined : markDelay(i)} />
              </span>
              {stage.label}
            </li>
          );
        })}
      </ol>
      <div className="sm:hidden" aria-label={t('aito.track.stepsAria')}>
        <div className="mb-[8px] flex justify-between text-[13px]">
          <span>{t('aito.track.stepOf', { n: current + 1, total: stages.length })}</span>
          <b className="font-semibold">{currentLabel}</b>
        </div>
        {/* First load: the bar grows from nothing. Later: it slides to the
            new width (`.track-bar`, index.css) — an order advancing while
            the page is open is shown advancing, on the phone too. */}
        <div className="h-[3px] overflow-hidden rounded bg-aito-line">
          <span
            className={`track-bar block h-full bg-aito-cyan ${animate && origin === 0 ? 'animate-track-bar' : ''}`}
            style={{ width: `${((current + 1) / stages.length) * 100}%`, ...(animate && origin === 0 ? { animationDelay: `${TRACK_MOTION.start}ms` } : {}) }}
          />
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="mt-[8px] min-h-[44px] rounded-[8px] text-[13px] font-semibold text-aito-cyan transition-[color,transform] duration-150 hover:text-aito-cyan/80 active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aito-cyan"
        >
          {t(open ? 'aito.track.hideSteps' : 'aito.track.showSteps')}
        </button>
        <TrackCollapse open={open}>
          {/* -mx/px 6 px: the current mark's ring reaches 5 px past the
              node, and the collapse clips at its box. */}
          <ol aria-label={t('aito.track.stepsList')} className="stagger-children -mx-[6px] mt-[8px] space-y-[12px] px-[6px] pb-[6px]">
            {stages.map((stage, i) => {
              const state: StageState = i < current ? 'done' : i === current ? 'current' : 'todo';
              return (
                <li
                  key={stage.id}
                  aria-current={state === 'current' ? 'step' : undefined}
                  className={`${open ? 'animate-rise' : ''} flex items-center gap-[12px] text-[13px] ${
                    state === 'current'
                      ? 'font-semibold text-aito-ink'
                      : state === 'done'
                        ? 'text-aito-muted/80'
                        : 'text-aito-muted/70'
                  }`}
                >
                  <StageMark state={state} finished={state === 'current' && finished} />
                  {stage.label}
                </li>
              );
            })}
          </ol>
        </TrackCollapse>
      </div>
    </>
  );
}
