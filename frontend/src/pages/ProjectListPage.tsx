import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FolderPlus, Plus } from 'lucide-react';
import { api } from '../api/client';
import { projectKeys } from '../components/projects/projectQueries';
import { Button } from '../components/Button';
import { useAuth } from '../contexts/AuthContext';
import { focusRingCls } from '../components/formStyles';
import { NewProjectModal } from '../components/projects/NewProjectModal';
import { CatalogPane } from '../components/projects/catalog/CatalogPane';
import { CatalogToolbar } from '../components/projects/catalog/CatalogToolbar';
import type { CatalogStatus } from '../components/projects/catalog/CatalogToolbar';
import { CatalogTree } from '../components/projects/catalog/CatalogTree';
import {
  applyFilters,
  buildTree,
  isFiltering,
  materialsOf,
  sortItems,
  visibleProjects,
  EMPTY_FILTERS,
} from '../components/projects/catalog/catalogRules';
import type { CatalogChip, CatalogFilters, CatalogSort } from '../components/projects/catalog/catalogRules';
import { useCatalogMutations, useProjectCatalog, useProjectFolders } from '../components/projects/catalog/useProjectCatalog';
import { useDebouncedValue } from '../hooks/useDebouncedValue';

const SORT_KEY = 'projects-catalog-sort';
const COLLAPSED_KEY = 'projects-catalog-collapsed';
const WIDE = '(min-width: 1024px)';

function readStored<T>(key: string, parse: (raw: string) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice lasts this visit.
  }
}

/** True from `lg` up: the pane sits beside the list; below, a row opens the project page. */
function useWide(): boolean {
  const [wide, setWide] = useState(() => (typeof window.matchMedia === 'function' ? window.matchMedia(WIDE).matches : true));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(WIDE);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return wide;
}

/** /projects — the catalog (design 2026-10-31): one search, folders on the left, the selected
 *  project's printing files on the right. `?q=` and `?project=` live in the URL. */
