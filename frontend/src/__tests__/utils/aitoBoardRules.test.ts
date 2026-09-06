import { describe, it, expect } from 'vitest';
import cases from '../fixtures/aitoBoardRules.cases.json';
import { evaluate, summariseTasks, netCost, SERVICES, STAGES } from '../../utils/aitoBoardRules';
import type { ServiceId, TaskLike } from '../../utils/aitoBoardRules';
import type { AitoColumnId } from '../../api/client';

interface EvaluateCase {
  quote_status: string | null;
  stored_column: string;
  pending: string[];
  column: string;
  move_lock: string | null;
}

interface SummariseCase {
  name: string;
  tasks: Record<string, number | boolean | string | null>[];
  count: number;
  total: number;
  services: string[];
  pending: string[];
  steps_total: number;
  steps_done: number;
  steps_by_task: { services: string[]; done: string[]; title: string; rush: boolean }[];
  print_minutes_pending: number;
}

const SERVICE_IDS: ServiceId[] = ['scan', 'modelisation', 'impression', 'usinage'];

/** The fixture's wire shape -> the client shape the mirror consumes. */
function toTaskLike(row: Record<string, number | boolean | string | null>): TaskLike {
  return {
    scanCost: row.scan_cost as number | null,
    modelisationCost: row.modelisation_cost as number | null,
    impressionCost: row.impression_cost as number | null,
    usinageCost: row.usinage_cost as number | null,
    scanDiscountPct: (row.scan_discount_pct as number | null | undefined) ?? null,
    modelisationDiscountPct: (row.modelisation_discount_pct as number | null | undefined) ?? null,
    impressionDiscountPct: (row.impression_discount_pct as number | null | undefined) ?? null,
    usinageDiscountPct: (row.usinage_discount_pct as number | null | undefined) ?? null,
    done: {
      scan: row.scan_done === true,
      modelisation: row.modelisation_done === true,
      impression: row.impression_done === true,
      usinage: row.usinage_done === true,
    },
    title: row.title as string,
    // The wire keeps rush flat (`impression_rush`) because that is how it
    // sits on an AitoTask row; the mirror reads it off the nested impression
    // draft, which is how it sits on a TaskDraft. This is the one place the
    // two shapes meet.
    impression: {
      rush: row.impression_rush === true,
      timeMin: (row.impression_time_min as number | null | undefined) ?? null,
      quantity: (row.impression_quantity as number | null | undefined) ?? undefined,
    },
  };
}

describe('the board-rules contract', () => {
  const evaluateCases = cases.evaluate as EvaluateCase[];
  const summariseCases = cases.summarise as SummariseCase[];

  it('has the full evaluate product loaded', () => {
    // Guards against an empty or truncated fixture quietly passing the loop
    // below by iterating zero times.
    expect(evaluateCases).toHaveLength(8 * 7 * 16);
    expect(summariseCases).toHaveLength(16);
  });

  it('stages every service exactly once', () => {
    // STAGES can't be tied to SERVICES by the type system the way ServiceId
    // is tied to COST_KEYS (a `Record<ServiceId, ...>`), so a service dropped
    // from — or duplicated across — a stage would compile fine and only show
    // up here.
    const staged = STAGES.flatMap(([, services]) => services);
    for (const service of SERVICES) {
      expect(staged.filter((s) => s === service)).toHaveLength(1);
    }
    expect(staged).toHaveLength(SERVICES.length);
  });

  it('reproduces every evaluate case', () => {
    const mismatches = evaluateCases.filter((c) => {
      const [column, lock] = evaluate(c.quote_status, c.stored_column as AitoColumnId, c.pending);
      return column !== c.column || lock !== c.move_lock;
    });
    // Report the case itself, not just a count — a bare "expected 3 to be 0"
    // says nothing about which rule drifted.
    expect(mismatches).toEqual([]);
  });

  it.each(SERVICE_IDS)('treats %s consistently in both directions', (service) => {
    // A priced service is pending until ticked; an unpriced one never is.
    const priced = { ...blank(), [`${service}Cost`]: 0 } as unknown as TaskLike;
    expect(summariseTasks([priced]).pending).toContain(service);
    expect(summariseTasks([blank()]).pending).not.toContain(service);
  });

  it.each(
    (cases.summarise as SummariseCase[]).map((c) => [c.name, c] as const),
  )('reproduces summarise: %s', (_name, c) => {
    const summary = summariseTasks(c.tasks.map(toTaskLike));
    expect(summary.count).toBe(c.count);
    expect(summary.total).toBeCloseTo(c.total, 10);
    expect(summary.services).toEqual(c.services);
    expect(summary.pending).toEqual(c.pending);
    expect(summary.stepsTotal).toBe(c.steps_total);
    expect(summary.stepsDone).toBe(c.steps_done);
    expect(summary.stepsByTask).toEqual(c.steps_by_task);
    expect(summary.printMinutesPending).toBe(c.print_minutes_pending);
  });
});

