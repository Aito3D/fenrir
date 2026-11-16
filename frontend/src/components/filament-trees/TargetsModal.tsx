import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../api/client';
import type { FilamentTreeTargets } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../Button';
import { inputCls } from '../formStyles';
import { Dialog } from './Dialog';
import { errorMessage } from './errorMessage';

function ChipList({ label, addLabel, values, onChange }: {
  label: string;
  addLabel: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div role="group" aria-label={label} className="space-y-2">
      <span className="text-sm text-bambu-gray-light">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {values.map((v) => (
          <span key={v} className="flex items-center gap-1 rounded-full bg-bambu-green/20 py-1 pl-2.5 pr-1 text-xs font-medium text-bambu-green">
            {v}
            <button
              type="button"
              aria-label={t('filamentTrees.removeColour', { name: v })}
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="rounded-full p-0.5 hover:bg-white/10"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          aria-label={addLabel}
          placeholder={addLabel}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
          onBlur={add}
          className={`${inputCls} w-32!`}
        />
      </div>
    </div>
  );
}

/** The printers and nozzles every filament gets a profile for; the server refuses a change that drops a calibration source. */
export function TargetsModal({ targets, onClose }: { targets: FilamentTreeTargets; onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [machines, setMachines] = useState(targets.machines);
  const [nozzles, setNozzles] = useState(targets.nozzles);
  const [mergeNozzles, setMergeNozzles] = useState(!!targets.merge_nozzles);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.setFilamentTreeTargets({ machines, nozzles, merge_nozzles: mergeNozzles });
      await queryClient.invalidateQueries({ queryKey: ['filament-trees'] });
      onClose();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('filamentTrees.targetsTitle')}
      onClose={onClose}
      footer={
        <Button onClick={save} disabled={busy || machines.length === 0 || nozzles.length === 0}>
          {t('filamentTrees.saveTargets')}
        </Button>
      }
    >
      <p className="text-xs text-bambu-gray/70">{t('filamentTrees.targetsHint')}</p>
      <ChipList label={t('filamentTrees.machines')} addLabel={t('filamentTrees.addMachine')} values={machines} onChange={setMachines} />
      <p className="text-xs text-bambu-gray/70">{t('filamentTrees.targetsJoinHint')}</p>
      <ChipList label={t('filamentTrees.nozzles')} addLabel={t('filamentTrees.addNozzle')} values={nozzles} onChange={setNozzles} />
      <label className="flex cursor-pointer items-center gap-2 text-sm text-bambu-gray-light">
        <input type="checkbox" checked={mergeNozzles} onChange={(e) => setMergeNozzles(e.target.checked)} className="h-4 w-4 accent-bambu-green" />
        {t('filamentTrees.mergeNozzles')}
      </label>
    </Dialog>
  );
}
