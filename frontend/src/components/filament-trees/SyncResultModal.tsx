import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../../api/client';
import type {
  FilamentTreeCandidate,
  FilamentTreeConflict,
  FilamentTreePresetValue,
  FilamentTreePullResult,
  FilamentTreeSummary,
  FilamentTreeTargets,
} from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../Button';
import { errorMessage } from './errorMessage';
import { inputCls } from '../formStyles';
import { Dialog } from './Dialog';

const display = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));

/** "SUNLU PA6-GF - Black @BBL H2S" -> brand SUNLU, material PA6-GF, colour Black. */
function parseCandidateName(name: string) {
  const [prefix, ...rest] = name.split(' - ');
  const [brand = '', ...material] = prefix.trim().split(/\s+/);
  return { brand, material: material.join(' '), colour: rest.join(' - ').replace(/\s*@.*$/, '').trim() };
}

function candidateHex(content: Record<string, unknown>) {
  const raw = content.default_filament_colour;
  const hex = String(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''));
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#000000';
}

function CandidateForm({ candidate, targets }: { candidate: FilamentTreeCandidate; targets: FilamentTreeTargets }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const parsed = parseCandidateName(candidate.name);
  const [form, setForm] = useState({
    brand: parsed.brand,
    material: parsed.material,
    color_name: parsed.colour,
    color_hex: candidateHex(candidate.content),
    machine: targets.machines[0] ?? '',
    nozzle: targets.nozzles.includes('0.4') ? '0.4' : (targets.nozzles[0] ?? ''),
  });
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const field = (key: keyof typeof form, label: string) => (
    <input
      aria-label={`${label}: ${candidate.name}`}
      placeholder={label}
      value={form[key]}
      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      className={inputCls}
    />
  );
  const select = (key: 'machine' | 'nozzle', label: string, options: string[]) => (
    <select
      aria-label={`${label}: ${candidate.name}`}
      value={form[key]}
      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      className={inputCls}
    >
      {options.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </select>
  );
  const create = async () => {
    setState('busy');
    try {
      await api.createFilamentTreeFromCandidate({ orca_id: candidate.orca_id ?? '', name: candidate.name, ...form });
      setState('done');
      await queryClient.invalidateQueries({ queryKey: ['filament-trees'] });
    } catch (err) {
      setState('idle');
      showToast(errorMessage(err), 'error');
    }
  };
  return (
    <li className="space-y-2 rounded-lg border border-bambu-dark-tertiary p-3">
      <div className="break-all font-mono text-sm text-white">{candidate.name}</div>
      {state === 'done' ? (
        <p className="text-sm text-green-400">{t('filamentTrees.treeCreated')}</p>
      ) : !candidate.orca_id ? null : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {field('brand', t('filamentTrees.brand'))}
            {field('material', t('filamentTrees.material'))}
            {field('color_name', t('filamentTrees.colourName'))}
            {field('color_hex', t('filamentTrees.colourHex'))}
            {select('machine', t('filamentTrees.machine'), targets.machines)}
            {select('nozzle', t('filamentTrees.nozzle'), targets.nozzles)}
          </div>
          <Button size="sm" onClick={create} disabled={state === 'busy'}>
            {t('filamentTrees.createTree')}
          </Button>
        </>
      )}
    </li>
  );
}

function ConflictRow({ conflict, leafName, open, onResolved }: {
  conflict: FilamentTreeConflict;
  leafName: string;
  open: boolean;
  onResolved: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const pick = async (value: unknown) => {
    setBusy(true);
    const { tree_id, machine, nozzle, color_id, key } = conflict;
    try {
      await api.resolveFilamentTreeConflict({
        tree_id, machine, nozzle, color_id, key,
        value: value as FilamentTreePresetValue | null,
        orca_value: conflict.orca_value as FilamentTreePresetValue | null,
      });
      onResolved();
      await queryClient.invalidateQueries({ queryKey: ['filament-trees'] });
    } catch (err) {
      setBusy(false);
      showToast(errorMessage(err), 'error');
    }
  };
  return (
    // a settled row folds shut rather than vanishing, so the next row's buttons don't jump under the cursor
    <li className="aito-fold" data-open={open} aria-hidden={!open} inert={!open}>
      <div>
        <div className="mb-2 space-y-2 rounded-lg border border-bambu-dark-tertiary p-3">
          <div className="text-sm text-white">{leafName}</div>
          <div className="font-mono text-xs text-bambu-gray">{conflict.key}</div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => pick(conflict.fenrir_value)}>
              {t('filamentTrees.keepFenrir', { value: display(conflict.fenrir_value) })}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => pick(conflict.orca_value)}>
              {t('filamentTrees.keepOrca', { value: display(conflict.orca_value) })}
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}

