import { describe, it, expect } from 'vitest';
import {
  applyDelete,
  applyDescription,
  applyInsert,
  applyQuoteStatus,
  applyTaskSummary,
  isPlaceholder,
  nextPlaceholderId,
} from '../../utils/aitoOptimistic';
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
});

describe('applyDescription', () => {
  it('replaces the description and nothing else', () => {
    const after = applyDescription([card({ id: 1, description: 'old' })], 1, 'new');
    expect(find(after, 1).description).toBe('new');
    expect(find(after, 1).column).toBe('devis');
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
});

describe('applyInsert', () => {
  it('appends to the end of its column', () => {
    const projects = [card({ id: 1, column: 'devis', position: 0 })];
    const after = applyInsert(projects, card({ id: -1, column: 'devis', position: 999 }));
    expect(find(after, -1).position).toBe(1);
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
