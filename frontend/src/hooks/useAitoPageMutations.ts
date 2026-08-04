import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type AitoProject, type ZohoQuotePreview } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { formatPhone } from '../utils/clientDraft';
import type { ClientDraft } from '../utils/clientDraft';
import { taskDraftToTaskCreate } from '../utils/taskDraft';
import type { TaskDraft } from '../utils/taskDraft';
import { clearNewProjectDraft } from './useNewProjectDraft';
import { useOptimisticBoardMutation } from './useOptimisticBoardMutation';
import { applyCreate, applyDelete } from '../utils/aitoOptimistic';

/** The board's create/import/delete writes — everything `useOptimisticBoardMutation`
 *  wraps around a plain `mutationFn`, moved out of `AitoPage` so the page is
 *  left with orchestration and render only. */
export function useAitoPageMutations() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  /** Push edited contact details back to Zoho after the card exists.
   *
   *  Deliberately not awaited by the create mutation: the board is the job and
   *  a Zoho outage must not cost the user their card. The default walk-in
   *  contact is skipped entirely — it is shared by every passing customer and
   *  carries live transaction history. Fields the user never edited are skipped
   *  too, so creating a project never silently reformats a stored number. */
  const syncClientToZoho = async (draft: ClientDraft) => {
    // `draft.isDefault` is `draft.id === defaultContactId` frozen at the
    // moment the drawer built this draft (see `defaultClientDraft` /
    // `draftFromContact` in clientDraft.ts) — the same default the drawer
    // reads from the shared `zoho-status` query. Reading it off the draft
    // here avoids a second copy of that query just to re-derive a value the
    // draft already carries. The backend rejects a PATCH to this contact
    // anyway (see routes/zoho.py's patch_contact, ~line 210), but a silent
    // skip beats a warning toast on every counter sale.
    if (draft.isDefault) return;
    if (!draft.touched.phone && !draft.touched.email) return;
    try {
      await api.updateZohoContact(draft.id, {
        ...(draft.touched.phone
          ? { phone: formatPhone(draft), phone_field: draft.original.phoneField }
          : {}),
        ...(draft.touched.email ? { email: draft.email.trim() } : {}),
      });
    } catch {
      showToast(t('aito.clientSyncFailed'), 'warning');
    }
  };

  const createMutation = useOptimisticBoardMutation<
    AitoProject,
    { description: string; draft: ClientDraft; tasks: TaskDraft[]; placeholder: AitoProject }
  >({
    mutationFn: ({ description, draft, tasks }) =>
      api.createAitoProject({
        description,
        client_id: draft.id,
        client_name: draft.name,
        client_phone: formatPhone(draft) || null,
        client_email: draft.email.trim() || null,
        client_is_company: draft.isCompany,
        tasks: tasks.map(taskDraftToTaskCreate),
      }),
    transform: (previous, { placeholder }) => applyCreate(previous, placeholder),
    // No flash: the placeholder is REMOVED on failure rather than reverted in
    // place, so there is no card left to ring.
    onSuccess: (created, { placeholder, draft }) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === placeholder.id ? created : p)) ?? prev,
      );
      void syncClientToZoho(draft);
      // The card exists now — the drawer's persisted localStorage draft
      // would otherwise reopen next time with a task list and client that
      // were already turned into this project.
      clearNewProjectDraft();
    },
    onError: (_error, { placeholder }) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.filter((p) => p.id !== placeholder.id) ?? prev,
      );
      showToast(t('aito.createFailed'), 'error');
    },
  });

  /** Import posts through the same create endpoint as a manual card, so the
   *  board's ordering, defaults and landing column all behave identically —
   *  the only difference is the quote snapshot riding along. Nothing is
   *  written back to Zoho. */
  const importMutation = useOptimisticBoardMutation<
    AitoProject,
    { description: string; preview: ZohoQuotePreview; placeholder: AitoProject }
  >({
    mutationFn: ({ description, preview }) =>
      api.createAitoProject({
        description,
        client_id: preview.client.id,
        client_name: preview.client.name,
        client_phone: preview.client.phone,
        client_email: preview.client.email,
        client_is_company: preview.client.is_company,
        tasks: preview.tasks,
        quote_id: preview.quote.id,
        quote_number: preview.quote.number,
        quote_date: preview.quote.date,
        quote_total: preview.quote.total,
        quote_url: preview.quote.url,
        quote_salesperson: preview.quote.salesperson,
        quote_status: preview.quote.status,
      }),
    transform: (previous, { placeholder }) => applyCreate(previous, placeholder),
    onSuccess: (created, { placeholder }) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === placeholder.id ? created : p)) ?? prev,
      );
    },
    onError: (error, { placeholder }) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.filter((p) => p.id !== placeholder.id) ?? prev,
      );
      const conflict = error instanceof ApiError && error.status === 409;
      showToast(t(conflict ? 'aito.quoteAlreadyHasProject' : 'aito.createFailed'), 'error');
    },
  });

  const deleteMutation = useOptimisticBoardMutation<void, number>({
    mutationFn: (id) => api.deleteAitoProject(id),
    transform: (previous, id) => applyDelete(previous, id),
    flashId: (id) => id,
    onSuccess: () => {
      // The board is handled by the wrapper's settle-invalidate; the trash is
      // a separate query with a new row in it.
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
    },
    onError: () => showToast(t('aito.deleteFailed'), 'error'),
  });

  return { createMutation, importMutation, deleteMutation };
}
