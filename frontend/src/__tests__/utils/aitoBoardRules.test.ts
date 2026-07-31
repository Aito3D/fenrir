import { describe, it, expect } from 'vitest';
import cases from '../fixtures/aitoBoardRules.cases.json';
import { evaluate, summariseTasks, SERVICES, STAGES } from '../../utils/aitoBoardRules';
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
  tasks: Record<string, number | boolean | null>[];
  count: number;
  total: number;
  services: string[];
  pending: string[];
  steps_total: number;
  steps_done: number;
  steps_by_task: { services: string[]; done: string[] }[];
}

const SERVICE_IDS: ServiceId[] = ['scan', 'modelisation', 'impression', 'usinage'];

/** The fixture's wire shape -> the client shape the mirror consumes. */
function toTaskLike(row: Record<string, number | boolean | null>): TaskLike {
  return {
    scanCost: row.scan_cost as number | null,
    modelisationCost: row.modelisation_cost as number | null,
    impressionCost: row.impression_cost as number | null,
    usinageCost: row.usinage_cost as number | null,
    done: {
      scan: row.scan_done === true,
      modelisation: row.modelisation_done === true,
      impression: row.impression_done === true,
      usinage: row.usinage_done === true,
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
    expect(summariseCases).toHaveLength(9);
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
