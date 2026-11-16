import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDownToLine, ArrowRight, ArrowUpFromLine, CheckCircle2, ChevronRight, Trash2 } from 'lucide-react';

import type { FilamentTreeSyncPreview } from '../../api/client';
import { Button } from '../Button';
import { Dialog } from './Dialog';
import { display } from './display';
import { ConflictRow } from './SyncResultModal';

interface Item { name: string; changes?: Record<string, [unknown, unknown]>; new?: boolean }
interface Variant extends Item { label: string }

/** "Brand Material - Colour @H2C 0.2" → one row per filament, its printer/nozzle presets inside. A name without " @" is its own row. */
function groupByFilament(items: Item[]): Array<[string, Variant[]]> {
  const groups = new Map<string, Variant[]>();
  for (const item of items) {
    const at = item.name.lastIndexOf(' @');
    const filament = at < 0 ? item.name : item.name.slice(0, at);
    const group = groups.get(filament) ?? [];
    group.push({ ...item, label: at < 0 ? '' : item.name.slice(at + 2) });
    groups.set(filament, group);
  }
  return [...groups];
}

function NewTag() {
  const { t } = useTranslation();
  return <span className="rounded-full bg-sky-400/15 px-1.5 py-0.5 text-[0.7rem] font-semibold text-sky-300">{t('filamentProfiles.statNew')}</span>;
}

