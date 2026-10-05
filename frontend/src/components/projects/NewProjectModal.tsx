import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Button } from '../Button';
import { useToast } from '../../contexts/ToastContext';
import { AiTextField } from '../aito/AiTextField';
import { ProjectTagEditor, splitTagDrafts } from './ProjectTagEditor';
import type { TagDraft } from './ProjectTagChips';
import type { Project } from '../../api/client';

interface NewProjectModalProps {
  onClose: () => void;
  initialTitle?: string;
  initialDescription?: string;
  /** Given: called with the new project instead of navigating to it (an Aito
   *  task links it and stays where it is). */
  onCreated?: (project: Project) => void;
}

/** Create a project: title, description (both reworded in French on blur, with
 *  undo) and tags. No parent picker — sub-projects are not used (spec §0). */
export function NewProjectModal({ onClose, initialTitle = '', initialDescription = '', onCreated }: NewProjectModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [tags, setTags] = useState<TagDraft[]>([]);

  const create = useMutation({
    mutationFn: () =>
      api.createProject({ name: title.trim(), description: description.trim() || undefined, ...splitTagDrafts(tags) }),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects-search'] });
      queryClient.invalidateQueries({ queryKey: ['project-tags'] });
      onClose();
      if (onCreated) onCreated(project);
      else navigate(`/projects/${project.id}`);
    },
    onError: () => showToast(t('projectsPdm.saveFailed'), 'error'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-overlay-in">
      <form
        role="dialog"
        aria-label={t('projectsPdm.createTitle')}
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) create.mutate();
        }}
        className="w-full max-w-lg space-y-4 rounded-xl bg-bambu-card p-5"
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
