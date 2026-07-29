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

  it('opens Finish and Done to an unlocked card', () => {
    expect(allowedColumns({ ...base, column: 'finish', move_lock: null })).toEqual(['finish', 'done']);
    expect(allowedColumns({ ...base, column: 'done', move_lock: null })).toEqual(['finish', 'done']);
  });
});
