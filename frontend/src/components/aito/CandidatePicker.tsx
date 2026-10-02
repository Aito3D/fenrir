import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import type { AitoProject } from '../../api/client';
import { CandidateList } from './CandidateList';

/** The search box over the scrolling radio list of other board cards — the
 *  merge dialog and the "move tasks" target step share it. Controlled: the
 *  caller keeps `query` and the selection, so they survive this picker being
 *  unmounted (the transfer dialog's Back step) exactly as before. `ariaLabel`
 *  names the radiogroup (the dialog's title). */
export function CandidatePicker({
  project,
  selectedId,
  onSelect,
  query,
  onQueryChange,
  ariaLabel,
}: {
  project: AitoProject;
  selectedId: number | null;
  onSelect: (id: number) => void;
  query: string;
  onQueryChange: (query: string) => void;
  ariaLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="px-6 pb-3">
        <label className="flex h-9 items-center gap-2 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark pl-3 pr-2 focus-within:border-bambu-green/50">
          <Search className="h-4 w-4 flex-none text-bambu-gray" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t('aito.mergeSearch')}
            aria-label={t('aito.mergeSearch')}
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-bambu-gray focus:outline-none"
          />
        </label>
      </div>
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className="min-h-0 flex-1 overflow-y-auto scrollbar-hide px-6 pb-2"
      >
        <CandidateList project={project} selectedId={selectedId} query={query} onSelect={onSelect} />
      </div>
    </>
  );
}
