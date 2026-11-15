import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../api/client';
import type { FilamentTreeNodeRow, FilamentTreePresetValue, FilamentTreeSummary } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../Button';
import { Dialog } from './Dialog';
import { errorMessage } from './errorMessage';
import { PA_KEY } from './orcaLayout';

const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));

/** Copy this level's own values to the same level (root, machine or nozzle) of other filaments. */
export function BulkApplyModal({ tree, trees, machine, nozzle, rows, label, onClose }: {
  tree: FilamentTreeSummary;
  trees: FilamentTreeSummary[];
  machine?: string;
  nozzle?: string;
  /** this node's own rows */
  rows: FilamentTreeNodeRow[];
  label: (key: string) => string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  // a filament without the 0.2 nozzle has no such level to write to
  const others = trees.filter((x) => x.id !== tree.id && !(nozzle === '0.2' && (x.skip_02 ?? x.abrasive)));
  // the start G-code carries this filament's pressure advance: opt-in only
  const [keys, setKeys] = useState(() => new Set(rows.filter((r) => r.key !== PA_KEY).map((r) => r.key)));
  const [ids, setIds] = useState(() => new Set(others.filter((x) => x.material === tree.material).map((x) => x.id)));
  const [busy, setBusy] = useState(false);
  const toggle = <T,>(set: Set<T>, v: T) => {
    const next = new Set(set);
    if (!next.delete(v)) next.add(v);
    return next;
  };

  const apply = async () => {
    setBusy(true);
    try {
      await api.bulkSetFilamentTreeNode({
        tree_ids: [...ids],
        ...(machine !== undefined && { machine }),
        ...(nozzle !== undefined && { nozzle }),
        set: Object.fromEntries(rows.filter((r) => keys.has(r.key)).map((r) => [r.key, r.value as FilamentTreePresetValue])),
      });
      await queryClient.invalidateQueries({ queryKey: ['filament-trees'] });
      onClose();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const heading = 'text-xs font-semibold uppercase tracking-wide text-bambu-gray/70';
  const check = 'h-4 w-4 shrink-0 accent-bambu-green';
  return (
    <Dialog
      title={t('filamentTrees.applyToOthers')}
      onClose={onClose}
      footer={
        <Button onClick={apply} disabled={busy || keys.size === 0 || ids.size === 0}>
          {t('filamentTrees.applyConfirm', { n: ids.size })}
        </Button>
      }
    >
      <p className="text-sm text-bambu-gray">{[tree.name, machine, nozzle].filter(Boolean).join(' › ')}</p>
      <div role="group" aria-label={t('filamentTrees.applyValues')} className="space-y-1">
        <h4 className={heading}>{t('filamentTrees.applyValues')}</h4>
        {rows.map((r) => (
          <label key={r.key} className="flex items-center gap-2 text-sm text-bambu-gray-light" title={r.key}>
            <input type="checkbox" className={check} checked={keys.has(r.key)} onChange={() => setKeys(toggle(keys, r.key))} />
            <span className="min-w-0 flex-1 truncate">{label(r.key)}</span>
            <span className="max-w-[40%] truncate font-mono text-xs text-white">{show(r.value)}</span>
          </label>
        ))}
      </div>
      <div role="group" aria-label={t('filamentTrees.applyTargets')} className="space-y-1">
        <h4 className={heading}>{t('filamentTrees.applyTargets')}</h4>
        {others.map((x) => (
          <label key={x.id} className="flex items-center gap-2 text-sm text-bambu-gray-light">
            <input type="checkbox" className={check} checked={ids.has(x.id)} onChange={() => setIds(toggle(ids, x.id))} />
            {x.name}
          </label>
        ))}
      </div>
    </Dialog>
  );
}
