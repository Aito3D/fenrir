import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../api/client';
import type { FilamentPreset, FilamentTreeMigrationGroup, FilamentTreeTargets } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../Button';
import { errorMessage } from './errorMessage';
import { inputCls } from '../formStyles';
import { Dialog } from './Dialog';

type Choice = { include: boolean; source: number; machine: string; nozzle: string };

const colourOf = (p: FilamentPreset | undefined, id: number) =>
  p ? p.color || p.name.split(' - ').slice(1).join(' - ') || p.name : `#${id}`;

/** One row per unmanaged preset group: pick the calibrated colour and its machine/nozzle, then build the trees. */
export function MigrateModal({ groups, presets, targets, onClose }: {
  groups: FilamentTreeMigrationGroup[];
  presets: FilamentPreset[];
  targets: FilamentTreeTargets;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const byId = new Map(presets.map((p) => [p.id, p]));
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      groups.map((g) => [
        g.prefix,
        { include: true, source: g.proposed_source_preset_id, machine: g.proposed_machine, nozzle: g.proposed_nozzle },
      ]),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const pending = groups.filter((g) => !done.has(g.prefix) && choices[g.prefix]);
  const chosen = pending.filter((g) => choices[g.prefix].include);
  const set = (prefix: string, patch: Partial<Choice>) =>
    setChoices((prev) => ({ ...prev, [prefix]: { ...prev[prefix], ...patch } }));

  // One request per group, so a group the backend refuses (e.g. mixed Bambu families) shows its own message.
  const confirm = async () => {
    setBusy(true);
    const nextErrors: Record<string, string> = {};
    const created = new Set(done);
    for (const g of chosen) {
      const c = choices[g.prefix];
      try {
        await api.migrateFilamentPresets([{ prefix: g.prefix, source_preset_id: c.source, machine: c.machine, nozzle: c.nozzle }]);
        created.add(g.prefix);
      } catch (err) {
        nextErrors[g.prefix] = errorMessage(err);
      }
    }
    setErrors(nextErrors);
    setDone(created);
    setBusy(false);
    await queryClient.invalidateQueries({ queryKey: ['filament-trees'] });
    if (created.size > done.size) showToast(t('filamentTrees.migrated', { n: created.size - done.size }));
    if (Object.keys(nextErrors).length === 0) onClose();
  };

  return (
    <Dialog
      title={t('filamentTrees.migrateTitle')}
      onClose={onClose}
      footer={
        <Button onClick={confirm} disabled={busy || chosen.length === 0}>
          {t('filamentTrees.migrateConfirm')}
        </Button>
      }
    >
      {pending.map((g) => {
        const c = choices[g.prefix];
        const machines = Array.from(new Set([c.machine, ...targets.machines]));
        const nozzles = Array.from(new Set([c.nozzle, ...targets.nozzles]));
        return (
          <div key={g.prefix} className="space-y-2 rounded-lg border border-bambu-dark-tertiary p-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={c.include}
                onChange={(e) => set(g.prefix, { include: e.target.checked })}
                aria-label={t('filamentTrees.include', { name: g.prefix })}
              />
              <span className="font-semibold text-white">{g.prefix}</span>
              <span className="text-xs text-bambu-gray">{t('filamentTrees.colourCount', { n: g.preset_ids.length })}</span>
            </label>
            {g.warnings.map((w) => (
              <p key={w} className="flex items-start gap-1.5 text-xs text-amber-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {w}
              </p>
            ))}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <select
                aria-label={`${t('filamentTrees.sourceColour')}: ${g.prefix}`}
                value={c.source}
                onChange={(e) => set(g.prefix, { source: Number(e.target.value) })}
                className={inputCls}
              >
                {g.preset_ids.map((id) => (
                  <option key={id} value={id}>
                    {colourOf(byId.get(id), id)}
                  </option>
                ))}
              </select>
              <select
                aria-label={`${t('filamentTrees.machine')}: ${g.prefix}`}
                value={c.machine}
                onChange={(e) => set(g.prefix, { machine: e.target.value })}
                className={inputCls}
              >
                {machines.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <select
                aria-label={`${t('filamentTrees.nozzle')}: ${g.prefix}`}
                value={c.nozzle}
                onChange={(e) => set(g.prefix, { nozzle: e.target.value })}
                className={inputCls}
              >
                {nozzles.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </div>
            {errors[g.prefix] && <p className="text-sm text-red-400">{errors[g.prefix]}</p>}
          </div>
        );
      })}
    </Dialog>
  );
}