function blank(): TaskLike {
  return {
    scanCost: null,
    modelisationCost: null,
    impressionCost: null,
    usinageCost: null,
    done: { scan: false, modelisation: false, impression: false, usinage: false },
  };
}

const bare = (over: Partial<TaskLike> = {}): TaskLike => ({
  scanCost: null,
  modelisationCost: null,
  impressionCost: null,
  usinageCost: null,
  done: { scan: false, modelisation: false, impression: false, usinage: false },
  ...over,
});

describe('the rush flag on a task row', () => {
  // The mirror is what the panel's optimistic writes rebuild `task_steps`
  // from (projectOntoBoard in hooks/useProjectTasks.ts, placeholderProject in
  // utils/aitoOptimistic.ts). Dropping rush here meant ticking Rush showed no
  // bolt on the card until the close-time refetch, and editing any other
  // field wiped the bolts a refetch had put there.
  it('marks a rushed print step', () => {
    const summary = summariseTasks([bare({ impressionCost: 1250, impression: { rush: true } })]);
    expect(summary.stepsByTask[0].rush).toBe(true);
  });

  it('marks nothing when the rushed task has no print step', () => {
    const summary = summariseTasks([bare({ scanCost: 500, impression: { rush: true } })]);
    expect(summary.stepsByTask[0].rush).toBe(false);
  });

  it('is false for a task that says nothing about rush', () => {
    expect(summariseTasks([bare({ impressionCost: 1250 })]).stepsByTask[0].rush).toBe(false);
  });
});

describe('printMinutesPending', () => {
  it('owes minutes x quantity for an unticked print step', () => {
    const summary = summariseTasks([
      bare({ impressionCost: 100, impression: { rush: false, timeMin: 90, quantity: 2 } }),
    ]);
    expect(summary.printMinutesPending).toBe(180);
  });

  it('owes nothing once the print step is ticked', () => {
    const summary = summariseTasks([
      bare({
        impressionCost: 100,
        impression: { rush: false, timeMin: 90, quantity: 2 },
        done: { scan: false, modelisation: false, impression: true, usinage: false },
      }),
    ]);
    expect(summary.printMinutesPending).toBe(0);
  });
});

describe('netCost', () => {
  it('is null for an absent service', () => {
    expect(netCost(bare(), 'usinage')).toBeNull();
  });

  it('keeps a free step at zero rather than reading it as absent', () => {
    expect(netCost(bare({ usinageCost: 0 }), 'usinage')).toBe(0);
  });

  it('passes an undiscounted cost through', () => {
    expect(netCost(bare({ usinageCost: 1000 }), 'usinage')).toBe(1000);
  });

  it("applies the service's own discount", () => {
    expect(netCost(bare({ usinageCost: 1000, usinageDiscountPct: 10 }), 'usinage')).toBe(900);
  });

  it('reads each service independently', () => {
    const task = bare({
      scanCost: 100,
      scanDiscountPct: 50,
      usinageCost: 100,
      usinageDiscountPct: 25,
      impressionCost: 100,
    });
    expect(netCost(task, 'scan')).toBe(50);
    expect(netCost(task, 'usinage')).toBe(75);
    expect(netCost(task, 'impression')).toBe(100);
  });
});
