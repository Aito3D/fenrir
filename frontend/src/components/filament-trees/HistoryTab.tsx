import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../api/client';
import type { FilamentTreeChange, FilamentTreeSummary } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { errorMessage } from './errorMessage';
import { keyLabel } from './orcaLayout';

const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));

/** Every value change of one filament, newest first; Revert puts a key back to what it was before that change. */
export function HistoryTab({ tree }: { tree: FilamentTreeSummary }) {
  const { t, i18n } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['filament-trees', tree.id, 'history'],
    queryFn: () => api.getFilamentTreeHistory(tree.id),
  });
  const where = (c: FilamentTreeChange) => {
    const colour = tree.colors.find((x) => x.id === c.color_id)?.name;
    return [c.machine, c.nozzle, colour].filter(Boolean).join(' › ') || tree.name;
  };
  const revert = async (c: FilamentTreeChange) => {
    setBusy(true);
    try {
      await api.revertFilamentTreeChange(tree.id, c.id);
      await queryClient.invalidateQueries({ queryKey: ['filament-trees'] });
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;
  if (error) return <p className="text-sm text-red-400">{errorMessage(error)}</p>;
  if (!data?.length) return <p className="text-sm text-bambu-gray">{t('filamentTrees.historyEmpty')}</p>;
  return (
    <ul className="divide-y divide-bambu-dark-tertiary">
      {data.map((c) => (
        <li key={c.id} className="flex items-center gap-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-white" title={c.key}>
              {keyLabel(t, c.key)}
              <span className="ml-2 text-xs text-bambu-gray">{where(c)}</span>
            </p>
            <p className="truncate font-mono text-xs text-bambu-gray-light">
              {c.old_value == null ? '—' : show(c.old_value)} → {c.new_value == null ? '—' : show(c.new_value)}
            </p>
            <p className="text-[11px] text-bambu-gray/70">
              {/* the server stores naive UTC */}
              {new Date(`${c.created_at.replace(/Z$/, '')}Z`).toLocaleString(i18n.language)}
              {c.actor && ` · ${c.actor}`}
            </p>
          </div>
          {hasPermission('filaments:update') && (
            <button
              type="button"
              disabled={busy}
              onClick={() => revert(c)}
              aria-label={`${t('filamentTrees.revert')}: ${keyLabel(t, c.key)}`}
              className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-orange-400 hover:bg-orange-400/10 disabled:opacity-50"
            >
              <Undo2 className="h-3.5 w-3.5" />
              {t('filamentTrees.revert')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
