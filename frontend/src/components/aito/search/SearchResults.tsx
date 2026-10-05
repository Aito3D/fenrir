import { FileText, Hash, ListChecks, Mail, Phone, User, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MatchKind, SearchHit } from '../../../utils/aitoSearch';
import { MAX_RESULTS } from './useSearchCombobox';
import type { TrashSearchState } from './AitoSearchContext';

const KIND_ICON: Record<MatchKind, LucideIcon> = {
  phone: Phone,
  email: Mail,
  number: Hash,
  name: User,
  text: FileText,
  task: ListChecks,
};

/** The dropdown under the search box: up to MAX_RESULTS ranked rows, each
 *  naming where the card lives and which field matched. Options keep focus
 *  in the input on mousedown so the click lands before the blur closes it. */
export function SearchResults({
  listboxId,
  hits,
  active,
  optionId,
  onPick,
  onHover,
  trash,
  className = '',
}: {
  listboxId: string;
  hits: SearchHit[];
  active: number;
  optionId: (index: number) => string;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  trash: TrashSearchState;
  className?: string;
}) {
  const { t } = useTranslation();
  const shown = hits.slice(0, MAX_RESULTS);
  const more = hits.length - shown.length;
  const location = (hit: SearchHit) =>
    hit.location === 'trash'
      ? t('aito.trash')
      : t(`aito.columns.${hit.location === 'done' ? 'done' : hit.project.column}`);

  return (
    <div
      className={`rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-xl overflow-hidden ${className}`}
    >
      <ul id={listboxId} role="listbox" aria-label={t('aito.searchPlaceholder')} className="max-h-[min(60vh,28rem)] overflow-y-auto py-1">
        {shown.map((hit, index) => {
          const Icon = KIND_ICON[hit.kind];
          return (
            <li
              key={hit.project.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(index)}
              onMouseMove={() => onHover(index)}
              className={`px-3 py-2 cursor-pointer max-md:py-3 ${index === active ? 'bg-bambu-dark-tertiary' : ''}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate text-sm text-white">{hit.project.description}</span>
                <span className="ml-auto flex-none rounded px-1.5 py-0.5 text-[11px] text-bambu-gray-light bg-bambu-dark">
                  {location(hit)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 min-w-0 text-xs text-bambu-gray">
                {hit.project.client_name && <span className="truncate flex-none max-w-[40%]">{hit.project.client_name}</span>}
                <span className="flex items-center gap-1 min-w-0">
                  <Icon className="w-3 h-3 flex-none" aria-hidden="true" />
                  <span className="flex-none">{t(`aito.smartSearch.fields.${hit.field}`)}</span>
                  <span className="truncate">
                    {hit.excerpt.before}
                    <mark className="bg-transparent text-bambu-green font-medium">{hit.excerpt.match}</mark>
                    {hit.excerpt.after}
                  </span>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {hits.length === 0 && trash !== 'loading' && (
        <div className="px-3 py-3 text-sm">
          <p className="text-white">{t('aito.smartSearch.noResults')}</p>
          <p className="text-xs text-bambu-gray">{t('aito.smartSearch.hint')}</p>
        </div>
      )}
      {more > 0 && <p className="px-3 py-1.5 text-xs text-bambu-gray border-t border-bambu-dark-tertiary">{t('aito.smartSearch.more', { count: more })}</p>}
      {trash !== 'ready' && (
        <p className="px-3 py-1.5 text-xs text-bambu-gray border-t border-bambu-dark-tertiary">
          {t(trash === 'loading' ? 'aito.smartSearch.searchingTrash' : 'aito.smartSearch.trashUnavailable')}
        </p>
      )}
    </div>
  );
}