function Section({ icon, title, items, tone = 'green', muted }: {
  icon: ReactNode;
  title: ReactNode;
  items: Item[];
  tone?: 'green' | 'red';
  muted?: boolean;
}) {
  const red = tone === 'red';
  return (
    <section className="space-y-2">
      <h4 className={`flex items-start gap-2 text-sm font-semibold ${red ? 'text-red-400' : 'text-white'}`}>
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${red ? 'bg-red-400/15 text-red-400' : 'bg-bambu-green/15 text-bambu-green'}`}>{icon}</span>
        {title}
      </h4>
      <ul className={`divide-y divide-bambu-dark-tertiary overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark/40 transition-opacity ${muted ? 'opacity-40' : ''}`}>
        {groupByFilament(items).map(([filament, variants]) => {
          const expandable = variants.some((v) => v.label || v.changes);
          const row = (
            <>
              <ChevronRight className={`h-4 w-4 shrink-0 text-bambu-gray transition-transform group-open:rotate-90 ${expandable ? '' : 'invisible'}`} />
              <span className="min-w-0 flex-1 truncate text-sm text-white">{filament}</span>
              {variants.every((v) => v.new) && <NewTag />}
              <span className="rounded-full bg-bambu-dark-tertiary px-2 py-0.5 text-xs tabular-nums text-bambu-gray">{variants.length}</span>
            </>
          );
          if (!expandable) return <li key={filament} className="flex items-center gap-2 px-3 py-2">{row}</li>;
          const withChanges = variants.some((v) => v.changes);
          return (
            <li key={filament}>
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-white/5 [&::-webkit-details-marker]:hidden">
                  {row}
                </summary>
                <ul className={`px-9 pb-3 pt-1 ${withChanges ? 'space-y-2' : 'flex flex-wrap gap-1.5'}`}>
                  {variants.map((v) => (
                    <li key={v.name} className={withChanges ? 'space-y-1' : 'flex items-center gap-1'}>
                      <span className="shrink-0 rounded bg-bambu-dark-tertiary px-1.5 py-0.5 font-mono text-xs text-white">{v.label || v.name}</span>
                      {/* tagged per preset only when the filament row could not say it for all of them */}
                      {v.new && !variants.every((x) => x.new) && <NewTag />}
                      {Object.entries(v.changes ?? {}).map(([key, [from, to]]) => (
                        <div key={key} className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs">
                          <span className="break-all text-bambu-gray">{key}</span>
                          <span className="break-all text-bambu-gray line-through">{display(from)}</span>
                          <ArrowRight className="h-3 w-3 shrink-0 self-center text-bambu-gray" aria-hidden />
                          <span className="break-all text-white">{display(to)}</span>
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What a SYNC is about to do, shown before anything is sent: the operator settles conflicts, then confirms or closes. */
export function SyncPreviewModal({ preview, onConfirm, onResolved, onClose }: {
  preview: FilamentTreeSyncPreview;
  /** remove: also delete the Orca Cloud filaments that are no Fenrir leaf */
  onConfirm: (remove: boolean) => void;
  /** a conflict was settled: the plan (and its fingerprint) has changed */
  onResolved: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { pull, push, remove, conflicts, writable } = preview;
  const [alsoRemove, setAlsoRemove] = useState(true);
  // settled rows fold shut at once; the refreshed preview then drops them
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const id = (c: { name: string; key: string }) => `${c.name}|${c.key}`;
  const open = conflicts.filter((c) => !resolved.has(id(c)));
  const count = (icon: ReactNode, n: number) =>
    n > 0 && (
      <span className="flex items-center gap-0.5 tabular-nums opacity-90">
        {icon}
        {n}
      </span>
    );
  return (
    <Dialog
      title={t('filamentTrees.syncPreviewTitle')}
      onClose={onClose}
      footer={
        // always offered: a sync with nothing listed still records what Orca holds as the baseline
        <Button onClick={() => onConfirm(alsoRemove)}>
          {t('common.confirm')}
          {count(<ArrowDownToLine className="h-3.5 w-3.5" aria-hidden />, pull.length)}
          {count(<ArrowUpFromLine className="h-3.5 w-3.5" aria-hidden />, push.length)}
          {alsoRemove && count(<Trash2 className="h-3.5 w-3.5" aria-hidden />, remove.length)}
        </Button>
      }
    >
      {pull.length + push.length + remove.length + conflicts.length === 0 && (
        <p className="flex flex-col items-center gap-2 py-6 text-sm text-bambu-gray">
          <CheckCircle2 className="h-8 w-8 animate-slice-done text-bambu-green" />
          {t('filamentTrees.syncPreviewNothing')}
        </p>
      )}
      {!writable && push.length + remove.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {t('filamentTrees.syncReadOnly')}{' '}
            <Link to="/profiles" className="text-sky-400 hover:underline">
              {t('filamentTrees.orcaConnect')}
            </Link>
          </span>
        </p>
      )}
      {open.length > 0 && (
        <section className="space-y-2">
          <h4 className="flex items-start gap-2 text-sm font-semibold text-amber-400">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-400/15">
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
            {t('filamentTrees.conflictsTitle')} ({open.length})
          </h4>
          <p className="text-xs text-bambu-gray">{t('filamentTrees.conflictsHint')}</p>
          <ul>
            {conflicts.map((c) => (
              <ConflictRow
                key={id(c)}
                conflict={c}
                leafName={c.name}
                open={!resolved.has(id(c))}
                onResolved={() => {
                  setResolved((prev) => new Set(prev).add(id(c)));
                  onResolved();
                }}
              />
            ))}
          </ul>
        </section>
      )}
      {pull.length > 0 && (
        <Section icon={<ArrowDownToLine className="h-3.5 w-3.5" />} title={t('filamentTrees.syncPreviewPull', { n: pull.length })} items={pull} />
      )}
      {push.length > 0 && (
        <Section icon={<ArrowUpFromLine className="h-3.5 w-3.5" />} title={t('filamentTrees.syncPreviewPush', { n: push.length })} items={push} />
      )}
      {remove.length > 0 && (
        <Section
          tone="red"
          muted={!alsoRemove}
          icon={<Trash2 className="h-3.5 w-3.5" />}
          title={
            // the one destructive step is the operator's to untick
            <label className="flex cursor-pointer items-start gap-2">
              <span className="flex-1">{t('filamentTrees.cleanOrcaConfirm', { n: remove.length })}</span>
              <input
                type="checkbox"
                checked={alsoRemove}
                onChange={(e) => setAlsoRemove(e.target.checked)}
                className="mt-1 h-4 w-4 shrink-0 accent-red-400"
              />
            </label>
          }
          items={remove.map((name) => ({ name }))}
        />
      )}
    </Dialog>
  );
}
