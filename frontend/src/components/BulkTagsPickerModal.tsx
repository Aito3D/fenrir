import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Tag, Loader2, X } from 'lucide-react';

import { api, type LibraryTag } from '../api/client';
import { Button } from './Button';
import { useToast } from '../contexts/ToastContext';
import { libraryTagsQueryKey } from '../utils/libraryTagsQuery';

interface BulkTagsPickerModalProps {
  open: boolean;
  fileIds: number[];
  onClose: () => void;
  /** Pre-select these tag IDs when the modal opens (used in single-file mode). */
  initialTagIds?: number[];
  /** Single-file mode: hides Add/Remove radio, uses replace semantics, cleans up labels. */
  singleMode?: boolean;
}

type Action = 'add' | 'remove';

function normalizeTagInput(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function BulkTagsPickerModal({ open, fileIds, onClose, initialTagIds, singleMode }: BulkTagsPickerModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [action, setAction] = useState<Action>('add');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState('');
  // Keyboard navigation: the highlighted row in the tag list. Tracked by tag
  // id (not index) so the highlight survives filtering. null = no highlight.
  const [highlightedTagId, setHighlightedTagId] = useState<number | null>(null);
  // Sort seed frozen at open time — see filteredTags below.
  const [openSelectedSeed, setOpenSelectedSeed] = useState<Set<number>>(new Set());
  // Reset/initialise state each time the modal opens.
  useEffect(() => {
    if (open) {
      setAction('add');
      setSelected(new Set(initialTagIds ?? []));
      setOpenSelectedSeed(new Set(initialTagIds ?? []));
      setFilter('');
      setHighlightedTagId(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const { data: tags = [], isLoading } = useQuery({
    queryKey: libraryTagsQueryKey,
    queryFn: api.getLibraryTags,
    enabled: open,
  });

  // Selected tags resolved to full objects for the chip row.
  const selectedTags = useMemo<LibraryTag[]>(
    () => tags.filter((tg) => selected.has(tg.id)),
    [tags, selected],
  );

  // Filtered list, pre-selected-first. The order is frozen per open (seeded
  // from initialTagIds) instead of live-resorting on every toggle — live
  // resort made rows jump out from under the keyboard highlight and mouse
  // cursor the moment a checkbox changed.
  const filteredTags = useMemo<LibraryTag[]>(() => {
    const q = filter.trim().toLowerCase();
    const visible = q ? tags.filter((tg) => tg.name.toLowerCase().includes(q)) : tags;
    return [...visible].sort((a, b) => {
      const aSeed = openSelectedSeed.has(a.id) ? 0 : 1;
      const bSeed = openSelectedSeed.has(b.id) ? 0 : 1;
      return aSeed - bSeed || a.name.localeCompare(b.name);
    });
  }, [tags, filter, openSelectedSeed]);

  const toggleTag = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createTagMutation = useMutation({
    mutationFn: (name: string) => api.createLibraryTag(name),
    onSuccess: (tag) => {
      setSelected((prev) => new Set(prev).add(tag.id));
      setFilter('');
      queryClient.invalidateQueries({ queryKey: libraryTagsQueryKey });
    },
    onError: (err: Error) => {
      showToast(err.message || t('fileManager.tags.saveFailed'), 'error');
    },
  });

  const applyMutation = useMutation({
    mutationFn: () =>
      api.bulkAssignLibraryTags(fileIds, Array.from(selected), singleMode ? 'replace' : action),
    onSuccess: (result) => {
      showToast(
        action === 'add'
          ? t('fileManager.tags.applyAddSuccess', {
              count: result.associations_added,
              files: result.files_updated,
            })
          : t('fileManager.tags.applyRemoveSuccess', {
              count: result.associations_removed,
              files: result.files_updated,
            }),
        'success',
      );
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: libraryTagsQueryKey });
      onClose();
    },
    onError: (err: Error) => {
      showToast(err.message || t('fileManager.tags.applyFailed'), 'error');
    },
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !applyMutation.isPending && !createTagMutation.isPending) {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, applyMutation.isPending, createTagMutation.isPending]);

  if (!open) return null;

  const trimmed = filter.trim();
  const exactMatch = trimmed
    ? tags.find((tg) => tg.name.toLowerCase() === trimmed.toLowerCase())
    : undefined;

  // The highlight only counts when its tag is actually visible in the
  // filtered list (typing clears it, but this is the safety net so Space /
  // Enter can never toggle an off-screen row).
  const highlightVisible = highlightedTagId !== null && filteredTags.some((tg) => tg.id === highlightedTagId);

  const moveHighlight = (delta: 1 | -1) => {
    if (filteredTags.length === 0) return;
    const idx = highlightVisible ? filteredTags.findIndex((tg) => tg.id === highlightedTagId) : -1;
    const next =
      idx === -1
        ? delta === 1
          ? 0
          : filteredTags.length - 1
        : Math.min(filteredTags.length - 1, Math.max(0, idx + delta));
    const id = filteredTags[next].id;
    setHighlightedTagId(id);
    // Keep the highlighted row in view inside the scrollable list.
    document.getElementById(`bulk-tag-option-${id}`)?.scrollIntoView({ block: 'nearest' });
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Arrow keys walk the checkbox list without leaving the input; Space or
    // Enter toggles the highlighted tag. Escape backs out of navigation
    // first, then (via the document listener) closes the modal.
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveHighlight(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveHighlight(-1);
      return;
    }
    if (e.key === ' ' && highlightVisible) {
      e.preventDefault();
      toggleTag(highlightedTagId!);
      return;
    }
    if (e.key === 'Escape' && highlightVisible) {
      e.preventDefault();
      e.stopPropagation();
      setHighlightedTagId(null);
      return;
    }
    if (e.key !== 'Enter' || createTagMutation.isPending) return;
    e.preventDefault();
    if (highlightVisible) {
      toggleTag(highlightedTagId!);
      return;
    }
    if (!trimmed) {
      // Empty input → submit
      if (!applyMutation.isPending && (selected.size > 0 || singleMode) && fileIds.length > 0) {
        applyMutation.mutate();
      }
      return;
    }
    if (exactMatch) {
      toggleTag(exactMatch.id);
      setFilter('');
    } else {
      createTagMutation.mutate(trimmed);
    }
  };

  const titleId = 'bulk-tags-picker-title';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 animate-overlay-in" onClick={() => !applyMutation.isPending && onClose()} />
      <div
        className="relative w-full max-w-md mx-4 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-xl shadow-2xl max-h-[90vh] flex flex-col animate-modal-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-bambu-dark-tertiary">
          <h3 id={titleId} className="text-base font-semibold text-white flex items-center gap-2">
            <Tag className="w-4 h-4 text-bambu-green" />
            {singleMode ? t('fileManager.tags.title') : t('fileManager.tags.bulkTitle', { count: fileIds.length })}
          </h3>
          <button
            type="button"
            className="p-1.5 text-bambu-gray hover:text-white rounded"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Add/Remove radio (bulk mode only) */}
        {!singleMode && (
          <div className="px-5 py-3 border-b border-bambu-dark-tertiary flex gap-4 text-sm">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="bulk-action" checked={action === 'add'} onChange={() => setAction('add')} className="accent-bambu-green" />
              <span className="text-white">{t('fileManager.tags.actionAdd')}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="bulk-action" checked={action === 'remove'} onChange={() => setAction('remove')} className="accent-bambu-green" />
              <span className="text-white">{t('fileManager.tags.actionRemove')}</span>
            </label>
          </div>
        )}

        {/* Selected chips */}
        {selectedTags.length > 0 && (
          <div className="px-5 py-2.5 border-b border-bambu-dark-tertiary flex flex-wrap gap-1.5">
            {selectedTags.map((tg) => (
              <button
                key={tg.id}
                type="button"
                onClick={() => toggleTag(tg.id)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-bambu-green/20 text-bambu-green border border-bambu-green/40 hover:bg-bambu-green/10 transition-colors"
              >
                {tg.name}
                <X className="w-3 h-3 opacity-70" />
              </button>
            ))}
          </div>
        )}

        {/* Unified search / create input */}
        <div className="px-5 py-3 border-b border-bambu-dark-tertiary">
          <input
            autoFocus
            type="text"
            value={filter}
            onChange={(e) => {
              setFilter(normalizeTagInput(e.target.value));
              // Typing changes the visible list — drop the highlight so a
              // later Space/Enter can't toggle a row the user isn't seeing.
              setHighlightedTagId(null);
            }}
            onKeyDown={handleInputKeyDown}
            placeholder={t('fileManager.tags.searchPlaceholder')}
            aria-activedescendant={highlightVisible ? `bulk-tag-option-${highlightedTagId}` : undefined}
            className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded text-sm text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green"
          />
          {trimmed && (
            <p className="mt-1.5 text-xs text-bambu-gray">
              {createTagMutation.isPending ? (
                <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> {t('fileManager.tags.creating')}</span>
              ) : exactMatch ? (
                <span>{selected.has(exactMatch.id) ? t('fileManager.tags.hintDeselect') : t('fileManager.tags.hintSelect')} <strong className="text-white">"{exactMatch.name}"</strong></span>
              ) : (
                <span>{t('fileManager.tags.hintCreate')} <strong className="text-white">"{trimmed}"</strong></span>
              )}
            </p>
          )}
        </div>

        {/* Tag list */}
        <div className="overflow-y-auto flex-1 min-h-[8rem] max-h-[24rem]">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-bambu-gray">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              {t('common.loading')}
            </div>
          ) : filteredTags.length === 0 ? (
            <div className="py-12 text-center text-bambu-gray text-sm">
              {tags.length === 0 ? t('fileManager.tags.empty') : t('fileManager.tags.noMatches')}
            </div>
          ) : (
            <ul className="divide-y divide-bambu-dark-tertiary/40">
              {filteredTags.map((tg) => (
                <li key={tg.id} id={`bulk-tag-option-${tg.id}`}>
                  <label
                    className={`flex items-center gap-3 px-5 py-2 cursor-pointer ${
                      highlightVisible && highlightedTagId === tg.id
                        ? 'bg-bambu-dark-tertiary/60 ring-1 ring-inset ring-bambu-green/40'
                        : 'hover:bg-bambu-dark-tertiary/30'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(tg.id)}
                      onChange={() => toggleTag(tg.id)}
                      className="accent-bambu-green"
                    />
                    <span className="text-sm text-white truncate flex-1">{tg.name}</span>
                    <span className="text-xs text-bambu-gray">{tg.file_count}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-bambu-dark-tertiary flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={applyMutation.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => applyMutation.mutate()}
            disabled={(selected.size === 0 && !singleMode) || applyMutation.isPending || fileIds.length === 0}
          >
            {applyMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {singleMode ? t('common.save') : action === 'add' ? t('fileManager.tags.applyAdd') : t('fileManager.tags.applyRemove')}
          </Button>
        </div>
      </div>
    </div>
  );
}
