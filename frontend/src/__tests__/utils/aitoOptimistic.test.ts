import { describe, it, expect } from 'vitest';
import {
  applyCreate,
  applyDelete,
  applyDescription,
  applyRestore,
  applyQuoteStatus,
  applySyncState,
  applyTaskSummary,
  isPlaceholder,
  nextPlaceholderId,
} from '../../utils/aitoOptimistic';
import type { TaskSummary } from '../../utils/aitoBoardRules';
import type { AitoProject } from '../../api/client';

const card = (over: Partial<AitoProject> = {}): AitoProject => ({
  id: 1,
  description: 'card',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: null,
  client_name: null,
  client_phone: null,
  client_email: null,
  client_is_company: null,
  quote_id: null,
  quote_number: null,
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
  quote_sync_state: 'idle',
  quote_sync_error: null,
  quote_status_block: null,
  quote_status_remote: null,
  created_by: null,
  task_count: 0,
  tasks_total: 0,
  task_services: [],
  task_pending: [],
  steps_total: 0,
  steps_done: 0,
  move_lock: 'quote',
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
  ...over,
});

const find = (projects: AitoProject[], id: number) => projects.find((p) => p.id === id)!;

describe('applyQuoteStatus', () => {
  it('relocates an accepted card to its first pending stage', () => {
    const projects = [
      card({ id: 1, column: 'devis', position: 0, task_services: ['impression'], task_pending: ['impression'] }),
    ];
    const after = applyQuoteStatus(projects, 1, 'accepted');
    expect(find(after, 1).column).toBe('print');
    expect(find(after, 1).quote_status).toBe('accepted');
    expect(find(after, 1).move_lock).toBe('steps');
  });

  it('reads task_pending, not task_services', () => {
    // Scan is enabled but already done; only the printing is outstanding. A
    // transform keying off task_services would wrongly land this in Scan.
    const projects = [
      card({
        id: 1,
        column: 'devis',
        task_services: ['scan', 'impression'],
        task_pending: ['impression'],
        steps_total: 2,
        steps_done: 1,
      }),
    ];
    expect(find(applyQuoteStatus(projects, 1, 'accepted'), 1).column).toBe('print');
  });

  it('sends a declined card to done', () => {
    const after = applyQuoteStatus([card({ id: 1 })], 1, 'declined');
    expect(find(after, 1).column).toBe('done');
    expect(find(after, 1).move_lock).toBe('declined');
  });

  it('appends to the END of the destination column', () => {
    const projects = [
      card({ id: 1, column: 'devis', position: 0 }),
      card({ id: 2, column: 'waiting', position: 0 }),
      card({ id: 3, column: 'waiting', position: 1 }),
    ];
    const after = applyQuoteStatus(projects, 1, 'sent');
    expect(find(after, 1).column).toBe('waiting');
    expect(find(after, 1).position).toBe(2);
  });

  it('renumbers the source column contiguously', () => {
    const projects = [
      card({ id: 1, column: 'devis', position: 0 }),
      card({ id: 2, column: 'devis', position: 1 }),
      card({ id: 3, column: 'devis', position: 2 }),
    ];
    const after = applyQuoteStatus(projects, 2, 'sent');
    expect(find(after, 1).position).toBe(0);
    expect(find(after, 3).position).toBe(1);
  });

  it('does not renumber when the column does not change', () => {
    // draft -> sent moves; null -> draft would not. Use a card already in
    // waiting being re-marked sent.
    const projects = [
      card({ id: 1, column: 'waiting', position: 0, quote_status: 'viewed' }),
      card({ id: 2, column: 'waiting', position: 1, quote_status: 'sent' }),
    ];
    const after = applyQuoteStatus(projects, 1, 'sent');
    expect(find(after, 1).position).toBe(0);
    expect(find(after, 2).position).toBe(1);
  });

  it('leaves other projects untouched', () => {
    const projects = [card({ id: 1 }), card({ id: 2, column: 'print', position: 0 })];
    const after = applyQuoteStatus(projects, 1, 'sent');
    expect(find(after, 2)).toEqual(find(projects, 2));
  });

  it('is a no-op for an unknown id', () => {
    const projects = [card({ id: 1 })];
    expect(applyQuoteStatus(projects, 99, 'sent')).toEqual(projects);
  });

  it('returns an empty array for undefined input', () => {
    expect(applyQuoteStatus(undefined, 1, 'sent')).toEqual([]);
  });

  it('renumbers a column that leaves array order by POSITION, not array order', () => {
    // Regression for the bug where the source column was renumbered by
    // walking the array instead of ranking by `position` (ties on `id`), the
    // way the server's `_active_in_column` does with `ORDER BY position, id`.
    //
    // Start, array order matching position order (as the server would return
    // it): S1(scan,0), W1(waiting,0), W2(waiting,1).
    const start = [
      card({ id: 1, column: 'scan', position: 0, quote_status: 'draft' }),
      card({ id: 2, column: 'waiting', position: 0, quote_status: 'sent' }),
      card({ id: 3, column: 'waiting', position: 1, quote_status: 'sent' }),
    ];

    // Move 1: S1 into waiting. It correctly gets position 2, appended to the
    // end. Array order is untouched, so the waiting column's array order (S1
    // last) no longer matches its position order (S1 is highest, W1 is
    // lowest) — array order and position order have now diverged.
    const afterMove1 = applyQuoteStatus(start, 1, 'sent');
    expect(find(afterMove1, 1)).toMatchObject({ column: 'waiting', position: 2 });
    expect(find(afterMove1, 2)).toMatchObject({ column: 'waiting', position: 0 });
    expect(find(afterMove1, 3)).toMatchObject({ column: 'waiting', position: 1 });

    // Move 2: W1 (id 2) leaves waiting. The server renumbers the remainder by
    // `ORDER BY position, id`: W2 (position 1) comes before S1 (position 2),
    // so W2 -> 0, S1 -> 1. Renumbering by array traversal instead would visit
    // S1 before W2 (array order is [S1, W1, W2]) and wrongly produce S1 -> 0,
    // W2 -> 1 — S1 jumping from last to first.
    const afterMove2 = applyQuoteStatus(afterMove1, 2, 'draft');
    expect(find(afterMove2, 2).column).toBe('devis');
    expect(find(afterMove2, 3).position).toBe(0); // W2
    expect(find(afterMove2, 1).position).toBe(1); // S1
  });
});

