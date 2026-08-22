import { describe, it, expect } from 'vitest';
import {
  applyCrossColumnMove,
  buildBoard,
  computeMoveTarget,
  emptyBoard,
  findColumn,
  flagRank,
  toOptimisticProjects,
} from '../../utils/aitoBoard';
import type { AitoFlag, AitoProject } from '../../api/client';

const card = (id: number, column: AitoProject['column'], position: number): AitoProject => ({
  id,
  description: `card ${id}`,
  column,
  position,
  status: 'active',
  client_id: null,
  client_name: null,
  client_phone: null,
  client_email: null,
  client_is_company: null,
  client_social_network: null,
  client_social_handle: null,
  quote_id: null,
  quote_number: null,
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
  quote_accepted_at: null,
  quote_sync_state: 'idle',
  quote_invoiced: false,
  flag: null,
  client_contacted_at: null,
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
  task_steps: [],
  move_lock: null,
  shipping_island: null,
  shipping_service: null,
  shipping_first_name: null,
  shipping_last_name: null,
  shipping_phone: null,
  shipping_price: null,
  shipping_service_name: null,
  version: 1,
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
});

describe('buildBoard', () => {
  it('groups by column and sorts by position', () => {
    const board = buildBoard([card(3, 'devis', 1), card(1, 'devis', 0), card(9, 'print', 0)]);
    expect(board.devis.map((p) => p.id)).toEqual([1, 3]);
    expect(board.print.map((p) => p.id)).toEqual([9]);
    expect(board.model).toEqual([]);
  });

  it('drops projects whose column is not a known board column', () => {
    const rogue = { ...card(5, 'devis', 0), column: 'archive' as AitoProject['column'] };
    const board = buildBoard([rogue, card(1, 'devis', 0)]);
    expect(board.devis.map((p) => p.id)).toEqual([1]);
  });

  it('sorts flagged cards to the top of their column, keeping position order inside each group', () => {
    const makeProject = (id: number, column: AitoProject['column'], position: number, flag: AitoFlag | null) =>
      ({ id, column, position, flag }) as unknown as AitoProject;

    const board = buildBoard([
      makeProject(1, 'devis', 0, null),
      makeProject(2, 'devis', 1, 'urgent'),
      makeProject(3, 'devis', 2, 'sav'),
      makeProject(4, 'devis', 3, null),
    ]);
    // Both flags rank equally — they are peers, so position breaks the tie.
    expect(board.devis.map((p) => p.id)).toEqual([2, 3, 1, 4]);
  });

  it('sinks paused cards below unflagged ones, keeping position order inside each tier', () => {
    const makeProject = (id: number, column: AitoProject['column'], position: number, flag: AitoFlag | null) =>
      ({ id, column, position, flag }) as unknown as AitoProject;

    const board = buildBoard([
      makeProject(1, 'devis', 0, null),
      makeProject(2, 'devis', 1, 'pause'),
      makeProject(3, 'devis', 2, null),
      makeProject(4, 'devis', 3, 'urgent'),
      makeProject(5, 'devis', 4, 'sav'),
    ]);

    // Attention flags (peers, position breaking their tie), then unflagged,
    // then paused last.
    expect(board.devis.map((p) => p.id)).toEqual([4, 5, 1, 3, 2]);
  });

  it('ranks urgent and sav equally and pause below unflagged', () => {
    expect(flagRank('urgent')).toBe(flagRank('sav'));
    expect(flagRank('urgent')).toBeLessThan(flagRank(null));
    expect(flagRank(null)).toBeLessThan(flagRank('pause'));
  });
});

describe('findColumn', () => {
  it('resolves a column id to itself', () => {
    expect(findColumn(emptyBoard(), 'print')).toBe('print');
  });

  it('resolves a card id to the column holding it', () => {
    const board = buildBoard([card(7, 'model', 0)]);
    expect(findColumn(board, 7)).toBe('model');
  });

  it('returns undefined for an unknown id', () => {
    expect(findColumn(emptyBoard(), 999)).toBeUndefined();
  });
});

