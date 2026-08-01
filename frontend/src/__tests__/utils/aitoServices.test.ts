import { describe, it, expect } from 'vitest';
import { stagesWithWork } from '../../components/aito/services';
import type { TaskDraft } from '../../utils/taskDraft';

/** A task carrying only the fields the rules read. `done` must list every
 *  service — the rule engine indexes it by ServiceId, not by presence. */
function task(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    id: null,
    uid: 'u1',
    title: '',
    description: '',
    scanCost: null,
    modelisationCost: null,
    impressionCost: null,
    usinageCost: null,
    done: { scan: false, modelisation: false, impression: false, usinage: false },
    ...overrides,
  } as TaskDraft;
}

describe('stagesWithWork', () => {
  it('omits a stage no task carries work for', () => {
    const result = stagesWithWork([task({ scanCost: 3500 })]);
    expect(result.map((s) => s.column)).toEqual(['scan']);
  });

  it('keeps board order regardless of which stages are present', () => {
    const result = stagesWithWork([task({ impressionCost: 100, scanCost: 200 })]);
    expect(result.map((s) => s.column)).toEqual(['scan', 'print']);
  });

  it('folds impression and usinage into the single print column', () => {
    const result = stagesWithWork([
      task({ impressionCost: 6000, usinageCost: 4000, done: { scan: false, modelisation: false, impression: true, usinage: false } }),
    ]);
    expect(result).toEqual([
      { column: 'print', stepsDone: 1, stepsTotal: 2, value: 10000, valueDone: 6000 },
    ]);
  });

  it('sums the same stage across several tasks', () => {
    const result = stagesWithWork([
      task({ uid: 'a', scanCost: 3500, done: { scan: true, modelisation: false, impression: false, usinage: false } }),
      task({ uid: 'b', scanCost: 1500 }),
    ]);
    expect(result).toEqual([
      { column: 'scan', stepsDone: 1, stepsTotal: 2, value: 5000, valueDone: 3500 },
    ]);
  });

  it('counts a step quoted free as a real step, not an absent one', () => {
    const result = stagesWithWork([task({ scanCost: 0 })]);
    expect(result).toEqual([
      { column: 'scan', stepsDone: 0, stepsTotal: 1, value: 0, valueDone: 0 },
    ]);
  });

  it('returns nothing for a project with no priced steps', () => {
    expect(stagesWithWork([task()])).toEqual([]);
  });
});
