import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../api/client';
import type { FilamentTreeNodeRow } from '../../api/client';
import { Button } from '../Button';
import { focusRingCls } from '../formStyles';

type View = 'own' | 'resolved' | 'profile';

/** Raw JSON of a node: its own values, everything it resolves to, and for a leaf the exact profile sent to Orca. */
/** "Tree @H2S 0.4+0.6" covers "Tree @H2S 0.6": a leaf can merge nozzles. */
function covers(name: string, want: string) {
  const cut = (s: string) => [s.slice(0, s.lastIndexOf(' ')), s.slice(s.lastIndexOf(' ') + 1)];
  const [head, nozzles] = cut(name);
  const [wantHead, wantNozzle] = cut(want);
  return head === wantHead && nozzles.split('+').includes(wantNozzle);
}

export function JsonView({ rows, leafNames }: {
  rows: FilamentTreeNodeRow[];
  /** Preset names that may hold this leaf, first match wins: the colour's own, then the colour-less shared one. */
  leafNames?: string[];
}) {
  const leafName = leafNames?.[0];
  const { t } = useTranslation();
  const [view, setView] = useState<View>(leafName ? 'profile' : 'own');
  const [copied, setCopied] = useState<boolean | null>(null);
  const presets = useQuery({ queryKey: ['filamentPresets'], queryFn: api.getFilamentPresets, enabled: !!leafName });

  const current: View = !leafName && view === 'profile' ? 'own' : view;
  const own = Object.fromEntries(rows.filter((r) => r.own).map((r) => [r.key, r.value]));
  const resolved = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const profile = leafNames
    ?.map((want) => presets.data?.find((p) => covers(p.name, want)))
    .find(Boolean)?.content;
  const text =
    current === 'own'
      ? JSON.stringify(own, null, 4)
      : current === 'resolved'
        ? JSON.stringify(resolved, null, 4)
        : presets.isLoading
          ? t('common.loading')
          : (profile ?? t('filamentTrees.jsonNoProfile'));

  const views: View[] = leafName ? ['profile', 'own', 'resolved'] : ['own', 'resolved'];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked (insecure origin / permissions): the text stays selectable
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t('filamentTrees.jsonTitle')} className="flex gap-1">
          {views.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={v === current}
              onClick={() => setView(v)}
              className={`btn-press rounded-full px-2.5 py-0.5 text-xs ${focusRingCls} ${
                v === current ? 'bg-bambu-green/20 text-bambu-green' : 'bg-bambu-dark text-bambu-gray hover:text-bambu-gray-light'
              }`}
            >
              {t(`filamentTrees.json_${v}`)}
            </button>
          ))}
        </div>
        <Button size="sm" variant="secondary" className="ml-auto" onClick={copy}>
          <span key={String(copied)} className={copied === null ? '' : 'animate-aito-swap'}>
            {copied ? t('common.copied') : t('common.copy')}
          </span>
        </Button>
      </div>
      <p className="text-xs text-bambu-gray">{t(`filamentTrees.json_${current}Hint`)}</p>
      <pre
        aria-label={t(`filamentTrees.json_${current}`)}
        className="max-h-[70vh] overflow-auto whitespace-pre rounded-md border border-bambu-dark-tertiary bg-bambu-dark p-3 font-mono text-xs text-bambu-gray-light"
      >
        {text}
      </pre>
    </div>
  );
}