describe('applyCrossColumnMove', () => {
  it('inserts the card at the hovered card index', () => {
    const board = buildBoard([card(1, 'devis', 0), card(2, 'print', 0), card(3, 'print', 1)]);
    const next = applyCrossColumnMove(board, 1, 3);
    expect(next.devis.map((p) => p.id)).toEqual([]);
    expect(next.print.map((p) => p.id)).toEqual([2, 1, 3]);
  });

  it('appends when hovering the column itself rather than a card', () => {
    const board = buildBoard([card(1, 'devis', 0), card(2, 'print', 0)]);
    const next = applyCrossColumnMove(board, 1, 'print');
    expect(next.print.map((p) => p.id)).toEqual([2, 1]);
  });

  it('returns the same board reference when the move is within one column', () => {
    const board = buildBoard([card(1, 'devis', 0), card(2, 'devis', 1)]);
    expect(applyCrossColumnMove(board, 1, 2)).toBe(board);
  });
});

describe('computeMoveTarget', () => {
  it('reports a no-op when a card is released in its own slot', () => {
    const board = buildBoard([card(1, 'devis', 0), card(2, 'devis', 1)]);
    expect(computeMoveTarget(board, 1, 1, 'devis')).toEqual({ kind: 'noop' });
  });

  it('reorders within a column and reports the new position', () => {
    const board = buildBoard([card(1, 'devis', 0), card(2, 'devis', 1), card(3, 'devis', 2)]);
    const result = computeMoveTarget(board, 1, 3, 'devis');
    expect(result.kind).toBe('move');
    if (result.kind !== 'move') return;
    expect(result.column).toBe('devis');
    expect(result.position).toBe(2);
    expect(result.board.devis.map((p) => p.id)).toEqual([2, 3, 1]);
  });

  it('still reports a move when the destination index matches the source index', () => {
    // dragOver already relocated card 1 into print at index 0; it sat at index 0
    // of devis before. Index is unchanged but the column is not, so this must persist.
    const board = buildBoard([card(1, 'print', 0), card(2, 'devis', 0)]);
    const result = computeMoveTarget(board, 1, 1, 'devis');
    expect(result.kind).toBe('move');
    if (result.kind !== 'move') return;
    expect(result.column).toBe('print');
    expect(result.position).toBe(0);
  });

  it('asks for a resync when the active card is on no column', () => {
    expect(computeMoveTarget(emptyBoard(), 42, 'devis', 'devis')).toEqual({ kind: 'resync' });
  });

  it('round-trips through the server when the column holds an urgent card', () => {
    // `position` is an index into the DISPLAYED order (urgent first), so the
    // server has to renumber in that same order — see move_project in
    // backend/app/api/routes/aito.py. This pins the two halves together: what
    // the drag reports must be what the next fetch renders.
    const serverMove = (
      projects: AitoProject[],
      activeId: number,
      column: AitoProject['column'],
      position: number,
    ): AitoProject[] => {
      const moving = projects.find((p) => p.id === activeId)!;
      const destination = projects
        .filter((p) => p.column === column && p.id !== activeId)
        .sort((a, b) => flagRank(a.flag) - flagRank(b.flag) || a.position - b.position);
      destination.splice(Math.min(position, destination.length), 0, moving);
      return destination.map((p, index) => ({ ...p, column, position: index }));
    };

    const stored = [
      card(1, 'devis', 0),
      { ...card(2, 'devis', 1), flag: 'urgent' as const },
      card(3, 'devis', 2),
      card(4, 'devis', 3),
    ];
    const board = buildBoard(stored);
    expect(board.devis.map((p) => p.id)).toEqual([2, 1, 3, 4]);

    // Drag card 4 up onto the slot card 1 occupies on screen (display index 1).
    const result = computeMoveTarget(board, 4, 1, 'devis');
    expect(result.kind).toBe('move');
    if (result.kind !== 'move') return;
    expect(result.position).toBe(1);
    expect(result.board.devis.map((p) => p.id)).toEqual([2, 4, 1, 3]);

    // What the server stores must redisplay as what the drag showed.
    const refetched = buildBoard(serverMove(stored, 4, result.column, result.position));
    expect(refetched.devis.map((p) => p.id)).toEqual([2, 4, 1, 3]);
  });
});

describe('toOptimisticProjects', () => {
  it('renumbers positions contiguously from zero and rewrites the column', () => {
    const board = buildBoard([card(1, 'devis', 5), card(2, 'devis', 9), card(3, 'print', 4)]);
    const flat = toOptimisticProjects(board);
    expect(flat).toEqual([
      expect.objectContaining({ id: 1, column: 'devis', position: 0 }),
      expect.objectContaining({ id: 2, column: 'devis', position: 1 }),
      expect.objectContaining({ id: 3, column: 'print', position: 0 }),
    ]);
  });
});
