import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '../../../api/client';
import { ProjectCodeChip } from '../ProjectCodeChip';
import { focusRingCls } from '../../formStyles';

const REASON_KEYS = {
  same_client: 'projectsPdm.aito.suggestionSameClient',
  similar_title: 'projectsPdm.aito.suggestionSimilar',
} as const;

interface Option {
  id: number;
  code: string | null;
  name: string;
  reason?: keyof typeof REASON_KEYS;
}

/** Pick an existing project for a task: the likely matches first (same client,
 *  then similar title), then a free search. Escape closes it without reaching
 *  the detail panel's own window-level Escape. */
export function ProjectLinkPicker({
  taskId,
  onPick,
  onClose,
  disabled = false,
}: {
  taskId: number;
  onPick: (projectId: number) => void;
  onClose: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(id);
  }, [q]);

  const { data: suggestions = [] } = useQuery({
    queryKey: ['aito-project-suggestions', taskId],
    queryFn: () => api.getTaskProjectSuggestions(taskId),
    retry: false,
  });
  const { data: search, isFetching } = useQuery({
    queryKey: ['projects-search', 'aito-link', debounced],
    queryFn: () => api.searchProjects({ q: debounced, limit: 10 }),
    enabled: debounced !== '',
    retry: false,
  });

  const suggested = new Set(suggestions.map((s) => s.id));
  const options: Option[] = [
    ...suggestions,
    ...(debounced ? (search?.items ?? []).filter((p) => !suggested.has(p.id)) : []),
  ];

  return (
    <div
      className="mt-2 space-y-2 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-2"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <label className="flex items-center gap-2 rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-1">
        <Search aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0 text-bambu-gray" />
        <input
          type="search"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('projectsPdm.aito.searchProjects')}
          aria-label={t('projectsPdm.aito.searchProjects')}
          className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-bambu-gray focus:outline-none"
        />
      </label>
      {options.length > 0 ? (
        <ul className="max-h-60 space-y-0.5 overflow-y-auto">
          {options.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(p.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 disabled:opacity-50 ${focusRingCls}`}
              >
                <ProjectCodeChip code={p.code} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.reason && (
                  <span className="flex-shrink-0 text-xs text-bambu-gray">{t(REASON_KEYS[p.reason])}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        debounced !== '' &&
        !isFetching && <p className="px-2 py-1 text-xs text-bambu-gray">{t('projectsPdm.aito.noProjectsFound')}</p>
      )}
    </div>
  );
}
