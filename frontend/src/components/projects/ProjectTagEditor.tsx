import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Sparkles } from 'lucide-react';
import { api, type ProjectTagSuggestion } from '../../api/client';
import { focusRingCls, inputCls } from '../formStyles';
import { ProjectTagChips, type TagDraft } from './ProjectTagChips';

const key = (name: string) => name.trim().toLowerCase();

/** Payload fields for a create/update from the editor's drafts. */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper beside the editor whose drafts it splits
export function splitTagDrafts(tags: TagDraft[]): { tag_ids: number[]; new_tag_names: string[] } {
  return {
    tag_ids: tags.filter((t) => t.id !== null).map((t) => t.id as number),
    new_tag_names: tags.filter((t) => t.id === null).map((t) => t.name),
  };
}

/** Pick tags from the shared catalogue, create new ones, or accept AI
 *  suggestions one chip at a time (spec §3.5: nothing is applied on its own). */
export function ProjectTagEditor({
  value,
  onChange,
  title,
  description,
}: {
  value: TagDraft[];
  onChange: (next: TagDraft[]) => void;
  title: string;
  description: string;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [draft, setDraft] = useState('');
  const { data: catalogue = [] } = useQuery({ queryKey: ['project-tags'], queryFn: api.getProjectTags });
  const suggest = useMutation({
    mutationFn: () =>
      api.suggestProjectTags(
        title.trim(),
        description.trim() || null,
        value.filter((tag) => tag.id !== null).map((tag) => tag.id as number),
      ),
  });

  const taken = new Set(value.map((tag) => key(tag.name)));
  const add = (tag: TagDraft) => {
    if (!tag.name.trim() || taken.has(key(tag.name))) return;
    onChange([...value, { id: tag.id, name: tag.name.trim() }]);
  };
  const matches = catalogue.filter((tag) => !taken.has(key(tag.name)) && key(tag.name).includes(key(draft)));

  const commitDraft = () => {
    const text = draft.replace(/,/g, ' ').trim();
    if (!text) return;
    const exact = catalogue.find((tag) => key(tag.name) === key(text));
    const prefix = matches.find((tag) => key(tag.name).startsWith(key(text)));
    const pick = exact ?? prefix;
    add(pick ? { id: pick.id, name: pick.name } : { id: null, name: text.slice(0, 64) });
    setDraft('');
  };

  const pending: ProjectTagSuggestion[] = (suggest.data?.suggestions ?? []).filter((s) => !taken.has(key(s.name)));

  return (
    <div className="space-y-2">
      <ProjectTagChips tags={value} onRemove={(index) => onChange(value.filter((_, i) => i !== index))} />
      <div className="flex flex-wrap gap-2">
        <input
          role="combobox"
          aria-expanded={draft.length > 0 && matches.length > 0}
          aria-controls={listId}
          aria-label={t('projectsPdm.tagsLabel')}
          list={listId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDraft();
            }
          }}
          placeholder={t('projectsPdm.tagSearchPlaceholder')}
          className={`${inputCls} min-w-[10rem] flex-1`}
        />
        <datalist id={listId}>
          {matches.slice(0, 20).map((tag) => (
            <option key={tag.id} value={tag.name} />
          ))}
        </datalist>
        <button
          type="button"
          onClick={() => suggest.mutate()}
          disabled={!title.trim() || suggest.isPending}
          className={`inline-flex shrink-0 items-center gap-1 rounded-lg border border-violet-400/35 px-3 text-sm text-violet-300 hover:border-violet-400 disabled:opacity-50 ${focusRingCls}`}
        >
          <Sparkles className={`h-3.5 w-3.5 ${suggest.isPending ? 'animate-pulse' : ''}`} aria-hidden="true" />
          {t('projectsPdm.suggestTags')}
        </button>
      </div>
      {suggest.isError && <p className="text-xs text-bambu-gray">{t('projectsPdm.aiUnavailable')}</p>}
      {suggest.isSuccess && pending.length === 0 && (
        <p className="text-xs text-bambu-gray">{t('projectsPdm.noSuggestions')}</p>
      )}
      {pending.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-bambu-gray">{t('projectsPdm.suggestionsLabel')}</span>
          {pending.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => add({ id: s.tag_id, name: s.name })}
              aria-label={t('projectsPdm.acceptSuggestion', { name: s.name })}
              className={`inline-flex items-center gap-1 rounded border border-dashed border-violet-400/50 px-2 py-0.5 text-xs text-violet-200 hover:border-violet-400 ${focusRingCls}`}
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              {s.name}
              {s.tag_id === null && (
                <span className="rounded bg-violet-400/20 px-1 text-[10px] uppercase">{t('projectsPdm.newTagBadge')}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
