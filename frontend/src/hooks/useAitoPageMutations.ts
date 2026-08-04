import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type AitoProject, type ZohoQuotePreview, type ZohoQuoteShipping } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { formatPhone } from '../utils/clientDraft';
import type { ClientDraft } from '../utils/clientDraft';
import { taskDraftToTaskCreate } from '../utils/taskDraft';
import type { TaskDraft } from '../utils/taskDraft';
import { shippingPayload } from '../utils/shippingDraft';
import type { ShippingDraft } from '../utils/shippingDraft';
import { clearNewProjectDraft } from './useNewProjectDraft';
import { useOptimisticBoardMutation } from './useOptimisticBoardMutation';
import { applyCreate, applyDelete } from '../utils/aitoOptimistic';

// Mirrors `_SHIPPING_PHONE_RE` in backend/app/api/routes/aito.py — POST
// /aito/ 422s the WHOLE create if `shipping_phone` doesn't match this shape.
// Exported (not just kept local) so the parity test in
// useAitoPageMutations.test.tsx can read this exact regex and diff its
// `.source` against the backend's own pattern, rather than the two copies
// being bound only by this comment.
export const SHIPPING_PHONE_RE = /^\+\d{1,4}-\d{4,14}$/;

/** True when a preview's shipment is actually acceptable to POST /aito/.
 *
 *  `parse_shipping_line` (aito_quote_import.py) fills `first_name`/`last_name`
 *  from a "Nom:" row and `phone` from a "Téléphone:" row on the Books quote
 *  line — free text that can be missing or hand-typed wrong (`87.12.34.56`
 *  instead of `+689-87123456`) — and returns them regardless, on its own
 *  "None on any doubt" discipline for the ISLAND alone. Names and phone are
 *  never re-validated there. Forwarding an unusable shipment unconditionally
 *  would turn one bad shipping line into a 422 for the WHOLE import — a
 *  quote that otherwise has nothing wrong with it — instead of the shipment
 *  being silently dropped, which is what happened before this feature
 *  existed and is what this restores when the shipment doesn't qualify. */
function importableShipping(shipping: ZohoQuoteShipping): boolean {
  return (
    shipping.first_name.trim() !== ''
    && shipping.last_name.trim() !== ''
    && SHIPPING_PHONE_RE.test(shipping.phone.trim())
  );
}

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
    { description: string; draft: ClientDraft; tasks: TaskDraft[]; shipping: ShippingDraft | null; placeholder: AitoProject }
  >({
    mutationFn: ({ description, draft, tasks, shipping }) =>
      api.createAitoProject({
        description,
        client_id: draft.id,
        client_name: draft.name,
        client_phone: formatPhone(draft) || null,
        client_email: draft.email.trim() || null,
        client_is_company: draft.isCompany,
        tasks: tasks.map(taskDraftToTaskCreate),
        ...(shipping ? shippingPayload(shipping) : {}),
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
        // `preview.shipping` (ZohoQuoteShipping) is unprefixed and carries a
        // `service` the request body must never see — the server derives
        // `shipping_service` from the island alone. `service` is deliberately
        // dropped, not renamed. And it is only forwarded at all when
        // `importableShipping` says the server will actually accept it —
        // see that function's docstring for why an unconditional forward
        // would be a regression, not an improvement.
        ...(preview.shipping && importableShipping(preview.shipping)
          ? {
              shipping_island: preview.shipping.island,
              shipping_first_name: preview.shipping.first_name,
              shipping_last_name: preview.shipping.last_name,
              shipping_phone: preview.shipping.phone,
              shipping_price: preview.shipping.price,
            }
          : {}),
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
