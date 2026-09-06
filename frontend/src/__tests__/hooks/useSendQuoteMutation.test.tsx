/**
 * Tests for useSendQuoteMutation (task T-016). The hook's onSuccess has a
 * narrow, easy-to-invert branch: `marked_sent === false` (the email sent but
 * the card failed to move) must show the card-move-failed warning, while
 * both `undefined`/`null` (no move attempted/needed) and `true` fall
 * through to the plain success toast. This file pins that branch plus the
 * error path and the cache write, following the mocking pattern used in
 * useQuoteStatusMutation.test.tsx.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSendQuoteMutation } from '../../hooks/useSendQuoteMutation';
import { api, type AitoProject } from '../../api/client';
import { showToastMock } from './boardMutationHarness';

// `vi.mock(...)` factories are hoisted above this file's own imports, so the
// harness's factories cannot be referenced directly here (that trips a
// temporal-dead-zone ReferenceError) — a dynamic import inside the factory
// sidesteps the hoisting order instead.
vi.mock('react-i18next', async () => (await import('./boardMutationHarness')).i18nKeyTranslationFactory());
vi.mock('../../contexts/ToastContext', async () => (await import('./boardMutationHarness')).toastContextMockFactory());

const project = { id: 1, quote_id: 'q-1', quote_status: 'draft' } as AitoProject;

function renderSendQuoteHook(onDone: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['aito-projects'], [project]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useSendQuoteMutation(project, onDone), { wrapper });
  return { ...view, client };
}

describe('useSendQuoteMutation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    showToastMock.mockClear();
  });

  it('shows the plain success toast and calls onDone when marked_sent is undefined/null', async () => {
    const updatedProject = { ...project, quote_status: 'sent' } as AitoProject;
    vi.spyOn(api, 'sendAitoQuoteEmail').mockResolvedValue({ project: updatedProject, marked_sent: null });
    const onDone = vi.fn();
    const { result } = renderSendQuoteHook(onDone);

    await act(async () => {
      result.current.mutate('shop@example.com');
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    expect(showToastMock).toHaveBeenCalledWith('aito.quoteEmailed', 'success');
    expect(showToastMock).not.toHaveBeenCalledWith('aito.quoteEmailedCardMoveFailed', 'warning');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('shows the card-move-failed warning and still calls onDone when marked_sent is false', async () => {
    const updatedProject = { ...project, quote_status: 'sent' } as AitoProject;
    vi.spyOn(api, 'sendAitoQuoteEmail').mockResolvedValue({ project: updatedProject, marked_sent: false });
    const onDone = vi.fn();
    const { result } = renderSendQuoteHook(onDone);

    await act(async () => {
      result.current.mutate('shop@example.com');
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    expect(showToastMock).toHaveBeenCalledWith('aito.quoteEmailedCardMoveFailed', 'warning');
    expect(showToastMock).not.toHaveBeenCalledWith('aito.quoteEmailed', 'success');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('shows the error toast and does not call onDone when the mutation is rejected', async () => {
    vi.spyOn(api, 'sendAitoQuoteEmail').mockRejectedValue(new Error('network down'));
    const onDone = vi.fn();
    const { result } = renderSendQuoteHook(onDone);

    await act(async () => {
      result.current.mutate('shop@example.com');
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    expect(showToastMock).toHaveBeenCalledWith('aito.quoteEmailFailed', 'error');
    expect(onDone).not.toHaveBeenCalled();
  });

  it("writes the returned project into the ['aito-projects'] query cache on success", async () => {
    const updatedProject = { ...project, quote_status: 'sent' } as AitoProject;
    vi.spyOn(api, 'sendAitoQuoteEmail').mockResolvedValue({ project: updatedProject, marked_sent: true });
    const onDone = vi.fn();
    const { result, client } = renderSendQuoteHook(onDone);

    await act(async () => {
      result.current.mutate('shop@example.com');
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    expect(client.getQueryData<AitoProject[]>(['aito-projects'])).toEqual([updatedProject]);
  });
});
