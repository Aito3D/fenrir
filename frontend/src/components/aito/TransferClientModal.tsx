import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRoundPen } from 'lucide-react';
import { api, ApiError, type AitoProject, type ZohoContact, type ZohoContactPerson } from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useToast } from '../../contexts/ToastContext';
import { replaceProject } from '../../utils/aitoOptimistic';
import {
  applyContactPerson,
  defaultClientDraft,
  draftFromContact,
  formatPhone,
  type ClientDraft,
} from '../../utils/clientDraft';
import { AitoDialogShell } from './AitoDialogShell';
import { AitoDialogFooter } from './AitoDialogFooter';
import { ClientCombobox } from './ClientCombobox';
import { ContactPersonPicker } from './ContactPersonPicker';

/** A beat past .animate-modal-out's 150ms — the margin MergeProjectModal gives. */
const MODAL_OUT_MS = 170;

/** The PUT body for a picked client — the same mapping the new-card drawer
 *  sends on create (useAitoPageMutations), minus the social pair: the server
 *  clears it on a transfer, since it belongs to the old client. */
function transferBody(draft: ClientDraft) {
  return {
    client_id: draft.id,
    client_name: draft.name,
    client_phone: formatPhone(draft) || null,
    client_email: draft.email.trim() || null,
    client_is_company: draft.isCompany,
    client_contact_person_id: draft.isCompany ? draft.contactPersonId : null,
  };
}

/** Hand the card to another Zoho contact (spec A5): the drawer's client search
 *  (without "create new" — a new contact is made from the drawer) plus its
 *  walk-in reset, a "From … to …" line once a client is picked, and one PUT.
 *
 *  Rendered by the panel over itself (z-[110]), like MergeProjectModal. On
 *  success the answer is written straight into the board cache, which is
 *  where the panel reads its card from, so the header shows the new client
 *  without waiting for the refetch. */
export function TransferClientModal({
  project,
  onClose,
  onDone,
}: {
  project: AitoProject;
  onClose: () => void;
  onDone?: (project: AitoProject) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: MODAL_OUT_MS });
  const [draft, setDraft] = useState<ClientDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The company whose person list answered empty or failed: nothing will be
  // auto-picked for it, so Transfer stops waiting and sends no person.
  const [noPersonFor, setNoPersonFor] = useState<string | null>(null);

  // Same key as the drawer's and the panel's, so this is normally cached.
  const statusQuery = useQuery({
    queryKey: ['zoho-status', { probe: false }],
    queryFn: () => api.getZohoStatus(),
    staleTime: 60_000,
  });
  const defaultId = statusQuery.data?.default_contact_id ?? '';
  const defaultName = statusQuery.data?.default_contact_name ?? '';

  const choose = (next: ClientDraft) => {
    setDraft(next);
    setError(null);
  };
  // Functional: the picker auto-selects from an effect, after the draft that
  // rendered it may already have been replaced.
  const selectPerson = useCallback(
    (person: ZohoContactPerson) => setDraft((d) => (d ? applyContactPerson(d, person) : d)),
    [],
  );

  const transfer = useMutation({
    mutationFn: (next: ClientDraft) => api.transferAitoClient(project.id, transferBody(next)),
    onSuccess: (updated) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) => replaceProject(prev, updated));
      void queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      void queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
      // The card leaves one client's history and joins the other's; the
      // prefix also reaches ClientHistoryModal's longer-limit entry.
      for (const id of new Set([project.client_id, updated.client_id])) {
        if (id) void queryClient.invalidateQueries({ queryKey: ['aito-client-history', id] });
      }
      showToast(t('aito.transferClientDone', { name: updated.client_name ?? '' }), 'success');
      onDone?.(updated);
      onClose();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : t('aito.transferError'));
    },
  });

  // Picking the card's own client would be a server no-op: nothing to confirm.
  const changed = draft !== null && draft.id !== project.client_id;
  // A company waits for its person (the picker auto-selects Books' primary),
  // unless the account has none to give.
  const personPending =
    draft !== null &&
    draft.isCompany &&
    !draft.isDefault &&
    draft.contactPersonId === null &&
    noPersonFor !== draft.id;

  return (
    <AitoDialogShell
      label={t('aito.transferClientTitle')}
      testId="transfer-client-modal"
      icon={UserRoundPen}
      subtitle={t('aito.transferClientBody')}
      closing={closing}
      requestClose={requestClose}
      dialogRef={dialogRef}
      busy={transfer.isPending}
      maxWidthCls="max-w-[560px]"
    >

      {/* No overflow clip here: the combobox's result list hangs below
          the input as an absolute layer and must be free to cover the
          footer rather than scroll inside a short box. */}
      <div className="space-y-3 px-6 pb-4">
        <ClientCombobox
          clientName={draft?.name ?? ''}
          onSelect={(contact: ZohoContact) => choose(draftFromContact(contact, defaultId))}
          // The reset arrow is the drawer's walk-in choice; hidden when
          // the walk-in is already the card's client or the pick.
          onReset={() => choose(defaultClientDraft(defaultId, defaultName))}
          showReset={defaultId !== '' && project.client_id !== defaultId && draft?.id !== defaultId}
        />
        {draft && draft.isCompany && !draft.isDefault && (
          <ContactPersonPicker
            key={draft.id}
            contactId={draft.id}
            value={draft.contactPersonId}
            preferredId={null}
            onSelect={selectPerson}
            onLoaded={(has) => !has && setNoPersonFor(draft.id)}
            onUnavailable={() => setNoPersonFor(draft.id)}
            variant="sheet"
          />
        )}
        {changed && (
          <p className="animate-rise text-sm text-white">
            {t('aito.transferClientFromTo', { from: project.client_name ?? t('aito.noClient'), to: draft.name })}
          </p>
        )}
      </div>

      <AitoDialogFooter
        error={error}
        pending={transfer.isPending}
        onCancel={requestClose}
        confirmLabel={t('aito.transferClientConfirm')}
        confirmDisabled={!changed || personPending || transfer.isPending}
        onConfirm={() => draft && transfer.mutate(draft)}
      />
    </AitoDialogShell>
  );
}
