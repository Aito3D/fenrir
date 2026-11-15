import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../api/client';
import type { FilamentTreeNodeRow, FilamentTreeNodeUpdate, FilamentTreePresetValue, FilamentTreeSummary } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { errorMessage } from '../filament-profiles/presetJson';
import { inputCls } from '../formStyles';
import { FIELD_LABEL_KEYS } from './fieldLabels';
import { readPaK, writePaK } from './paGcode';
import type { NodeRef } from './TreeNav';

/** Mirrors the backend's NOZZLE_BOUND_KEYS: refused at the root and colour-wide levels. */
const NOZZLE_BOUND_KEYS = new Set([
  'filament_max_volumetric_speed',
  'pressure_advance',
  'enable_pressure_advance',
  'filament_start_gcode',
]);
const PA_KEY = 'filament_start_gcode';

const display = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));

/** Text back into the stored Orca shape: one-element arrays stay one element; longer arrays split on commas. */
// shortcut: a comma inside a multi-element array entry splits it, upgrade if such a key ever needs editing here
function parse(text: string, original: unknown): FilamentTreePresetValue {
  if (!Array.isArray(original)) return text;
  return original.length > 1 ? text.split(',').map((s) => s.trim()) : [text];
}

function ValueInput({ label, value, describedBy, own, onCommit }: {
  label: string;
  value: string;
  describedBy?: string;
  own?: boolean;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  const cls = `${inputCls} font-mono ${own ? 'font-semibold' : own === false ? 'opacity-70' : ''}`;
  if (value.includes('\n')) {
    return (
      <textarea
        aria-label={label}
        aria-describedby={describedBy}
        value={draft}
        rows={Math.min(6, value.split('\n').length)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className={cls}
      />
    );
  }
  return (
    <input
      type="text"
      aria-label={label}
      aria-describedby={describedBy}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur()}
      className={cls}
    />
  );
}

function SettingRow({ row, label, sourceText, writable, resetTick, onSave }: {
  row: FilamentTreeNodeRow;
  label: string;
  sourceText: string;
  writable: boolean;
  resetTick: number;
  onSave: (body: FilamentTreeNodeUpdate) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const text = display(row.value);
  return (
    <tr className="border-b border-bambu-dark-tertiary/60 align-top">
      <td className="py-2 pr-3">
        <div className="text-sm text-bambu-gray-light">{label}</div>
        <div id={id} className="font-mono text-[11px] text-bambu-gray/50">
          {row.key}
        </div>
      </td>
      <td className="py-2 pr-3">
        {writable ? (
          <ValueInput
            key={`${text}:${resetTick}`}
            label={label}
            value={text}
            describedBy={id}
            own={row.own}
            onCommit={(next) => onSave({ set: { [row.key]: parse(next, row.value) } })}
          />
        ) : (
          <span className={`whitespace-pre-wrap break-all font-mono text-sm ${row.own ? 'font-semibold text-white' : 'text-bambu-gray/70'}`}>
            {text}
          </span>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-bambu-gray/60">
          {row.own ? (
            <>
              <span className="rounded-full bg-amber-500 px-1.5 font-semibold text-black">{t('filamentTrees.own')}</span>
              {row.inherited_value != null && <span>{t('filamentTrees.parentValue', { value: display(row.inherited_value) })}</span>}
            </>
          ) : (
            <span>{sourceText}</span>
          )}
        </div>
      </td>
      <td className="py-2 text-right">
        {writable && row.own && (
          <button
            type="button"
            onClick={() => onSave({ clear: [row.key] })}
            aria-label={t('filamentTrees.useParentFor', { field: label })}
            className="whitespace-nowrap text-xs text-sky-400 hover:text-sky-300 hover:underline"
          >
            {t('filamentTrees.useParent')}
          </button>
        )}
      </td>
    </tr>
  );
}

/** Settings of one tree node: own values bold with the parent's beside them, inherited values muted with their source. */
export function NodePanel({ node }: { node: NodeRef }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [resetTick, setResetTick] = useState(0);
  const { treeId, machine, nozzle, colorId } = node;

  const { data: trees } = useQuery({ queryKey: ['filament-trees'], queryFn: api.getFilamentTrees });
  const rowsQuery = useQuery({
    queryKey: ['filament-trees', treeId, 'node', machine ?? null, nozzle ?? null, colorId ?? null],
    queryFn: () => api.getFilamentTreeNode(treeId, { machine, nozzle, colorId }),
  });

  const save = useMutation({
    mutationFn: (body: FilamentTreeNodeUpdate) =>
      api.setFilamentTreeNode(treeId, {
        ...(machine !== undefined && { machine }),
        ...(nozzle !== undefined && { nozzle }),
        ...(colorId !== undefined && { color_id: colorId }),
        ...body,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['filament-trees'] }),
    onError: (err) => {
      setResetTick((n) => n + 1); // put the refused value back in the input
      showToast(errorMessage(err), 'error');
    },
  });

  const tree: FilamentTreeSummary | undefined = trees?.find((tr) => tr.id === treeId);
  const color = tree?.colors.find((c) => c.id === colorId);
  const colourWide = machine === undefined && colorId !== undefined;
  const isSource =
    !!tree &&
    colorId === tree.source.color_id &&
    (colourWide || (machine === tree.source.machine && nozzle === tree.source.nozzle));
  const writable = !!tree && hasPermission('filaments:update') && !isSource;
  const hidesNozzleBound = machine === undefined;

  const colourWideName = t('filamentTrees.allMachines', { color: color?.name ?? '' });
  const crumbs = (colourWide ? [tree?.name, colourWideName] : [tree?.name, machine, nozzle, color?.name]).filter(
    (c) => c !== undefined,
  );
  const sourceName: Record<FilamentTreeNodeRow['source'], string> = {
    root: tree?.name ?? '',
    machine: machine ?? '',
    nozzle: `${machine} › ${nozzle}`,
    colorwide: colourWideName,
    color: color?.name ?? '',
    bambu: '',
  };
  const sourceText = (row: FilamentTreeNodeRow) =>
    row.source === 'bambu'
      ? t('filamentTrees.fromBambu', { machine, nozzle })
      : t('filamentTrees.from', { source: sourceName[row.source] });

  const rows = (rowsQuery.data ?? []).filter((r) => !(hidesNozzleBound && NOZZLE_BOUND_KEYS.has(r.key)));
  const gcodeRow = rows.find((r) => r.key === PA_KEY);
  const gcodeText = Array.isArray(gcodeRow?.value) ? String(gcodeRow.value[0] ?? '') : display(gcodeRow?.value);
  const savePa = (k: string) => {
    const old = gcodeRow?.value;
    const next = Array.isArray(old)
      ? old.map((g) => writePaK(String(g), k))
      : old == null
        ? [writePaK('', k)]
        : writePaK(String(old), k);
    save.mutate({ set: { [PA_KEY]: next } });
  };

  return (
    <section className="min-w-0 space-y-3">
      <nav aria-label={t('filamentTrees.path')} className="text-xs text-bambu-gray/70">
        {crumbs.join(' › ')}
      </nav>
      {isSource && <p className="text-sm text-sky-300">{t('filamentTrees.sourceReadOnly')}</p>}
      {rowsQuery.isLoading ? (
        <p className="text-sm text-bambu-gray">{t('common.loading')}</p>
      ) : rowsQuery.isError ? (
        <p className="text-sm text-red-400">{errorMessage(rowsQuery.error)}</p>
      ) : (
        <>
          {writable && !hidesNozzleBound && (
            <label className="flex max-w-xs flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-bambu-gray/70">{t('filamentTrees.paK')}</span>
              <ValueInput
                key={`${gcodeText}:${resetTick}`}
                label={t('filamentTrees.paK')}
                value={readPaK(gcodeText)}
                onCommit={savePa}
              />
            </label>
          )}
          {rows.length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('filamentTrees.noValues')}</p>
          ) : (
            <table className="w-full border-collapse">
              <tbody>
                {rows.map((row) => {
                  const labelKey = FIELD_LABEL_KEYS[row.key];
                  return (
                    <SettingRow
                      key={row.key}
                      row={row}
                      label={labelKey ? t(labelKey) : row.key}
                      sourceText={sourceText(row)}
                      writable={writable}
                      resetTick={resetTick}
                      onSave={(body) => save.mutate(body)}
                    />
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
