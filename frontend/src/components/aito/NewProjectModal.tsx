import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoContact } from '../../api/client';
import { Button } from '../Button';
import { ClientSection } from './ClientSection';
import { NewContactForm } from './NewContactForm';
import { clientDraftErrors, defaultClientDraft, draftFromContact } from '../../utils/clientDraft';
import type { ClientDraft } from '../../utils/clientDraft';
import { inputCls, labelCls } from '../formStyles';

export interface NewProjectModalProps {
  onClose: () => void;
  onCreate: (description: string, draft: ClientDraft) => void;
}

/** Two-view modal: the project form, and a create-client sub-step that slides
 *  over it. A client is always attached — the default walk-in contact until the
 *  user picks another — so creation is never blocked on choosing one. */
export function NewProjectModal({ onClose, onCreate }: NewProjectModalProps) {
  const { t } = useTranslation();
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState<ClientDraft | null>(null);
  const [creatingClient, setCreatingClient] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const statusQuery = useQuery({ queryKey: ['zoho-status'], queryFn: api.getZohoStatus, staleTime: 60_000 });
  const defaultId = statusQuery.data?.default_contact_id ?? '';
  const defaultName = statusQuery.data?.default_contact_name ?? '';

  // Seed the draft once the default contact is known.
  useEffect(() => {
    if (!draft && defaultId) setDraft(defaultClientDraft(defaultId, defaultName));
  }, [draft, defaultId, defaultName]);

  // Escape and a backdrop click are both "dismiss the thing on top": while the
  // create-client sub-step is showing that means stepping back to the main
  // form (same as its Back button), never discarding whatever the user typed
  // into it. Only when the main form itself is showing do they close the modal.
  const dismiss = () => {
    if (creatingClient !== null) setCreatingClient(null);
    else onClose();
  };

  useEffect(() => {
    textareaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creatingClient, onClose]);

  // `clientDraftErrors` only reports blurred fields, so this is what the user can
  // currently see. Validity for gating is computed against a fully-blurred copy,
  // which is also what `submit` reveals — a disabled button is therefore always
  // accompanied by a visible message.
  const clientValid =
    draft === null ||
    Object.values(clientDraftErrors({ ...draft, blurred: { phone: true, email: true } })).every(
      (e) => e === null,
    );
  const canSubmit = description.trim().length > 0 && draft !== null && clientValid;

  const submit = () => {
    if (!draft) return;
    // Reveal errors the user never triggered by leaving a field.
    setDraft({ ...draft, blurred: { phone: true, email: true } });
    if (description.trim().length === 0 || !clientValid) return;
    onCreate(description.trim(), draft);
  };

  const onClientCreated = (contact: ZohoContact) => {
    setDraft(draftFromContact(contact, defaultId));
    setCreatingClient(null);
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="bg-bambu-dark-secondary rounded-xl w-full max-w-md border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)] animate-modal-in">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">
            {creatingClient === null ? t('aito.modalTitle') : t('aito.newClientTitle')}
          </h2>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="p-1 -m-1 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {creatingClient !== null ? (
          <NewContactForm
            initialQuery={creatingClient}
            onCancel={() => setCreatingClient(null)}
            onCreated={onClientCreated}
          />
        ) : (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex flex-col flex-1 min-h-0"
          >
            <div className="p-4 overflow-y-auto flex-1 space-y-4">
              {draft && (
                <ClientSection
                  value={draft}
                  onChange={setDraft}
                  onCreateNew={setCreatingClient}
                  defaultContactId={defaultId}
                  defaultContactName={defaultName}
                />
              )}
              <div>
                <label htmlFor="aito-description" className={labelCls}>
                  {t('aito.productDescription')}
                </label>
                <textarea
                  id="aito-description"
                  ref={textareaRef}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
                  }}
                  placeholder={t('aito.descriptionPlaceholder')}
                  rows={4}
                  required
                  className={`${inputCls} resize-none`}
                />
              </div>
            </div>

            <div className="p-4 border-t border-bambu-dark-tertiary flex justify-end gap-2 flex-shrink-0">
              <Button type="button" variant="secondary" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                <Plus className="w-4 h-4 mr-2" />
                {t('aito.create')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
