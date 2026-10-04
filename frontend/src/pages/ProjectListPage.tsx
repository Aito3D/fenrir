import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, LayoutGrid, List, Plus, Search } from 'lucide-react';
import { api, type ProjectSearchItem } from '../api/client';
import { Button } from '../components/Button';
import { useAuth } from '../contexts/AuthContext';
import { focusRingCls, inputCls } from '../components/formStyles';
import { ProjectCodeChip } from '../components/projects/ProjectCodeChip';
import { ProjectTagChips } from '../components/projects/ProjectTagChips';
import { NewProjectModal } from '../components/projects/NewProjectModal';
import { formatDateOnly } from '../utils/date';

const PAGE_SIZE = 50;
const STATUSES = ['active', 'completed', 'archived', 'all'] as const;
type View = 'table' | 'grid';

function readView(): View {
  try {
    return localStorage.getItem('projects-view') === 'grid' ? 'grid' : 'table';
  } catch {
    return 'table';
  }
}

/** /projects — the structured entry point to every part the shop makes (spec §3.1). */
export function ProjectListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('active');
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [tagMode, setTagMode] = useState<'any' | 'all'>('any');
  const [page, setPage] = useState(0);
  const [view, setView] = useState<View>(readView);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term), 250);
    return () => clearTimeout(timer);
  }, [term]);
  useEffect(() => setPage(0), [debounced, status, tagIds, tagMode]);

  const changeView = (next: View) => {
    setView(next);
    try {
      localStorage.setItem('projects-view', next);
    } catch {
      // Private mode: the toggle still works for this visit.
    }
  };

  const { data: tags = [] } = useQuery({ queryKey: ['project-tags'], queryFn: api.getProjectTags });
  const usedTags = tags.filter((tag) => tag.project_count > 0);

  const { data, isLoading } = useQuery({
    queryKey: ['projects-search', debounced, status, tagIds, tagMode, page],
    queryFn: () =>
      api.searchProjects({
        q: debounced,
        status,
        tagIds,
        tagMode,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const toggleTag = (id: number) =>
    setTagIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  const open = (project: ProjectSearchItem) => navigate(`/projects/${project.id}`);

  return (
    <div className="space-y-6 p-4 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('projectsPdm.title')}</h1>
          <p className="text-bambu-gray">{t('projectsPdm.subtitle')}</p>
        </div>
        {hasPermission('projects:create') && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t('projectsPdm.newProject')}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[16rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray" />
          <input
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={t('projectsPdm.searchPlaceholder')}
            aria-label={t('projectsPdm.searchPlaceholder')}
            className={`${inputCls} pl-9`}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-bambu-gray">
          {t('projectsPdm.statusFilterLabel')}
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])}
            className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-2 text-white"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? t('projectsPdm.statusAll') : t(`projectDetail.status.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex rounded-lg border border-bambu-dark-tertiary">
          <button
            type="button"
            aria-label={t('projectsPdm.viewTable')}
            aria-pressed={view === 'table'}
            onClick={() => changeView('table')}
            className={`p-2 ${view === 'table' ? 'text-white' : 'text-bambu-gray'} ${focusRingCls}`}
          >
            <List className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t('projectsPdm.viewGrid')}
            aria-pressed={view === 'grid'}
            onClick={() => changeView('grid')}
            className={`p-2 ${view === 'grid' ? 'text-white' : 'text-bambu-gray'} ${focusRingCls}`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
        </div>
      </div>

      {usedTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-bambu-gray">{t('projectsPdm.tagsFilterLabel')}</span>
          {usedTags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              aria-pressed={tagIds.includes(tag.id)}
              onClick={() => toggleTag(tag.id)}
              className={`rounded px-2 py-0.5 text-xs ${
                tagIds.includes(tag.id) ? 'bg-bambu-green text-white' : 'bg-bambu-dark-tertiary text-bambu-gray'
              } ${focusRingCls}`}
            >
              {tag.name}
            </button>
          ))}
          {tagIds.length > 1 && (
            <select
              value={tagMode}
              onChange={(e) => setTagMode(e.target.value as 'any' | 'all')}
              aria-label={t('projectsPdm.tagsFilterLabel')}
              className="rounded border border-bambu-dark-tertiary bg-bambu-dark px-2 py-0.5 text-xs text-white"
            >
              <option value="any">{t('projectsPdm.tagModeAny')}</option>
              <option value="all">{t('projectsPdm.tagModeAll')}</option>
            </select>
          )}
        </div>
      )}

      {!isLoading && items.length === 0 && (
        <p className="py-12 text-center text-bambu-gray">
          {debounced || tagIds.length ? t('projectsPdm.emptySearch') : t('projectsPdm.empty')}
        </p>
      )}

      {items.length > 0 && view === 'table' && (
        <div className="overflow-x-auto rounded-xl bg-bambu-card">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-bambu-gray">
              <tr>
                <th className="px-4 py-3">{t('projectsPdm.colCode')}</th>
                <th className="px-4 py-3">{t('projectsPdm.colTitle')}</th>
                <th className="px-4 py-3">{t('projectsPdm.colTags')}</th>
                <th className="px-4 py-3">{t('projectsPdm.colStatus')}</th>
                <th className="px-4 py-3 text-right">{t('projectsPdm.colPrints')}</th>
                <th className="px-4 py-3">{t('projectsPdm.colUpdated')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((project) => (
                <tr
                  key={project.id}
                  onClick={() => open(project)}
                  className="cursor-pointer border-t border-bambu-dark-tertiary hover:bg-bambu-dark-secondary"
                >
                  <td className="px-4 py-3">
                    <ProjectCodeChip code={project.code} />
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      to={`/projects/${project.id}`}
                      className={`rounded font-medium text-white hover:underline ${focusRingCls}`}
                    >
                      {project.name}
                    </Link>
                    {project.description && (
                      <div className="line-clamp-1 text-xs text-bambu-gray">{project.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <ProjectTagChips tags={project.tags} />
                  </td>
                  <td className="px-4 py-3 text-bambu-gray">{t(`projectDetail.status.${project.status}`)}</td>
                  <td className="px-4 py-3 text-right text-white">{project.archive_count}</td>
                  <td className="px-4 py-3 text-bambu-gray">{formatDateOnly(project.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {items.length > 0 && view === 'grid' && (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                onClick={() => open(project)}
                className={`flex h-full w-full flex-col gap-2 rounded-xl bg-bambu-card p-4 text-left hover:bg-bambu-dark-secondary ${focusRingCls}`}
              >
                {project.cover_image_filename && (
                  <img
                    src={api.getProjectCoverImageUrl(project.id)}
                    alt=""
                    className="h-32 w-full rounded-lg object-cover"
                    loading="lazy"
                  />
                )}
                <div className="flex items-center gap-2">
                  <ProjectCodeChip code={project.code} />
                  <span className="truncate font-medium text-white">{project.name}</span>
                </div>
                {project.description && <p className="line-clamp-2 text-sm text-bambu-gray">{project.description}</p>}
                <ProjectTagChips tags={project.tags} />
                <div className="mt-auto flex justify-between text-xs text-bambu-gray">
                  <span>{t(`projectDetail.status.${project.status}`)}</span>
                  <span>
                    {t('projectsPdm.colPrints')}: {project.archive_count}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-3 text-sm text-bambu-gray">
          <span>
            {t('projectsPdm.pageRange', {
              from: page * PAGE_SIZE + 1,
              to: Math.min(total, (page + 1) * PAGE_SIZE),
              total,
            })}
          </span>
          <button
            type="button"
            aria-label={t('projectsPdm.prevPage')}
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            className={`rounded p-1 disabled:opacity-40 ${focusRingCls}`}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t('projectsPdm.nextPage')}
            disabled={(page + 1) * PAGE_SIZE >= total}
            onClick={() => setPage((p) => p + 1)}
            className={`rounded p-1 disabled:opacity-40 ${focusRingCls}`}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </div>
  );
}
