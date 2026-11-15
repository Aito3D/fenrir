import { ChevronDown, ChevronRight, Crosshair } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { FilamentTreeColor, FilamentTreeSummary, FilamentTreeTargets } from '../../api/client';
import { FilamentSwatch } from '../FilamentSwatch';

export type NodeRef = { treeId: number; machine?: string; nozzle?: string; colorId?: number };

export interface TreeNavProps {
  trees: FilamentTreeSummary[];
  targets: FilamentTreeTargets;
  selected: NodeRef | null;
  onSelect: (node: NodeRef) => void;
}

const sameNode = (a: NodeRef | null, b: NodeRef) =>
  !!a && a.treeId === b.treeId && a.machine === b.machine && a.nozzle === b.nozzle && a.colorId === b.colorId;

/** Fold keys of every ancestor of the selected node, so it is visible on mount. */
function openPath(node: NodeRef | null): Set<string> {
  if (!node) return new Set();
  const t = `t${node.treeId}`;
  const keys = [t];
  if (node.machine) keys.push(`${t}/${node.machine}`);
  if (node.machine && node.nozzle) keys.push(`${t}/${node.machine}/${node.nozzle}`);
  if (!node.machine && node.colorId !== undefined) keys.push(`${t}/colors`);
  return new Set(keys);
}

function Badge({ count }: { count: number | undefined }) {
  const { t } = useTranslation();
  if (!count) return null;
  return (
    <span
      aria-label={t('filamentTrees.ownCount', { count })}
      className="rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold leading-4 text-black"
    >
      {count}
    </span>
  );
}

function SourceMark() {
  const { t } = useTranslation();
  const label = t('filamentTrees.calibrationSource');
  return (
    <span role="img" aria-label={label} title={label} className="shrink-0 text-sky-400">
      <Crosshair aria-hidden="true" className="h-3 w-3" />
    </span>
  );
}

interface RowProps {
  depth: number;
  label: ReactNode;
  /** Accessible name of the select button (unique path, e.g. "H2S › 0.6 › Red"). */
  name: string;
  fold?: { open: boolean; toggle: () => void };
  onSelect?: () => void;
  selected?: boolean;
  extra?: ReactNode;
}

function Row({ depth, label, name, fold, onSelect, selected, extra }: RowProps) {
  const { t } = useTranslation();
  const Chevron = fold?.open ? ChevronDown : ChevronRight;
  return (
    <div
      className={`flex items-center gap-1 rounded py-0.5 pr-1.5 text-sm ${selected ? 'bg-bambu-green/15 font-semibold text-white' : 'text-bambu-gray-light'}`}
      style={{ paddingLeft: `${depth * 14}px` }}
    >
      {fold ? (
        <button
          type="button"
          onClick={fold.toggle}
          aria-expanded={fold.open}
          aria-label={t('filamentTrees.toggle', { name })}
          className="rounded p-0.5 text-bambu-gray hover:text-white"
        >
          <Chevron className="h-3.5 w-3.5" />
        </button>
      ) : (
        <span className="w-[18px] shrink-0" />
      )}
      {onSelect ? (
        <button
          type="button"
          onClick={onSelect}
          aria-label={name}
          aria-current={selected ? 'true' : undefined}
          className="flex min-w-0 items-center gap-1.5 truncate text-left hover:text-white"
        >
          {label}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5 truncate">{label}</span>
      )}
      {extra}
    </div>
  );
}

function ColorLabel({ color }: { color: FilamentTreeColor }) {
  return (
    <>
      <FilamentSwatch rgba={color.hex.replace('#', '') || null} className="h-3 w-3" effectSize="table" />
      {color.name}
    </>
  );
}

/** Mockup A: tree root › machine › nozzle › colour, plus a colour-wide group under each root. */
export function TreeNav({ trees, targets, selected, onSelect }: TreeNavProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => openPath(selected));
  const fold = (key: string) => ({
    open: open.has(key),
    toggle: () =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
  });
  const row = (node: NodeRef) => ({ onSelect: () => onSelect(node), selected: sameNode(selected, node) });

  return (
    <nav aria-label={t('filamentTrees.navLabel')} className="space-y-1">
      {trees.map((tree) => {
        const tk = `t${tree.id}`;
        const counts = tree.own_counts;
        const src = tree.source;
        const srcColor = tree.colors.find((c) => c.id === src.color_id);
        const nozzles = targets.nozzles.filter((n) => !(tree.abrasive && n === '0.2'));
        return (
          <div key={tree.id}>
            <Row
              depth={0}
              name={tree.name}
              label={<span className="font-semibold">{tree.name}</span>}
              fold={fold(tk)}
              {...row({ treeId: tree.id })}
              extra={
                <>
                  <span className="truncate text-xs text-bambu-gray/70">
                    · {src.machine} {src.nozzle} {srcColor?.name ?? ''}
                  </span>
                  <Badge count={counts.root} />
                </>
              }
            />
            {open.has(tk) && (
              <>
                <Row depth={1} name={t('filamentTrees.allColours')} label={t('filamentTrees.allColours')} fold={fold(`${tk}/colors`)} />
                {open.has(`${tk}/colors`) &&
                  tree.colors.map((c) => (
                    <Row
                      key={c.id}
                      depth={2}
                      name={t('filamentTrees.allMachines', { color: c.name })}
                      label={<ColorLabel color={c} />}
                      {...row({ treeId: tree.id, colorId: c.id })}
                      extra={
                        <>
                          {c.id === src.color_id && <SourceMark />}
                          <Badge count={counts[`color:${c.id}`]} />
                        </>
                      }
                    />
                  ))}
                {targets.machines.map((m) => (
                  <div key={m}>
                    <Row depth={1} name={m} label={m} fold={fold(`${tk}/${m}`)} {...row({ treeId: tree.id, machine: m })} extra={<Badge count={counts[m]} />} />
                    {open.has(`${tk}/${m}`) &&
                      nozzles.map((n) => (
                        <div key={n}>
                          <Row
                            depth={2}
                            name={`${m} › ${n}`}
                            label={n}
                            fold={fold(`${tk}/${m}/${n}`)}
                            {...row({ treeId: tree.id, machine: m, nozzle: n })}
                            extra={<Badge count={counts[`${m}/${n}`]} />}
                          />
                          {open.has(`${tk}/${m}/${n}`) &&
                            tree.colors.map((c) => (
                              <Row
                                key={c.id}
                                depth={3}
                                name={`${m} › ${n} › ${c.name}`}
                                label={<ColorLabel color={c} />}
                                {...row({ treeId: tree.id, machine: m, nozzle: n, colorId: c.id })}
                                extra={
                                  <>
                                    {m === src.machine && n === src.nozzle && c.id === src.color_id && <SourceMark />}
                                    <Badge count={counts[`${m}/${n}/${c.id}`]} />
                                  </>
                                }
                              />
                            ))}
                        </div>
                      ))}
                  </div>
                ))}
              </>
            )}
          </div>
        );
      })}
    </nav>
  );
}
