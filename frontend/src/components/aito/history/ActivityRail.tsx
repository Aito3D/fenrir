import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { EventItem } from './EventItem';
import { useProjectEvents } from '../../../hooks/useProjectEvents';
import { api, type AitoEvent, type AitoEventPage, type AitoHistoryDepth } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { nextPlaceholderId } from '../../../utils/aitoOptimistic';

const DEPTH_STORAGE_KEY = 'aito.history.depth';

// Explicit map rather than a template literal key: the i18n gate scans for
// literal t('...') calls, and a dynamic key is invisible to it.
const DEPTH_LABEL_KEY: Record<AitoHistoryDepth, string> = {
  story: 'aito.history.depthStory',
  detail: 'aito.history.depthDetail',
  everything: 'aito.history.depthEverything',
};
const DEPTHS: AitoHistoryDepth[] = ['story', 'detail', 'everything'];

function initialDepth(): AitoHistoryDepth {
  try {
    const stored = localStorage.getItem(DEPTH_STORAGE_KEY);
    if (stored === 'story' || stored === 'detail' || stored === 'everything') return stored;
  } catch {
    // Private mode, or storage disabled. The default is fine.
  }
  return 'detail';
}

/** The project's timeline: a depth control, a note box, and the events.
 *
 *  Depth is a genuine refetch rather than a client-side filter — the server
 *  owns the kind-to-depth registry, so the three levels are different result
 *  sets and paging them separately is what keeps the cursor honest. */
export function ActivityRail({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [depth, setDepth] = useState<AitoHistoryDepth>(initialDepth);
  const [note, setNote] = useState('');

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useProjectEvents(projectId, depth);

  const addNote = useMutation({
    mutationFn: ({ body }: { body: string; optimistic: AitoEvent }) => api.addAitoNote(projectId, body),
    // Prepends into the FIRST page only. The list runs newest-first and the
    // cursor keysets on (occurred_at, id), so a row at the head cannot shift
    // any page boundary — an optimistic note is invisible to paging.
    onMutate: ({ optimistic }) => {
      setNote('');
      queryClient.setQueryData<{ pages: AitoEventPage[]; pageParams: unknown[] }>(
        ['aito-events', projectId, depth],
        (prev) =>
          prev
            ? {
                ...prev,
                pages: [
                  { ...prev.pages[0], events: [optimistic, ...prev.pages[0].events] },
                  ...prev.pages.slice(1),
                ],
              }
            : prev,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['aito-events', projectId] });
    },
    onError: (_error, { body, optimistic }) => {
      queryClient.setQueryData<{ pages: AitoEventPage[]; pageParams: unknown[] }>(
        ['aito-events', projectId, depth],
        (prev) =>
          prev
            ? {
                ...prev,
                pages: prev.pages.map((page) => ({
                  ...page,
                  events: page.events.filter((event) => event.id !== optimistic.id),
                })),
              }
            : prev,
      );
      // Put the text back rather than making the user retype it.
      setNote(body);
      showToast(t('aito.history.noteFailed'), 'error');
    },
  });

  const chooseDepth = (next: AitoHistoryDepth) => {
    setDepth(next);
    try {
      localStorage.setItem(DEPTH_STORAGE_KEY, next);
    } catch {
      // Not worth surfacing — the choice simply will not persist.
    }
  };

  const events = data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <section aria-label={t('aito.history.title')} className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-bambu-gray mb-2">{t('aito.history.title')}</p>

      <div className="inline-flex rounded-lg border border-bambu-dark-tertiary overflow-hidden mb-3">
        {DEPTHS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={depth === option}
            onClick={() => chooseDepth(option)}
            className={`px-2.5 py-1 text-xs transition-colors ${
              depth === option ? 'bg-bambu-green text-bambu-dark font-medium' : 'text-bambu-gray hover:text-white'
            }`}
          >
            {t(DEPTH_LABEL_KEY[option])}
          </button>
        ))}
      </div>

      <form
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const body = note.trim();
          if (!body) return;
          addNote.mutate({
            body,
            optimistic: {
              id: nextPlaceholderId(),
              occurred_at: new Date().toISOString(),
              occurred_until: null,
              kind: 'note.added',
              actor_class: 'user',
              actor_name: null,
              subject_type: null,
              subject_id: null,
              subject_label: null,
              changes: null,
              detail: null,
              note: body,
            },
          });
        }}
      >
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('aito.history.notePlaceholder')}
          className="flex-1 min-w-0 rounded-md bg-bambu-dark-tertiary/40 border border-bambu-dark-tertiary px-2 py-1 text-sm text-white placeholder:text-bambu-gray focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
        />
        <button
          type="submit"
          disabled={!note.trim() || addNote.isPending}
          className="text-xs text-bambu-green hover:text-bambu-green/80 disabled:opacity-40"
        >
          {t('aito.history.noteSubmit')}
        </button>
      </form>

      {isLoading ? (
        <Loader2 className="w-4 h-4 text-bambu-gray animate-spin" />
      ) : events.length === 0 ? (
        <p className="text-sm text-bambu-gray">{t('aito.history.empty')}</p>
      ) : (
        <ol className="relative border-l border-bambu-dark-tertiary ml-0.5">
          {events.map((event, index) => (
            <EventItem
              key={event.id}
              event={event}
              // The next entry down the list is the next-older one, because
              // the list runs newest-first.
              previous={events[index + 1]}
              showElapsed={depth === 'story'}
            />
          ))}
        </ol>
      )}

      {hasNextPage && (
        <button
          type="button"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="mt-2 text-xs text-bambu-green hover:text-bambu-green/80 disabled:opacity-40"
        >
          {t('aito.history.loadMore')}
        </button>
      )}
    </section>
  );
}
