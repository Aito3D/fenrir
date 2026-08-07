/**
 * Tests for the shared quote-status mutation's 409-conflict and no_op paths
 * (task 6: multi-user sync). The hook is exercised through
 * useOptimisticBoardMutation, so the board's own 409-refetch behavior is
 * covered separately in useOptimisticBoardMutation.test.tsx — this file only
 * pins the toast contract this hook layers on top: quote_status_conflict
 * maps to the "already decided" warning (never the generic saveFailed
 * error), and a no_op success stays completely silent (no success toast, no
 * zohoNotUpdated warning).
 */
import type { ReactNode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useQuoteStatusMutation } from '../../hooks/useQuoteStatusMutation';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { api, ApiError, type AitoProject } from '../../api/client';

// Mocked BEFORE any importing module runs, same pattern useWebSocket.test.ts
// uses: `t` returns the key so assertions can check against the raw i18n
// key instead of a translated string.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Mocked directly (useSponsorPrompt.test.tsx's pattern) rather than wrapped
// in the real ToastProvider: the hook only needs `showToast`, and mocking it
// lets the tests assert on exactly what was shown without rendering the
// toast portal.
const showToastMock = vi.fn();
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

function renderQuoteStatusHook(project: AitoProject) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['aito-projects'], [project]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useQuoteStatusMutation(project), { wrapper });
}

const project = { id: 1, quote_id: 'q-1', quote_status: 'sent' } as AitoProject;

describe('useQuoteStatusMutation', () => {
  beforeEach(() => {
    __resetBoardSync();
    vi.restoreAllMocks();
    showToastMock.mockClear();
  });

  it('shows the already-decided toast on quote_status_conflict', async () => {
    vi.spyOn(api, 'setAitoQuoteStatus').mockRejectedValue(
      new ApiError('conflict', 409, 'quote_status_conflict', { current: 'accepted' }),
    );
    const { result } = renderQuoteStatusHook(project);

    await act(async () => {
      result.current.mutate('declined');
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    expect(showToastMock).toHaveBeenCalledWith('aito.quoteConflictAccepted', 'warning');
    expect(showToastMock).not.toHaveBeenCalledWith('aito.saveFailed', 'error');
  });

  it('shows the declined-specific toast when the conflict is a declined quote', async () => {
    vi.spyOn(api, 'setAitoQuoteStatus').mockRejectedValue(
      new ApiError('conflict', 409, 'quote_status_conflict', { current: 'declined' }),
    );
    const { result } = renderQuoteStatusHook(project);

    await act(async () => {
      result.current.mutate('sent');
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    expect(showToastMock).toHaveBeenCalledWith('aito.quoteConflictDeclined', 'warning');
  });

  it('falls back to the generic save-failed toast on a non-conflict error', async () => {
    vi.spyOn(api, 'setAitoQuoteStatus').mockRejectedValue(new Error('network down'));
    const { result } = renderQuoteStatusHook(project);

    await act(async () => {
      result.current.mutate('accepted');
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    expect(showToastMock).toHaveBeenCalledWith('aito.saveFailed', 'error');
  });

  it('stays silent on a no_op response', async () => {
    vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({
      project: { ...project, version: 0 },
      zoho_synced: true,
      no_op: true,
    });
    const { result } = renderQuoteStatusHook(project);

    await act(async () => {
      result.current.mutate('accepted');
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    expect(showToastMock).not.toHaveBeenCalled();
  });
});
