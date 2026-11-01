import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Upload, Image as ImageIcon, X } from 'lucide-react';
import { api } from '../../api/client';
import type { ProjectListItem, ProjectCreate, ProjectUpdate } from '../../api/client';
import { Button } from '../Button';
import { eligibleParents } from '../../utils/projectTree';

const PROJECT_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#6b7280', // gray
];

type TFunction = (key: string, options?: Record<string, unknown>) => string;

interface ProjectModalProps {
  project?: ProjectListItem;
  onClose: () => void;
  onSave: (data: ProjectCreate | ProjectUpdate) => void;
  isLoading: boolean;
  currencySymbol: string;
  t: TFunction;
  // Fenrir projects as a PDM: header owns tags, no sub-projects.
  pdm?: boolean;
}

export function ProjectModal({ project, onClose, onSave, isLoading, currencySymbol, t, pdm = false }: ProjectModalProps) {
  const [name, setName] = useState(project?.name || '');
  const [description, setDescription] = useState(project?.description || '');
  const [color, setColor] = useState(project?.color || PROJECT_COLORS[0]);
  const [targetCount, setTargetCount] = useState(project?.target_count?.toString() || '');
  const [targetPartsCount, setTargetPartsCount] = useState(project?.target_parts_count?.toString() || '');
  const [targetSets, setTargetSets] = useState(project?.target_sets?.toString() || '');
  const [status, setStatus] = useState(project?.status || 'active');
  const [tags, setTags] = useState(project?.tags || '');
  const [dueDate, setDueDate] = useState(project?.due_date?.split('T')[0] || '');
  const [priority, setPriority] = useState(project?.priority || 'normal');
  const [budget, setBudget] = useState(project?.budget?.toString() || '');
  const [url, setUrl] = useState(project?.url || '');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [parentId, setParentId] = useState<number | null>(project?.parent_id ?? null);
  const queryClient = useQueryClient();

  // Unfiltered on purpose: a completed or archived project is still a legal
  // parent, and the picker offering fewer options than the list does would be
  // hard to explain.
  const { data: allProjects } = useQuery({
    queryKey: ['projects', undefined],
    queryFn: () => api.getProjects(),
  });
  const parentOptions = eligibleParents(allProjects || [], project?.id);
  const [coverImageFilename, setCoverImageFilename] = useState(project?.cover_image_filename || null);
  const coverFileInputRef = useRef<HTMLInputElement>(null);
  const [coverUploading, setCoverUploading] = useState(false);
  // Cache-bust the cover image URL when it changes mid-edit so the preview
  // refreshes after upload/remove.
  const [coverCacheKey, setCoverCacheKey] = useState(0);

  const handleCoverFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !project) return;
    setCoverUploading(true);
    try {
      const result = await api.uploadProjectCoverImage(project.id, file);
      setCoverImageFilename(result.filename);
      setCoverCacheKey((k) => k + 1);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    } catch {
      // Upload failed — leave existing cover image in place.
    } finally {
      setCoverUploading(false);
      if (coverFileInputRef.current) coverFileInputRef.current.value = '';
    }
  };

  const handleRemoveCover = async () => {
    if (!project) return;
    setCoverUploading(true);
    try {
      await api.deleteProjectCoverImage(project.id);
      setCoverImageFilename(null);
      setCoverCacheKey((k) => k + 1);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    } finally {
      setCoverUploading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedUrl = url.trim();
    if (trimmedUrl && !/^https?:\/\//i.test(trimmedUrl)) {
      setUrlError(t('projects.urlInvalid'));
      return;
    }
    setUrlError(null);
    onSave({
      name: name.trim(),
      description: description.trim() || undefined,
      color,
      target_count: targetCount ? parseInt(targetCount, 10) : undefined,
      target_parts_count: targetPartsCount ? parseInt(targetPartsCount, 10) : undefined,
      // Null clears the copies-per-file target on edit (#1897); undefined omits on create.
      target_sets: project ? (targetSets ? parseInt(targetSets, 10) : null) : (targetSets ? parseInt(targetSets, 10) : undefined),
      // Null clears the stored value on edit; undefined omits the key on create.
      // Sending undefined on edit would make an emptied field un-clearable.
      ...(!pdm && { tags: project ? (tags.trim() || null) : (tags.trim() || undefined) }),
      due_date: project ? (dueDate || null) : (dueDate || undefined),
      priority,
      budget: budget.trim() ? parseFloat(budget) : null,
      // Pydantic accepts null to clear the URL; an empty string would fail the
      // http(s) prefix validator.
      url: project ? (trimmedUrl || null) : (trimmedUrl || undefined),
      // The API reads 0 as "remove the parent" — null would be indistinguishable
      // from the field having been omitted (#1264).
      ...(!pdm && { parent_id: project ? (parentId ?? 0) : (parentId ?? undefined) }),
      ...(project && { status }),
    });
  };

  return (
    // max-h + flex column on the card + overflow on the fields wrapper so the
    // modal stays inside the viewport on short screens (#1642). Outer p-4 is
    // 1rem each side, hence the 2rem subtraction below.
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in">
      <div className="bg-bambu-dark-secondary rounded-lg w-full max-w-md border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)] animate-modal-in">
        <div className="p-4 border-b border-bambu-dark-tertiary flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">
            {project ? t('projects.editProject') : t('projects.newProject')}
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="p-4 space-y-4 overflow-y-auto flex-1">
          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('common.name')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
              placeholder={t('projects.namePlaceholder')}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('common.description')}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green resize-none"
              placeholder={t('projects.descriptionPlaceholder')}
              rows={2}
            />
          </div>

          {/* #1155: External URL */}
          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('projects.urlLabel')}
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); if (urlError) setUrlError(null); }}
              className={`w-full bg-bambu-dark border rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none ${
                urlError ? 'border-red-500 focus:border-red-500' : 'border-bambu-dark-tertiary focus:border-bambu-green'
              }`}
              placeholder={t('projects.urlPlaceholder')}
              maxLength={2048}
            />
            {urlError && <p className="text-xs text-red-600 dark:text-red-400 mt-1">{urlError}</p>}
          </div>

          {/* #1264: Nest this project under another one */}
          {!pdm && (
            <div>
              <label className="block text-sm font-medium text-white mb-1">
                {t('projects.parentLabel')}
              </label>
              <select
                value={parentId ?? ''}
                onChange={(e) => setParentId(e.target.value ? parseInt(e.target.value, 10) : null)}
                className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white focus:outline-none focus:border-bambu-green"
              >
                <option value="">{t('projects.parentNone')}</option>
                {parentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-bambu-gray mt-1">{t('projects.parentHint')}</p>
            </div>
          )}

          {/* #1155: Cover image — only available when editing an existing project,
              since uploading needs a project_id. New projects can add it after save. */}
          {project && (
            <div>
              <label className="block text-sm font-medium text-white mb-1">
                {t('projects.coverImageLabel')}
              </label>
              <div className="flex items-center gap-3">
                <div className="w-20 h-20 rounded bg-bambu-dark border border-bambu-dark-tertiary overflow-hidden flex items-center justify-center flex-shrink-0">
                  {coverImageFilename ? (
                    <img
                      src={api.getProjectCoverImageUrl(project.id, coverCacheKey)}
                      alt={t('projects.coverImageAlt')}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <ImageIcon className="w-6 h-6 text-bambu-gray" />
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <input
                    ref={coverFileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    onChange={handleCoverFileChange}
                    className="hidden"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => coverFileInputRef.current?.click()}
                    disabled={coverUploading}
                  >
                    {coverUploading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4 mr-1" />
                    )}
                    {coverImageFilename ? t('projects.coverImageReplace') : t('projects.coverImageUpload')}
                  </Button>
                  {coverImageFilename && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={handleRemoveCover}
                      disabled={coverUploading}
                    >
                      <X className="w-4 h-4 mr-1" />
                      {t('projects.coverImageRemove')}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('projects.color')}
            </label>
            <div className="flex gap-2 flex-wrap">
              {PROJECT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-8 h-8 rounded-full transition-transform ${
                    color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-bambu-dark-secondary scale-110' : ''
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          {/* Target Counts - Plates and Parts side by side */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-white mb-1">
                {t('projects.targetPlates')}
              </label>
              <input
                type="number"
                value={targetCount}
                onChange={(e) => setTargetCount(e.target.value)}
                className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
                placeholder={t('projects.targetPlatesPlaceholder')}
                min="1"
              />
              <p className="text-xs text-bambu-gray mt-1">{t('projects.targetPlatesHelp')}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-white mb-1">
                {t('projects.targetParts')}
              </label>
              <input
                type="number"
                value={targetPartsCount}
                onChange={(e) => setTargetPartsCount(e.target.value)}
                className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
                placeholder={t('projects.targetPartsPlaceholder')}
                min="1"
              />
              <p className="text-xs text-bambu-gray mt-1">{t('projects.targetPartsHelp')}</p>
            </div>
          </div>

          {/* Copies-per-file target (#1897) */}
          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('projects.targetSets')}
            </label>
            <input
              type="number"
              value={targetSets}
              onChange={(e) => setTargetSets(e.target.value)}
              className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
              placeholder={t('projects.targetSetsPlaceholder')}
              min="1"
            />
            <p className="text-xs text-bambu-gray mt-1">{t('projects.targetSetsHelp')}</p>
          </div>

          {/* Tags */}
          {!pdm && (
            <div>
              <label className="block text-sm font-medium text-white mb-1">
                {t('projects.tagsLabel')}
              </label>
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
                placeholder={t('projects.tagsPlaceholder')}
              />
            </div>
          )}

          {/* Due Date and Priority in a row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-white mb-1">
                {t('projects.dueDate')}
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white focus:outline-none focus:border-bambu-green"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-white mb-1">
                {t('projects.priority')}
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white focus:outline-none focus:border-bambu-green"
              >
                <option value="low">{t('projects.priorityLow')}</option>
                <option value="normal">{t('projects.priorityNormal')}</option>
                <option value="high">{t('projects.priorityHigh')}</option>
                <option value="urgent">{t('projects.priorityUrgent')}</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-white mb-1">
              {t('projectDetail.cost.budget')}
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-bambu-gray pointer-events-none">
                {currencySymbol}
              </span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded pl-8 pr-3 py-2 text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
                placeholder="0.00"
              />
            </div>
          </div>

          {project && (
            <div>
              <label className="block text-sm font-medium text-white mb-1">
                {t('common.status')}
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded px-3 py-2 text-white focus:outline-none focus:border-bambu-green"
              >
                <option value="active">{t('projects.statusActive')}</option>
                <option value="completed">{t('projects.statusCompleted')}</option>
                <option value="archived">{t('projects.statusArchived')}</option>
              </select>
            </div>
          )}
          </div>

          {/* Sticky action footer — stays visible regardless of scroll
              position so Save/Cancel are always reachable on short screens
              (#1642). Buttons stay inside <form> for type="submit". */}
          <div className="flex justify-end gap-2 p-4 border-t border-bambu-dark-tertiary flex-shrink-0">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || isLoading}>
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : project ? (
                t('common.save')
              ) : (
                t('projects.create')
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