export function ProjectListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canUpdate = hasPermission('projects:update');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const selectedId = params.get('project') ? Number(params.get('project')) : null;
  const debounced = useDebouncedValue(q, 250);
  const [status, setStatus] = useState<CatalogStatus>('active');
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [filters, setFilters] = useState<CatalogFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<CatalogSort>(() => readStored(SORT_KEY, (r) => r as CatalogSort, 'activity'));
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set(readStored(COLLAPSED_KEY, (r) => JSON.parse(r) as number[], [])));
  const [creating, setCreating] = useState<{ parentId: number | null } | null>(null);
  // The folder a click just opened: its rows cascade in, then the mark is dropped.
  const [revealed, setRevealed] = useState<{ folderId: number; nonce: number } | null>(null);
  const [newProject, setNewProject] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const wide = useWide();

  const setParam = useCallback(
    (key: string, value: string | null) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const { data: tags = [] } = useQuery({ queryKey: projectKeys.projectTags(), queryFn: api.getProjectTags });
  const usedTags = tags.filter((tag) => tag.project_count > 0);
  const { data: items = [], isLoading } = useProjectCatalog({ q: debounced, status, tagIds });
  const { data: folders = [] } = useProjectFolders();
  const mutations = useCatalogMutations();

  const materials = useMemo(() => materialsOf(items), [items]);
  const shown = useMemo(() => sortItems(applyFilters(items, filters), sort), [items, filters, sort]);
  const filtering = isFiltering(q, filters) || tagIds.length > 0;
  const nodes = useMemo(
    () => (filtering ? shown.map((item) => ({ kind: 'project' as const, item, depth: 0 })) : buildTree(folders, shown, collapsed)),
    [filtering, shown, folders, collapsed],
  );
  const ordered = useMemo(() => visibleProjects(nodes), [nodes]);
  const selected = shown.find((item) => item.id === selectedId) ?? null;

  // On a wide screen a selection is always shown: the first visible project when none (or a
  // vanished one) is in the URL.
  useEffect(() => {
    if (!wide || ordered.length === 0 || isLoading) return;
    if (selectedId === null || !ordered.some((item) => item.id === selectedId)) setParam('project', String(ordered[0].id));
  }, [wide, ordered, selectedId, isLoading, setParam]);

  const select = (id: number) => {
    if (wide) setParam('project', String(id));
    else navigate(`/projects/${id}`);
  };
  const setFolderOpen = useCallback((id: number, open: boolean) => {
    setCollapsed((prev) => {
      if (prev.has(id) !== open) return prev;
      const next = new Set(prev);
      if (open) next.delete(id);
      else next.add(id);
      store(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
    if (open) setRevealed((r) => ({ folderId: id, nonce: (r?.nonce ?? 0) + 1 }));
  }, []);
  const toggleFolder = (id: number) => setFolderOpen(id, collapsed.has(id));
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => setRevealed(null), 400);
    return () => window.clearTimeout(timer);
  }, [revealed]);
  // The list fades on a change of view (a chip, the sort, the status, the search starting or
  // ending) — not on every keystroke of the search, whose results arrive debounced anyway.
  const viewKey = [filtering, sort, status, [...filters.chips].join(), [...filters.materials].join(), tagIds.join()].join('|');
  const toggleChip = (chip: CatalogChip) =>
    setFilters((f) => {
      const chips = new Set(f.chips);
      if (chips.has(chip)) chips.delete(chip);
      else chips.add(chip);
      return { ...f, chips };
    });
  const toggleMaterial = (m: string) =>
    setFilters((f) => {
      const mats = new Set(f.materials);
      if (mats.has(m)) mats.delete(m);
      else mats.add(m);
      return { ...f, materials: mats };
    });
  const changeSort = (next: CatalogSort) => {
    setSort(next);
    store(SORT_KEY, next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
    if (e.key === '/' && !typing) {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (e.key === 'Escape' && target === searchRef.current && q) {
      setParam('q', null);
      return;
    }
    if (typing && target !== searchRef.current) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (ordered.length === 0) return;
      const at = ordered.findIndex((item) => item.id === selectedId);
      const next = ordered[Math.min(ordered.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next && next.id !== selectedId) {
        e.preventDefault();
        setParam('project', String(next.id));
      }
    } else if (e.key === 'Enter' && selectedId !== null && !typing) {
      navigate(`/projects/${selectedId}`);
    } else if (e.key === 'Enter' && target === searchRef.current && selectedId !== null) {
      navigate(`/projects/${selectedId}`);
    }
  };

  return (
    <div className="space-y-4 p-4 md:p-6" onKeyDown={onKeyDown}>
      <div className="animate-rise-lg flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('projectsPdm.title')}</h1>
          <p className="text-sm text-bambu-gray">
            {t('projectsPdm.catalog.summary', { shown: shown.length, total: items.length })}
            {' · '}
            {t('projectsPdm.catalog.inProduction')}: {items.filter((i) => i.open_orders.length > 0).length}
            {' · '}
            {t('projectsPdm.catalog.readyToPrint')}: {items.filter((i) => i.recommended !== null).length}
          </p>
        </div>
        {hasPermission('projects:create') && (
          <Button onClick={() => setNewProject(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t('projectsPdm.newProject')}
          </Button>
        )}
      </div>

      <div className="animate-rise-lg [--enter-delay:80ms]">
      <CatalogToolbar
        searchRef={searchRef}
        q={q}
        onQChange={(next) => setParam('q', next)}
        filters={filters}
        onToggleChip={toggleChip}
        onToggleMaterial={toggleMaterial}
        materials={materials}
        sort={sort}
        onSortChange={changeSort}
        status={status}
        onStatusChange={setStatus}
        usedTags={usedTags}
        tagIds={tagIds}
        onToggleTag={(id) => setTagIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
      />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(320px,2fr)_3fr]">
        <section className="animate-rise-lg [--enter-delay:160ms] overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary">
          <div className="flex items-center justify-between gap-2 border-b border-bambu-dark-tertiary px-3 py-2 text-[11px] uppercase tracking-wide text-bambu-gray">
            <span>{t('projectsPdm.title')}</span>
            <span className="flex items-center gap-2 normal-case tracking-normal">
              <span className="hidden xl:inline" title={t('projectsPdm.catalog.dragHint')}>{t('projectsPdm.catalog.keyboardHelp')}</span>
              {canUpdate && (
                <button type="button" onClick={() => setCreating({ parentId: null })}
                  className={`btn-press flex items-center gap-1 rounded border border-bambu-dark-tertiary px-2 py-1 text-bambu-gray hover:text-white ${focusRingCls}`}>
                  <FolderPlus className="h-3.5 w-3.5" aria-hidden />{t('projectsPdm.catalog.newFolder')}
                </button>
              )}
            </span>
          </div>
          <div key={viewKey} className="animate-fade-in max-h-[72vh] overflow-y-auto">
            {!isLoading && nodes.length === 0 && !creating ? (
              <p className="px-3 py-8 text-center text-sm text-bambu-gray">{filtering ? t('projectsPdm.emptySearch') : t('projectsPdm.empty')}</p>
            ) : (
              <CatalogTree
                nodes={nodes}
                folders={folders}
                q={q}
                filtering={filtering}
                selectedId={wide ? selectedId : null}
                canUpdate={canUpdate}
                onSelect={select}
                onToggleFolder={toggleFolder}
                onSetFolderOpen={setFolderOpen}
                revealed={revealed}
                onMoveProject={(projectId, folderId) => mutations.moveProject.mutate({ projectId, folderId })}
                onCreateFolder={(name, parentId) => mutations.createFolder.mutateAsync({ name, parent_id: parentId })}
                onRenameFolder={(id, name) => mutations.updateFolder.mutateAsync({ id, name })}
                onDeleteFolder={(id) => mutations.deleteFolder.mutate(id)}
                onMoveFolder={(id, parentId) => mutations.updateFolder.mutate({ id, parent_id: parentId })}
                creating={creating}
                onCreatingChange={setCreating}
              />
            )}
          </div>
        </section>
        {wide && (
          <section className="animate-rise-lg [--enter-delay:240ms] min-h-[40vh] rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4">
            {selected ? (
              <CatalogPane key={selected.id} item={selected} folders={folders} />
            ) : (
              <p className="py-12 text-center text-sm text-bambu-gray">{t('projectsPdm.catalog.selectHint')}</p>
            )}
          </section>
        )}
      </div>

      {newProject && <NewProjectModal onClose={() => setNewProject(false)} />}
    </div>
  );
}