describe('applyTaskSummary', () => {
  it('writes the counters and relocates on the new pending set', () => {
    const projects = [
      card({ id: 1, column: 'scan', position: 0, quote_status: 'accepted', move_lock: 'steps' }),
    ];
    const after = applyTaskSummary(projects, 1, {
      count: 2,
      total: 150,
      services: ['scan', 'impression'],
      pending: ['impression'],
      stepsTotal: 4,
      stepsDone: 3,
    });
    const updated = find(after, 1);
    expect(updated.task_count).toBe(2);
    expect(updated.tasks_total).toBe(150);
    expect(updated.task_services).toEqual(['scan', 'impression']);
    expect(updated.steps_total).toBe(4);
    expect(updated.steps_done).toBe(3);
    expect(updated.column).toBe('print');
  });

  it('sends a fully ticked accepted project to finish', () => {
    const projects = [card({ id: 1, column: 'print', quote_status: 'accepted' })];
    const after = applyTaskSummary(projects, 1, {
      count: 1,
      total: 10,
      services: ['impression'],
      pending: [],
      stepsTotal: 1,
      stepsDone: 1,
    });
    expect(find(after, 1).column).toBe('finish');
    expect(find(after, 1).move_lock).toBeNull();
  });

  it('does not move an unaccepted project however many steps are ticked', () => {
    const projects = [card({ id: 1, column: 'devis', quote_status: 'draft' })];
    const after = applyTaskSummary(projects, 1, {
      count: 1,
      total: 10,
      services: ['scan'],
      pending: [],
      stepsTotal: 1,
      stepsDone: 1,
    });
    expect(find(after, 1).column).toBe('devis');
  });

  it('is a no-op for an unknown id', () => {
    const projects = [card({ id: 1 })];
    const summary: TaskSummary = { count: 1, total: 10, services: ['scan'], pending: [], stepsTotal: 1, stepsDone: 1 };
    expect(applyTaskSummary(projects, 99, summary)).toEqual(projects);
  });

  it('returns an empty array for undefined input', () => {
    const summary: TaskSummary = { count: 1, total: 10, services: ['scan'], pending: [], stepsTotal: 1, stepsDone: 1 };
    expect(applyTaskSummary(undefined, 1, summary)).toEqual([]);
  });
});

describe('applyDescription', () => {
  it('replaces the description and nothing else', () => {
    const after = applyDescription([card({ id: 1, description: 'old' })], 1, 'new');
    expect(find(after, 1).description).toBe('new');
    expect(find(after, 1).column).toBe('devis');
  });

  it('is a no-op for an unknown id', () => {
    const projects = [card({ id: 1 })];
    expect(applyDescription(projects, 99, 'new')).toEqual(projects);
  });

  it('returns an empty array for undefined input', () => {
    expect(applyDescription(undefined, 1, 'new')).toEqual([]);
  });
});

