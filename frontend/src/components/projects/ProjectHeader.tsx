import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { api, type Project } from '../../api/client';
import { Button } from '../Button';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { focusRingCls } from '../formStyles';
import { AiTextField } from '../aito/AiTextField';
import { ProjectCodeChip } from './ProjectCodeChip';
import { ProjectTagChips, type TagDraft } from './ProjectTagChips';
import { ProjectTagEditor, splitTagDrafts } from './ProjectTagEditor';

/** Code chip, title, description and tags, edited in place (spec §3.2).
 *  The title and description are reworded in French when the field is left,
 *  with an undo; tags come from the shared catalogue or AI suggestions. */
export function ProjectHeader({ project }: { project: Project }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [tags, setTags] = useState<TagDraft[]>(project.tag_list ?? []);

  const startEdit = () => {
    setTitle(project.name);
    setDescription(project.description ?? '');
    setTags(project.tag_list ?? []);
    setEditing(true);
  };

  const save = useMutation({
    mutationFn: () =>
      api.updateProject(project.id, {
        name: title.trim(),
        description: description.trim() || null,
        ...splitTagDrafts(tags),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', project.id] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects-search'] });
      queryClient.invalidateQueries({ queryKey: ['project-tags'] });
      showToast(t('projectsPdm.saved'), 'success');
      setEditing(false);
    },
    onError: () => showToast(t('projectsPdm.saveFailed'), 'error'),
  });

  if (!editing) {
    return (
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-3">
          <ProjectCodeChip code={project.code} className="text-sm" />
          <h1 className="truncate text-2xl font-bold text-white">{project.name}</h1>
          {hasPermission('projects:update') && (
            <button
              type="button"
              onClick={startEdit}
              aria-label={t('projectsPdm.editHeader')}
              title={t('projectsPdm.editHeader')}
              className={`rounded p-1 text-bambu-gray hover:text-white ${focusRingCls}`}
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
        </div>
        {project.description && <p className="text-bambu-gray">{project.description}</p>}
        <ProjectTagChips tags={project.tag_list ?? []} />
      </div>
    );
  }

  return (
    <form
      className="w-full max-w-2xl space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) save.mutate();
      }}
    >
      <div className="flex items-center gap-3">
        <ProjectCodeChip code={project.code} className="text-sm" />
        <AiTextField
          label={t('projectsPdm.titleLabel')}
          value={title}
          onChange={setTitle}
          className="flex-1"
          correct={(text) => api.reformulateProjectText(text, 'title')}
        />
      </div>
      <AiTextField
        label={t('projectsPdm.descriptionLabel')}
        value={description}
        onChange={setDescription}
        multiline
        rows={3}
        correct={(text) => api.reformulateProjectText(text, 'description')}
      />
      <ProjectTagEditor value={tags} onChange={setTags} title={title} description={description} />
      <div className="flex gap-2">
        <Button type="submit" disabled={!title.trim() || save.isPending}>
          {t('projectsPdm.save')}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
