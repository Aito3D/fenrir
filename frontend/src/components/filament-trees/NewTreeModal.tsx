import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../api/client';
import type { FilamentTreeTargets } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../Button';
import { inputCls } from '../formStyles';
import { Dialog } from './Dialog';
import { errorMessage } from './errorMessage';

/** A new filament from scratch: brand + material, the Bambu family it inherits, a first colour and where it is calibrated. */
export function NewTreeModal({ targets, onClose, onCreated }: {
  targets: FilamentTreeTargets;
  onClose: () => void;
  onCreated: (treeId: number) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    brand: '',
    material: '',
    base_family: '',
    color_name: '',
    color_hex: '#000000',
    machine: targets.machines[0] ?? '',
    nozzle: targets.nozzles.includes('0.4') ? '0.4' : (targets.nozzles[0] ?? ''),
  });
  const [busy, setBusy] = useState(false);
  const { data: bases } = useQuery({ queryKey: ['filamentBasePresets'], queryFn: api.getBaseFilamentPresets });
  // "Generic PETG @BBL H2S 0.4 nozzle" -> "Generic PETG"
  const families = useMemo(() => [...new Set((bases ?? []).map((b) => b.name.replace(/ @.*$/, '')))].sort(), [bases]);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const ready = Object.values(form).every((v) => v.trim());

  const create = async () => {
    setBusy(true);
    try {
      const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim()])) as typeof form;
      const { tree_id } = await api.createFilamentTree(body);
      await queryClient.invalidateQueries({ queryKey: ['filament-trees'] });
      onCreated(tree_id);
      onClose();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const text = (key: 'brand' | 'material' | 'base_family' | 'color_name', label: string, list?: string) => (
    <label className="block space-y-1">
      <span className="text-sm text-bambu-gray-light">{label}</span>
      <input aria-label={label} list={list} value={form[key]} onChange={(e) => set({ [key]: e.target.value })} className={inputCls} />
    </label>
  );
  const pick = (key: 'machine' | 'nozzle', label: string, options: string[]) => (
    <label className="block space-y-1">
      <span className="text-sm text-bambu-gray-light">{label}</span>
      <select aria-label={label} value={form[key]} onChange={(e) => set({ [key]: e.target.value })} className={inputCls}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Dialog
      title={t('filamentTrees.newFilament')}
      onClose={onClose}
      footer={
        <Button onClick={create} disabled={busy || !ready}>
          {t('common.create')}
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {text('brand', t('filamentTrees.brand'))}
        {text('material', t('filamentTrees.material'))}
      </div>
      {text('base_family', t('filamentTrees.baseFamily'), 'fp-base-families')}
      <datalist id="fp-base-families">
        {families.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <p className="text-xs text-bambu-gray/70">{t('filamentTrees.baseFamilyHint')}</p>
      <div className="flex items-end gap-2">
        <input
          type="color"
          aria-label={t('filamentTrees.newColourHex')}
          value={form.color_hex}
          onChange={(e) => set({ color_hex: e.target.value })}
          className="h-9 w-9 shrink-0 cursor-pointer rounded border border-bambu-dark-tertiary bg-transparent"
        />
        <div className="min-w-0 flex-1">{text('color_name', t('filamentTrees.colourName'))}</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {pick('machine', `${t('filamentTrees.calibrationSource')}: ${t('filamentTrees.machine')}`, targets.machines)}
        {pick('nozzle', `${t('filamentTrees.calibrationSource')}: ${t('filamentTrees.nozzle')}`, targets.nozzles)}
      </div>
    </Dialog>
  );
}
