import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { focusRingCls } from '../formStyles';

export interface TagDraft {
  /** null = a new tag, created when the project is saved. */
  id: number | null;
  name: string;
}

/** Tag chips. Read-only unless `onRemove` is given; then each chip is a button. */
export function ProjectTagChips({ tags, onRemove }: { tags: TagDraft[]; onRemove?: (index: number) => void }) {
  const { t } = useTranslation();
  if (tags.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1">
      {tags.map((tag, index) => (
        <li key={`${tag.id ?? 'new'}-${tag.name}`}>
          {onRemove ? (
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={t('projectsPdm.removeTag', { name: tag.name })}
              className={`inline-flex items-center gap-1 rounded bg-bambu-dark-tertiary px-2 py-0.5 text-xs text-white hover:bg-bambu-dark-secondary ${focusRingCls}`}
            >
              {tag.name}
              <X className="h-3 w-3 text-bambu-gray" aria-hidden="true" />
            </button>
          ) : (
            <span className="inline-block rounded bg-bambu-dark-tertiary px-2 py-0.5 text-xs text-bambu-gray">
              {tag.name}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
