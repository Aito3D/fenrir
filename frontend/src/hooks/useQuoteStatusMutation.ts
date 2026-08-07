import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useOptimisticBoardMutation } from './useOptimisticBoardMutation';
import { applyQuoteStatus } from '../utils/aitoOptimistic';
import { api, ApiError, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';

// Module scope: a plain object literal, identical on every render, so it
// need not be reconstructed each time a consumer renders.
const TOAST_KEYS = {
  sent: 'aito.quoteSent',
  accepted: 'aito.quoteAccepted',
  declined: 'aito.quoteDeclined',
} as const;

type QuoteStatus = keyof typeof TOAST_KEYS;

/** The one quote-status transition, shared by the detail panel's action block
 *  and the board card's mark-as-sent button.
 *
 *  Extracted rather than duplicated because the two surfaces must agree on
 *  more than the request: the optimistic cache write, which toast fires, and
 *  the separate warning when the board moved but the push to Books did not.
 *  A second copy would drift on the third of those first.
 *
 *  Optimistic: the card relocates the instant the hold completes, predicted
 *  through the mirrored rules. The success handler still writes the server's
 *  own row over the prediction — `task_pending` itself now ships from the
 *  server exactly, so this is no longer correcting a counter mismatch; it is
 *  what picks up anything else the mutation's own response changed (Zoho
 *  fields, `updated_at`) that the optimistic write never predicted. */
export function useQuoteStatusMutation(project: AitoProject) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useOptimisticBoardMutation<{ project: AitoProject; zoho_synced: boolean; no_op: boolean }, QuoteStatus>({
    mutationFn: (status) => api.setAitoQuoteStatus(project.id, { status }),
    transform: (previous, status) => applyQuoteStatus(previous, project.id, status),
    flashId: () => project.id,
    onSuccess: (result, status) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === result.project.id ? result.project : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
      // A repeat of a decision someone already applied: the board row above is
      // fresh, but there is nothing to announce and no Zoho push happened.
      if (result.no_op) return;
      showToast(t(TOAST_KEYS[status]), 'success');
      // The board is right either way — only the push to Books failed. No
      // rollback: this is a warning about Zoho, not a refused change.
      if (project.quote_id && !result.zoho_synced) showToast(t('aito.zohoNotUpdated'), 'error');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'quote_status_conflict') {
        const current = error.detail?.current;
        showToast(t(current === 'declined' ? 'aito.quoteConflictDeclined' : 'aito.quoteConflictAccepted'), 'warning');
        return;
      }
      showToast(t('aito.saveFailed'), 'error');
    },
  });
}
