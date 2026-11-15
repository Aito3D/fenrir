import { useQueryClient } from '@tanstack/react-query';
import { Download, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../api/client';
import type { FilamentTreeColor, FilamentTreeSummary, FilamentTreeTargets } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../Button';
import { ConfirmModal } from '../ConfirmModal';
import { errorMessage } from './errorMessage';
import { inputCls } from '../formStyles';
import { downloadTreeExport } from './exportDownload';

const splitList = (text: string) => text.split(',').map((s) => s.trim()).filter(Boolean);
const hexOrBlack = (hex: string) => (/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#000000');

/** Tree settings: the selected tree's colours, 0.2 switch and export, plus the machine/nozzle targets of every tree. */
export function TreeSettingsPanel({ tree, targets }: { tree: FilamentTreeSummary | undefined; targets: FilamentTreeTargets }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canCreate = hasPermission('filaments:create');
  const canUpdate = hasPermission('filaments:update');
  const canDelete = hasPermission('filaments:delete');
  const [newName, setNewName] = useState('');
  const [newHex, setNewHex] = useState('#000000');
  const [machines, setMachines] = useState(targets.machines.join(', '));
  const [nozzles, setNozzles] = useState(targets.nozzles.join(', '));
  const [removing, setRemoving] = useState<FilamentTreeColor | null>(null);
  const [busy, setBusy] = useState(false);
  // Colour pickers fire on every drag step: save each colour 400ms after the last change.
  const hexTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = hexTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  // Every write: refused edits come back as 400 with a reason, shown as a toast.
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['filament-trees'] });
      return true;
    } catch (err) {
      showToast(errorMessage(err), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const heading = 'text-xs font-semibold uppercase tracking-wide text-bambu-gray/70';
  return (
    <section className="min-w-0 space-y-6">
      {tree ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-white">{tree.name}</h2>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => downloadTreeExport(tree.id).catch((err) => showToast(errorMessage(err), 'error'))}
            >
              <Download className="h-4 w-4" />
              {t('filamentTrees.exportTree')}
            </Button>
          </div>

          {canUpdate && (
            <label className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-bambu-gray-light">{t('filamentTrees.skip02')}</span>
              <select
                value={tree.skip_02 === null ? 'auto' : tree.skip_02 ? 'skip' : 'include'}
                disabled={busy}
                onChange={(e) => {
                  const skip_02 = { auto: null, skip: true, include: false }[e.target.value as 'auto' | 'skip' | 'include'];
                  void run(() => api.updateFilamentTree(tree.id, { skip_02 }));
                }}
                className={`${inputCls} w-auto`}
              >
                <option value="auto">{t('filamentTrees.skip02Auto')}</option>
                <option value="skip">{t('filamentTrees.skip02Yes')}</option>
                <option value="include">{t('filamentTrees.skip02No')}</option>
              </select>
            </label>
          )}

          <div className="space-y-2">
            <h3 className={heading}>{t('filamentTrees.colours')}</h3>
            <ul className="space-y-1.5">
              {tree.colors.map((c) => {
                const isSource = c.id === tree.source.color_id;
                const rename = (patch: { name?: string; hex?: string }) => {
                  const next = { name: (patch.name ?? c.name).trim(), hex: patch.hex ?? c.hex };
                  if (next.name && (next.name !== c.name || next.hex !== c.hex))
                    void run(() => api.updateFilamentTreeColor(tree.id, c.id, next));
                };
                return (
                  <li key={`${c.id}:${c.name}:${c.hex}`} className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label={t('filamentTrees.colourHexOf', { name: c.name })}
                      defaultValue={hexOrBlack(c.hex)}
                      disabled={!canUpdate}
                      onChange={(e) => {
                        const hex = e.target.value;
                        clearTimeout(hexTimers.current.get(c.id));
                        hexTimers.current.set(c.id, setTimeout(() => rename({ hex }), 400));
                      }}
                      className="h-8 w-8 shrink-0 cursor-pointer rounded border border-bambu-dark-tertiary bg-transparent"
                    />
                    <input
                      aria-label={t('filamentTrees.colourNameOf', { name: c.name })}
                      defaultValue={c.name}
                      disabled={!canUpdate || busy}
                      onBlur={(e) => rename({ name: e.target.value })}
                      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                      className={`${inputCls} min-w-0 flex-1`}
                    />
                    {canDelete && !isSource && (
                      <button
                        type="button"
                        onClick={() => setRemoving(c)}
                        aria-label={t('filamentTrees.removeColour', { name: c.name })}
                        className="rounded p-1.5 text-bambu-gray hover:text-red-400"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {canCreate && (
              <form
                className="flex items-center gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const name = newName.trim();
                  if (name && (await run(() => api.addFilamentTreeColor(tree.id, { name, hex: newHex })))) setNewName('');
                }}
              >
                <input
                  type="color"
                  aria-label={t('filamentTrees.newColourHex')}
                  value={newHex}
                  onChange={(e) => setNewHex(e.target.value)}
                  className="h-8 w-8 shrink-0 cursor-pointer rounded border border-bambu-dark-tertiary bg-transparent"
                />
                <input
                  aria-label={t('filamentTrees.newColourName')}
                  placeholder={t('filamentTrees.newColourName')}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className={`${inputCls} min-w-0 flex-1`}
                />
                <Button type="submit" size="sm" disabled={busy || !newName.trim()}>
                  {t('filamentTrees.addColour')}
                </Button>
              </form>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-bambu-gray">{t('filamentTrees.selectTree')}</p>
      )}

      {canUpdate && (
        <form
          className="space-y-2 border-t border-bambu-dark-tertiary pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.setFilamentTreeTargets({ machines: splitList(machines), nozzles: splitList(nozzles) }));
          }}
        >
          <h3 className={heading}>{t('filamentTrees.targetsTitle')}</h3>
          <p className="text-xs text-bambu-gray/70">{t('filamentTrees.targetsHint')}</p>
          <label className="block space-y-1">
            <span className="text-sm text-bambu-gray-light">{t('filamentTrees.machines')}</span>
            <input aria-label={t('filamentTrees.machines')} value={machines} onChange={(e) => setMachines(e.target.value)} className={inputCls} />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-bambu-gray-light">{t('filamentTrees.nozzles')}</span>
            <input aria-label={t('filamentTrees.nozzles')} value={nozzles} onChange={(e) => setNozzles(e.target.value)} className={inputCls} />
          </label>
          <Button type="submit" size="sm" disabled={busy}>
            {t('filamentTrees.saveTargets')}
          </Button>
        </form>
      )}

      {removing && tree && (
        <ConfirmModal
          title={t('filamentTrees.removeColour', { name: removing.name })}
          message={t('filamentTrees.removeColourBody', { name: removing.name, tree: tree.name })}
          confirmText={t('filamentTrees.removeColour', { name: removing.name })}
          cancelText={t('common.cancel')}
          variant="danger"
          overlayZIndex="z-[110]"
          onConfirm={async () => {
            const color = removing;
            setRemoving(null);
            await run(() => api.deleteFilamentTreeColor(tree.id, color.id));
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </section>
  );
}
