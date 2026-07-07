import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag as TagIcon, X } from 'lucide-react';
import type { LibraryTag } from '../api/client';

/** How many chips render before the rail collapses behind "+N more". Active
 * chips always sort first, so an active filter is never hidden. */
const COLLAPSED_LIMIT = 12;

interface TagFilterRailProps {
  tags: LibraryTag[];
  selectedTagIds: number[];
  onToggle: (tagId: number) => void;
  onClearAll: () => void;
}

/** Tag filter rail for the File Manager (#1268 follow-up).
 *
 * Lists every catalog tag as a togglable chip — active chips are filled
 * green and show an X, inactive chips are outlined with the tag's file
 * count and toggle ON when clicked. Multi-select is AND semantics (the
 * server intersects); the rail hides itself when the catalog is empty so
 * brand-new installs don't see a stray bar.
 */
export function TagFilterRail({ tags, selectedTagIds, onToggle, onClearAll }: TagFilterRailProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const selected = useMemo(() => new Set(selectedTagIds), [selectedTagIds]);

  const sorted = useMemo(() => {
    // Active first (so they never collapse), then by usage, then name.
    return [...tags].sort((a, b) => {
      const aActive = selected.has(a.id) ? 0 : 1;
      const bActive = selected.has(b.id) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      if (a.file_count !== b.file_count) return b.file_count - a.file_count;
      return a.name.localeCompare(b.name);
    });
  }, [tags, selected]);

  if (tags.length === 0) return null;

  const hiddenCount = sorted.length - COLLAPSED_LIMIT;
  const visible = expanded || hiddenCount <= 0 ? sorted : sorted.slice(0, COLLAPSED_LIMIT);
  const hasActive = selectedTagIds.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-4" data-testid="tag-filter-rail">
      <span className="flex items-center gap-1 text-xs text-bambu-gray mr-0.5">
        <TagIcon className="w-3.5 h-3.5" />
        {hasActive && t('fileManager.tags.filterLabel')}
      </span>
      {visible.map((tag) => {
        const active = selected.has(tag.id);
        return (
          <button
            key={tag.id}
            type="button"
            onClick={() => onToggle(tag.id)}
            aria-pressed={active}
            title={tag.name}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors max-w-[12rem] ${
              active
                ? 'bg-bambu-green/15 text-bambu-green border-bambu-green/40 hover:bg-bambu-green/25'
                : 'text-bambu-gray border-bambu-dark-tertiary hover:text-white hover:border-bambu-green/50'
            }`}
          >
            <span className="truncate">{tag.name}</span>
            {active ? (
              <X className="w-3 h-3 flex-shrink-0 opacity-70" />
            ) : (
              <span className="text-[10px] opacity-60 flex-shrink-0">{tag.file_count}</span>
            )}
          </button>
        );
      })}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-bambu-gray hover:text-white px-1.5 py-0.5 transition-colors"
        >
          {expanded ? t('fileManager.tags.showLess') : t('fileManager.tags.showMore', { count: hiddenCount })}
        </button>
      )}
      {hasActive && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs text-bambu-gray hover:text-white underline underline-offset-2 px-1.5 py-0.5 transition-colors"
        >
          {t('fileManager.tags.clearAll')}
        </button>
      )}
    </div>
  );
}
