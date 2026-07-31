import { describe, it, expect } from 'vitest';
import { allowedColumns } from '../../utils/aitoBoard';
import type { AitoProject } from '../../api/client';

const base = { id: 1, column: 'devis', move_lock: 'quote' } as unknown as AitoProject;

describe('allowedColumns', () => {
  it('pins a locked card to the column it is already in', () => {
    expect(allowedColumns(base)).toEqual(['devis']);
    expect(allowedColumns({ ...base, column: 'print', move_lock: 'steps' })).toEqual(['print']);
    expect(allowedColumns({ ...base, column: 'done', move_lock: 'declined' })).toEqual(['done']);
  });

  it('pins a RELEASED card to its own column too — drag is reordering only', () => {
    // A released card's Finish <-> Done transition is the card's own hold
    // buttons now, not a drop: Done is not a rendered column, so it registers
    // no droppable and offering it here would only dim the other five columns
    // mid-drag while pointing at somewhere the card cannot actually be
    // dropped.
    expect(allowedColumns({ ...base, column: 'finish', move_lock: null })).toEqual(['finish']);
    expect(allowedColumns({ ...base, column: 'done', move_lock: null })).toEqual(['done']);
  });
});
