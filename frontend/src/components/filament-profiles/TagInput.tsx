import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

export interface TagInputProps {
  /** Comma-separated tag string — the same shape `compatible_printers` is
   *  stored in on the form (spec §7.1). */
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}

/**
 * Comma-string tag editor (spec §7.1's compatible-printers control): type +
 * Enter adds a trimmed, deduped tag; Backspace on an empty draft removes the
 * last tag; blur commits whatever is still in the draft; each tag carries
 * its own × button.
 */
export function TagInput({ value, onChange, placeholder }: TagInputProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const tags = value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '' || tags.includes(trimmed)) return;
    onChange([...tags, trimmed].join(', '));
  };

  const removeAt = (index: number) => {
    onChange(tags.filter((_, i) => i !== index).join(', '));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(draft);
      setDraft('');
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      removeAt(tags.length - 1);
    }
  };

  const handleBlur = () => {
    if (draft.trim() !== '') commit(draft);
    setDraft('');
  };

  return (
    <div className="flex min-h-[2.5rem] flex-wrap items-center gap-1.5 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1.5 focus-within:border-bambu-green">
      {tags.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          className="flex items-center gap-1 rounded bg-bambu-dark-tertiary px-2 py-1 text-xs text-white"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeAt(i)}
            aria-label={t('filamentProfiles.removeTag', { tag })}
            className="text-bambu-gray/70 hover:text-white"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        aria-label={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={tags.length === 0 ? placeholder : ''}
        className="min-w-[8rem] flex-1 border-none bg-transparent text-sm text-white placeholder-bambu-gray/50 focus:outline-none"
      />
    </div>
  );
}