describe('applySyncState', () => {
  it('replaces quote_sync_state and nothing else', () => {
    const after = applySyncState([card({ id: 1, quote_sync_state: 'idle' })], 1, 'pending');
    expect(find(after, 1).quote_sync_state).toBe('pending');
    expect(find(after, 1).column).toBe('devis');
  });

  it('leaves other projects untouched', () => {
    const projects = [card({ id: 1, quote_sync_state: 'idle' }), card({ id: 2, quote_sync_state: 'error' })];
    const after = applySyncState(projects, 1, 'synced');
    expect(find(after, 2)).toEqual(find(projects, 2));
  });

  it('is a no-op for an unknown id', () => {
    const projects = [card({ id: 1, quote_sync_state: 'idle' })];
    expect(applySyncState(projects, 99, 'error')).toEqual(projects);
  });

  it('returns an empty array for undefined input', () => {
    expect(applySyncState(undefined, 1, 'error')).toEqual([]);
  });
});

describe('applyDelete', () => {
  it('removes the card and renumbers its column', () => {
    const projects = [
      card({ id: 1, column: 'devis', position: 0 }),
      card({ id: 2, column: 'devis', position: 1 }),
      card({ id: 3, column: 'devis', position: 2 }),
    ];
    const after = applyDelete(projects, 2);
    expect(after.map((p) => p.id)).toEqual([1, 3]);
    expect(find(after, 3).position).toBe(1);
  });

  it('leaves other columns alone', () => {
    const projects = [
      card({ id: 1, column: 'devis', position: 0 }),
      card({ id: 2, column: 'print', position: 5 }),
    ];
    expect(find(applyDelete(projects, 1), 2).position).toBe(5);
  });

  it('is a no-op for an unknown id', () => {
    const projects = [card({ id: 1 })];
    expect(applyDelete(projects, 99)).toEqual(projects);
  });

  it('returns an empty array for undefined input', () => {
    expect(applyDelete(undefined, 1)).toEqual([]);
  });
});

describe('applyCreate', () => {
  it('prepends a placeholder when Devis is empty', () => {
    const after = applyCreate([], card({ id: -1, column: 'devis', position: 999 }));
    expect(after).toHaveLength(1);
    expect(find(after, -1)).toMatchObject({ column: 'devis', position: 0 });
  });

  it('prepends and shifts every existing Devis card down', () => {
    const projects = [
      card({ id: 1, column: 'devis', position: 0 }),
      card({ id: 2, column: 'devis', position: 1 }),
    ];
    const after = applyCreate(projects, card({ id: -1, column: 'devis', position: 999 }));
    expect(find(after, -1).position).toBe(0);
    expect(find(after, 1).position).toBe(1);
    expect(find(after, 2).position).toBe(2);
  });

  it('does not disturb other columns', () => {
    const projects = [
      card({ id: 1, column: 'devis', position: 0 }),
      card({ id: 2, column: 'print', position: 3 }),
    ];
    const after = applyCreate(projects, card({ id: -1, column: 'devis', position: 999 }));
    expect(find(after, 2)).toEqual(find(projects, 2));
  });

  it('forces the placeholder into Devis regardless of the column it was given', () => {
    const after = applyCreate([], card({ id: -1, column: 'print', position: 999 }));
    expect(find(after, -1).column).toBe('devis');
  });

  it('returns just the placeholder for undefined input', () => {
    const after = applyCreate(undefined, card({ id: -1, column: 'devis', position: 999 }));
    expect(after).toHaveLength(1);
    expect(find(after, -1).position).toBe(0);
  });
});

describe('applyRestore', () => {
  it('appends to the end of its own column', () => {
    const projects = [card({ id: 1, column: 'devis', position: 0 })];
    const after = applyRestore(projects, card({ id: -1, column: 'devis', position: 999 }));
    expect(find(after, -1).position).toBe(1);
  });

  it('does not disturb other columns', () => {
    const projects = [
      card({ id: 1, column: 'devis', position: 0 }),
      card({ id: 2, column: 'print', position: 3 }),
    ];
    const after = applyRestore(projects, card({ id: -1, column: 'devis', position: 999 }));
    expect(find(after, 2)).toEqual(find(projects, 2));
  });

  it('returns just the restored card for undefined input', () => {
    const after = applyRestore(undefined, card({ id: -1, column: 'finish', position: 999 }));
    expect(after).toHaveLength(1);
    expect(find(after, -1).position).toBe(0);
  });
});

describe('placeholder identity', () => {
  it('hands out distinct negative ids', () => {
    const a = nextPlaceholderId();
    const b = nextPlaceholderId();
    expect(a).toBeLessThan(0);
    expect(b).toBeLessThan(0);
    expect(a).not.toBe(b);
  });

  it('recognises a placeholder and a real row', () => {
    expect(isPlaceholder(card({ id: -1 }))).toBe(true);
    expect(isPlaceholder(card({ id: 42 }))).toBe(false);
  });
});
