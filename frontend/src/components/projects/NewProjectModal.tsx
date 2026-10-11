import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Button } from '../Button';
import { useToast } from '../../contexts/ToastContext';
import { AiTextField } from '../aito/AiTextField';
import { ProjectTagEditor, splitTagDrafts } from './ProjectTagEditor';
import type { TagDraft } from './ProjectTagChips';
import type { Project } from '../../api/client';
import { useIsolatedEscape } from '../../hooks/useIsolatedEscape';
import { DIALOG_CARD_CLS, OVERLAY_CLS } from './dialogStyles';
import { useInvalidateProjects } from './projectQueries';

/** What the modal sends to create a project. */
interface NewProjectPayload {
  name: string;
  description?: string;
  tag_ids: number[];
  new_tag_names: string[];
}

interface NewProjectModalProps<T> {
  onClose: () => void;
  initialTitle?: string;
  initialDescription?: string;
  /** Given: creates through this instead of `api.createProject` (an Aito task
   *  creates and links in one request, so a failed link leaves no project). */
  create?: (data: NewProjectPayload) => Promise<T>;
  /** Given: called with the result (the new project, or what `create`
   *  resolved to) instead of navigating to it (an Aito task links it and stays
   *  where it is). */
  onCreated?: (result: T) => void;
}

/** Create a project: title, description (both reworded in French on blur, with
 *  undo) and tags. No parent picker — sub-projects are not used (spec §0). */
export function NewProjectModal<T = Project>({
  onClose,
  initialTitle = '',
  initialDescription = '',
  create: createOverride,
  onCreated,
}: NewProjectModalProps<T>) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const invalidateProjects = useInvalidateProjects();
  const { showToast } = useToast();
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [tags, setTags] = useState<TagDraft[]>([]);
  const dialogRef = useRef<HTMLFormElement>(null);
  // Escape closes this modal only — it also opens over Aito's detail panel.
  useIsolatedEscape(onClose, dialogRef);

  const create = useMutation({
    mutationFn: (): Promise<T> => {
      const data = { name: title.trim(), description: description.trim() || undefined, ...splitTagDrafts(tags) };
      return createOverride ? createOverride(data) : (api.createProject(data) as Promise<unknown> as Promise<T>);
    },
    onSuccess: (result) => {
      invalidateProjects();
      onClose();
      if (onCreated) onCreated(result);
      else navigate(`/projects/${(result as Project).id}`);
    },
    onError: () => showToast(t('projectsPdm.saveFailed'), 'error'),
  });

  return (
    <div className={OVERLAY_CLS}>
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t('projectsPdm.createTitle')}
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) create.mutate();
        }}
        className={DIALOG_CARD_CLS}
      >
        <h2 className="text-lg font-semibold text-white">{t('projectsPdm.createTitle')}</h2>
        <AiTextField
          label={t('projectsPdm.titleLabel')}
          placeholder={t('projectsPdm.titleLabel')}
          value={title}
          onChange={setTitle}
          correct={(text) => api.reformulateProjectText(text, 'title')}
        />
        <AiTextField
          label={t('projectsPdm.descriptionLabel')}
          placeholder={t('projectsPdm.descriptionLabel')}
          value={description}
          onChange={setDescription}
          multiline
          rows={3}
          correct={(text) => api.reformulateProjectText(text, 'description')}
        />
        <ProjectTagEditor value={tags} onChange={setTags} title={title} description={description} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!title.trim() || create.isPending}>
            {t('projectsPdm.create')}
          </Button>
        </div>
      </form>
    </div>
  );
}
