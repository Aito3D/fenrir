import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLatestProjectEvent } from '../../hooks/useLatestProjectEvent';
import { api } from '../../api/client';

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return { ...actual, api: { ...actual.api, getAitoEvents: vi.fn() } };
});

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const event = (overrides = {}) => ({
  id: 9,
  occurred_at: '2026-07-30T22:07:45',
  occurred_until: null,
  kind: 'quote.accepted',
  actor_class: 'user',
  actor_name: 'admin',
  subject_type: null,
  subject_id: null,
  subject_label: null,
  changes: null,
  detail: null,
  note: null,
  ...overrides,
});

describe('useLatestProjectEvent', () => {
  beforeEach(() => vi.mocked(api.getAitoEvents).mockReset());

  it('asks for one row at the deepest level, so the rail\'s depth toggle cannot change the answer', async () => {
    vi.mocked(api.getAitoEvents).mockResolvedValue({ events: [event()], has_more: true });

    const { result } = renderHook(() => useLatestProjectEvent(12), { wrapper });

    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(api.getAitoEvents).toHaveBeenCalledWith(12, { depth: 'everything', limit: 1 });
  });

  it('returns the single newest event', async () => {
    vi.mocked(api.getAitoEvents).mockResolvedValue({ events: [event({ actor_name: 'Zoho Books' })], has_more: true });

    const { result } = renderHook(() => useLatestProjectEvent(12), { wrapper });

    await waitFor(() => expect(result.current.data?.actor_name).toBe('Zoho Books'));
  });

  it('returns undefined for a project with no events at all', async () => {
    vi.mocked(api.getAitoEvents).mockResolvedValue({ events: [], has_more: false });

    const { result } = renderHook(() => useLatestProjectEvent(12), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toBeUndefined();
  });
});
