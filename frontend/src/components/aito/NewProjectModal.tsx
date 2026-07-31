import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoContact } from '../../api/client';
import { Button } from '../Button';
import { ClientSection } from './ClientSection';
import { NewContactForm } from './NewContactForm';
import { TaskEditor } from './TaskEditor';
import { defaultClientDraft, draftFromContact, visibleClientDraftErrors } from '../../utils/clientDraft';
import type { ClientDraft } from '../../utils/clientDraft';
import { emptyTaskDraft, projectHasPricedService } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';
import { inputCls, labelCls } from '../formStyles';

export interface NewProjectModalProps {
  onClose: () => void;
  onCreate: (description: string, draft: ClientDraft, tasks: TaskDraft[]) => void;
}

/** Two-view modal: the project form, and a create-client sub-step that slides
 *  over it. A client is always attached — the default walk-in contact until the
 *  user picks another — so creation is never blocked on choosing one. */
export function NewProjectModal({ onClose, onCreate }: NewProjectModalProps) {
  const { t } = useTranslation();
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState<ClientDraft | null>(null);
  // Was `string | null`, doing double duty as "which view is showing" and "the
  // seed for the company field". The company field starts empty now, so this is
  // only ever the former.
  const [creatingClient, setCreatingClient] = useState(false);
  // A project with no task is not a project — it would produce a quote with no
  // lines. Opening with one row makes the requirement obvious instead of
  // enforcing it with an error after the fact.
  const [tasks, setTasks] = useState<TaskDraft[]>(() => [emptyTaskDraft()]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const statusQuery = useQuery({
    queryKey: ['zoho-status', { probe: false }],
    queryFn: () => api.getZohoStatus(),
    staleTime: 60_000,
  });
  const defaultId = statusQuery.data?.default_contact_id ?? '';
  const defaultName = statusQuery.data?.default_contact_name ?? '';
  // The status endpoint always returns a default contact — even a fallback one
  // — so it can ride along without a second round trip once Zoho *is*
  // configured. That default must never be treated as permission to create:
  // while `configured` is false there is no real client behind that id.
  const configured = statusQuery.data?.configured === true;

  // Seed the draft once the default contact is known.
  useEffect(() => {
    if (!draft && defaultId) setDraft(defaultClientDraft(defaultId, defaultName));
  }, [draft, defaultId, defaultName]);

  // Escape and a backdrop click are both "dismiss the thing on top": while the
  // create-client sub-step is showing that means stepping back to the main
  // form (same as its Back button), never discarding whatever the user typed
  // into it. Only when the main form itself is showing do they close the modal.
  const dismiss = () => {
    if (creatingClient) setCreatingClient(false);
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

  // `visibleClientDraftErrors` only reports blurred fields, so this is what the
  // user can currently see right now — and gating on exactly that (not on raw
  // validity) matters: a contact whose *stored* phone or email is already
  // malformed must never disable the button before the user has touched
  // anything, with no message on screen explaining why. Clicking submit is what
  // reveals it, below, the same way leaving the field would have.
  const visibleErrors = draft ? visibleClientDraftErrors(draft) : { phone: null, email: null };
  const clientValid = draft === null || (visibleErrors.phone === null && visibleErrors.email === null);
  const canSubmit =
    configured && description.trim().length > 0 && draft !== null && clientValid && projectHasPricedService(tasks);

  const submit = () => {
    if (!draft || !configured) return;
    // Reveal errors the user never triggered by leaving a field.
    const revealed = { ...draft, blurred: { phone: true, email: true } };
    setDraft(revealed);
    const revealedErrors = visibleClientDraftErrors(revealed);
    if (description.trim().length === 0 || revealedErrors.phone !== null || revealedErrors.email !== null) return;
    if (!projectHasPricedService(tasks)) return;
    onCreate(description.trim(), draft, tasks);
  };

  const onClientCreated = (contact: ZohoContact) => {
    setDraft(draftFromContact(contact, defaultId));
    setCreatingClient(false);
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        className={`bg-bambu-dark-secondary rounded-xl w-full border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)] animate-modal-in ${
          // The new-contact form is a short single-column form; at 1280px it
          // would sit marooned in whitespace. The width follows the mode, which
          // already changes the title too, so the resize reads as a mode switch
          // rather than a glitch.
          creatingClient ? 'max-w-md' : 'max-w-7xl'
        }`}
      >
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">
            {creatingClient ? t('aito.newClientTitle') : t('aito.modalTitle')}
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

        {creatingClient ? (
          <NewContactForm onCancel={() => setCreatingClient(false)} onCreated={onClientCreated} />
        ) : (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex flex-col flex-1 min-h-0"
          >
            <div className="p-4 overflow-y-auto flex-1 scrollbar-hide">
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] gap-4 lg:gap-6">
                <div className="space-y-4 min-w-0">
                  {draft && (
                    <ClientSection
                      value={draft}
                      onChange={setDraft}
                      onCreateNew={() => setCreatingClient(true)}
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

                <div className="min-w-0">
                  <TaskEditor
                    value={tasks}
                    onChange={setTasks}
                    onRemove={(index) => setTasks(tasks.filter((_, i) => i !== index))}
                    minRows={1}
                    // A project being created has no quote, so no step of it
                    // can be authorised work yet.
                    canTick={false}
                  />
                </div>
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
