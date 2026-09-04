import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { settleProject } from '../../components/aito/settleProject';
import type { AitoProject } from '../../api/client';

const card = (id: number, description: string): AitoProject => ({ id, description }) as AitoProject;

describe('settleProject', () => {
  it('writes the server row into the aito-projects cache, then invalidates aito-events for that project', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(['aito-projects'], [card(1, 'before'), card(2, 'other')]);
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    const serverRow = card(1, 'after');
    settleProject(client, 1, serverRow);

    // Order matters: the cache write must land before the invalidation is
    // even issued, so the invalidated query already sees the server's row.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['aito-events', 1] });
    expect(client.getQueryData<AitoProject[]>(['aito-projects'])).toEqual([serverRow, card(2, 'other')]);
  });

  it('leaves an unmatched id in place rather than inserting the row', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const original = [card(1, 'before')];
    client.setQueryData(['aito-projects'], original);

    settleProject(client, 2, card(2, 'new'));

    expect(client.getQueryData<AitoProject[]>(['aito-projects'])).toEqual(original);
  });

  it('is a no-op on the cache when there is nothing cached yet, but still invalidates events', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    settleProject(client, 5, card(5, 'row'));

    expect(client.getQueryData(['aito-projects'])).toBeUndefined();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['aito-events', 5] });
  });
});
