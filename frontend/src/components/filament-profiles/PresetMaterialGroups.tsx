import { ChevronRight, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FilamentPreset } from '../../api/client';
import { Card } from '../Card';
import { materialFamilyClass } from './constants';
import { groupPresetsByMaterial, KEYS, sig, type Entry, type SettingKey, type Settings } from './presetGroups';

const FORMAT: Record<SettingKey, (v: string) => string> = {
  temp: (v) => `${v}°C`,
  flow: (v) => `×${v}`,
  pa: (v) => `PA ${v}`,
  nozzle: (v) => `⌀${v}mm`,
};

const CHIP_CLASS: Record<SettingKey, string> = {
  temp: 'bg-rose-500/10 text-rose-300',
  flow: 'bg-sky-500/10 text-sky-300',
  pa: 'bg-amber-500/10 text-amber-300',
  nozzle: 'bg-bambu-green/10 text-bambu-green',
};

function SettingChips({ settings }: { settings: Settings }) {
  return (
    <div className="flex flex-wrap gap-1.5 font-mono text-xs">
      {KEYS.filter((k) => settings[k] !== '').map((k) => (
        <span key={k} className={`rounded px-1.5 py-0.5 ${CHIP_CLASS[k]}`}>
          {FORMAT[k](settings[k])}
        </span>
      ))}
    </div>
  );
}

function ColorChip({ entry, base, onOpen }: { entry: Entry; base?: Settings; onOpen: () => void }) {
  const { t } = useTranslation();
  const diffs = base ? KEYS.filter((k) => entry.settings[k] !== base[k]) : [];
  return (
    <button
      type="button"
      onClick={onOpen}
      title={entry.preset.name}
      className={`flex items-center gap-2 rounded-lg border py-1 pl-1 pr-2.5 text-sm text-bambu-gray-light transition-colors hover:border-bambu-green/40 hover:text-white ${diffs.length ? 'border-amber-500/50 bg-amber-500/5' : 'border-bambu-dark-tertiary'}`}
    >
      <span
        className="h-6 w-6 shrink-0 rounded-md ring-1 ring-white/10"
        style={{ backgroundColor: entry.swatch || '#444' }}
      />
      {entry.color || entry.preset.name}
      {diffs.map((k) => (
        <span
          key={k}
          title={t('filamentProfiles.groupLineValue', { value: base![k] ? FORMAT[k](base![k]) : '—' })}
          className="rounded bg-amber-500/15 px-1 font-mono text-[11px] text-amber-300"
        >
          {entry.settings[k] ? FORMAT[k](entry.settings[k]) : '—'}
        </span>
      ))}
    </button>
  );
}

export interface PresetMaterialGroupsProps {
  presets: FilamentPreset[];
  onOpen: (preset: FilamentPreset) => void;
  /** Duplicates a preset of the row so the new colour starts from its settings; omitted without create permission. */
  onAddColor?: (preset: FilamentPreset) => void;
}

export function PresetMaterialGroups({ presets, onOpen, onAddColor }: PresetMaterialGroupsProps) {
  const { t } = useTranslation();
  const groups = groupPresetsByMaterial(presets);
  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const family = materialFamilyClass(group.material);
        return (
          <Card key={group.material} className={`overflow-hidden border-l-[3px] border-l-current ${family}`}>
            <details open className="group/section">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-white/[.02] [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-4 w-4 text-bambu-gray transition-transform group-open/section:rotate-90" />
                <span className="font-mono text-lg font-bold">{group.material}</span>
                <span className="text-sm text-bambu-gray">
                  {group.count === 1
                    ? t('filamentProfiles.countOne', { n: group.count })
                    : t('filamentProfiles.countOther', { n: group.count })}
                </span>
                <span className="flex flex-wrap gap-1">
                  {group.swatches.slice(0, 24).map((swatch, i) => (
                    <span
                      key={i}
                      className="h-3 w-3 rounded-full ring-1 ring-black/40"
                      style={{ backgroundColor: swatch || '#444' }}
                    />
                  ))}
                </span>
              </summary>
              <div className="divide-y divide-bambu-dark-tertiary border-t border-bambu-dark-tertiary">
                {group.brands.map((row) => (
                  <div key={row.brand} className="space-y-2.5 px-4 py-3">
                    {row.lines.map((line, i) => (
                      <div
                        key={sig(line[0].settings)}
                        className={`grid gap-3 md:grid-cols-[13rem_1fr] ${i ? 'border-t border-dashed border-bambu-dark-tertiary pt-2.5' : ''}`}
                      >
                        <div className="space-y-1.5">
                          {i === 0 ? (
                            <div className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-bambu-gray">
                              {row.brand || '—'}
                              {onAddColor && (
                                <button
                                  type="button"
                                  onClick={() => onAddColor(line[0].preset)}
                                  aria-label={t('filamentProfiles.groupAddColor')}
                                  title={t('filamentProfiles.groupAddColor')}
                                  className="rounded p-0.5 text-bambu-gray/60 hover:bg-bambu-dark-tertiary hover:text-white"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          ) : (
                            <div className="text-xs text-amber-300/80">{t('filamentProfiles.groupVariant')}</div>
                          )}
                          <SettingChips settings={line[0].settings} />
                        </div>
                        <div className="flex flex-wrap content-start gap-1.5">
                          {line.map((entry) => (
                            <ColorChip key={entry.preset.id} entry={entry} onOpen={() => onOpen(entry.preset)} />
                          ))}
                          {i === 0 &&
                            row.outliers.map((entry) => (
                              <ColorChip
                                key={entry.preset.id}
                                entry={entry}
                                base={line[0].settings}
                                onOpen={() => onOpen(entry.preset)}
                              />
                            ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          </Card>
        );
      })}
    </div>
  );
}
