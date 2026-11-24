import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { useProjectCodes } from '../../components/projects/aito/useProjectCodes';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** A code de suivi typed in the board search is added to its card's codes,
 *  so matchesSearch finds the card without the token ever being on the board. */
describe('useProjectCodes tracking-code lookup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getAitoProjectCodes').mockResolvedValue({ '7': ['P-0042'] });
  });

  it('adds the typed code to the card the server resolves it to', async () => {
    const lookup = vi.spyOn(api, 'getAitoTrackingCodeCard').mockResolvedValue({ project_id: 7 });
    const { result } = renderHook(() => useProjectCodes('k7f3-xq'), { wrapper });
    await waitFor(() => expect(result.current['7']).toEqual(['P-0042', 'k7f3-xq']));
    expect(lookup).toHaveBeenCalledWith('k7f3-xq');
  });

  it('asks nothing for a query with no code-shaped word', async () => {
    const lookup = vi.spyOn(api, 'getAitoTrackingCodeCard');
    const { result } = renderHook(() => useProjectCodes('acme 12'), { wrapper });
    await waitFor(() => expect(result.current['7']).toEqual(['P-0042']));
    expect(lookup).not.toHaveBeenCalled();
  });
});