/** What a SYNC pull did: counts, conflicts to settle, Orca-only presets that can become trees. */
export function SyncResultModal({ result, error, trees, targets, onClose }: {
  result?: FilamentTreePullResult;
  error?: unknown;
  trees: FilamentTreeSummary[];
  targets: FilamentTreeTargets;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const [resolved, setResolved] = useState<Set<number>>(new Set());
  const leafName = (c: FilamentTreeConflict) => {
    const tree = trees.find((tr) => tr.id === c.tree_id);
    const colour = tree?.colors.find((col) => col.id === c.color_id);
    return `${tree?.name ?? `#${c.tree_id}`} - ${colour?.name ?? `#${c.color_id}`} @${c.machine} ${c.nozzle}`;
  };
  const conflicts = result?.conflicts ?? [];

  return (
    <Dialog title={t('filamentTrees.syncTitle')} onClose={onClose}>
      {error instanceof ApiError && error.status === 401 ? (
        <div className="space-y-1 text-sm">
          <p className="text-white">{t('filamentTrees.orcaNotConnected')}</p>
          <Link to="/profiles" className="text-sky-400 hover:underline">
            {t('filamentTrees.orcaConnect')}
          </Link>
        </div>
      ) : error ? (
        <p className="text-sm text-red-400">{errorMessage(error)}</p>
      ) : result ? (
        <>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            {(
              [
                ['applied', result.applied.length],
                ['pushed', result.push.pushed],
                ['legacy', result.legacy],
                ['missing', result.missing.length],
                ['ignored', result.ignored],
              ] as const
            ).map(([key, n]) => (
              <div key={key} className="rounded-lg bg-bambu-dark p-2">
                <dt className="text-xs text-bambu-gray">{t(`filamentTrees.stat.${key}`)}</dt>
                <dd className="text-lg font-semibold tabular-nums text-white">{n}</dd>
              </div>
            ))}
          </dl>
          {result.push.needs_write_scope ? (
            <p className="text-sm text-amber-400">
              {t('filamentTrees.pushNeedsReconnect', { n: result.push.remaining })}{' '}
              <Link to="/profiles" className="text-sky-400 hover:underline">
                {t('filamentTrees.orcaConnect')}
              </Link>
            </p>
          ) : (
            result.push.failed.length > 0 && (
              <p className="break-words text-sm text-amber-400" title={result.push.failed[0].detail}>
                {t('filamentTrees.pushFailed', { n: result.push.failed.length + result.push.remaining })}
              </p>
            )
          )}
          {result.missing.length > 0 && (
            <p className="break-words text-xs text-bambu-gray">{result.missing.join(', ')}</p>
          )}
          {conflicts.length > resolved.size && (
            <section className="space-y-2">
              <h4 className="font-semibold text-white">{t('filamentTrees.conflictsTitle')}</h4>
              <p className="text-xs text-bambu-gray">{t('filamentTrees.conflictsHint')}</p>
              <ul>
                {conflicts.map((c, i) => (
                  <ConflictRow
                    key={i}
                    conflict={c}
                    leafName={leafName(c)}
                    open={!resolved.has(i)}
                    onResolved={() => setResolved((prev) => new Set(prev).add(i))}
                  />
                ))}
              </ul>
            </section>
          )}
          {result.candidates.length > 0 && hasPermission('filaments:create') && (
            <section className="space-y-2">
              <h4 className="font-semibold text-white">{t('filamentTrees.candidatesTitle')}</h4>
              <ul className="space-y-2">
                {result.candidates.map((c) => (
                  <CandidateForm key={c.orca_id ?? c.name} candidate={c} targets={targets} />
                ))}
              </ul>
            </section>
          )}
        </>
      ) : null}
    </Dialog>
  );
}
