import type { FilamentPreset } from '../../api/client';
import {
  displayColorLabel,
  displayMaterial,
  parseColorFromContent,
  parseNozzleFromCompatible,
  parsePresetChips,
} from './presetJson';

export type SettingKey = 'temp' | 'flow' | 'pa' | 'nozzle';
export type Settings = Record<SettingKey, string>;

export interface Entry {
  preset: FilamentPreset;
  settings: Settings;
  color: string;
  swatch: string;
}

export interface BrandRow {
  brand: string;
  /** First line holds the settings most colours share; further lines are variants shared by 2+ colours. */
  lines: Entry[][];
  /** Lone colours whose settings differ from the first line; they render inside it with their diff. */
  outliers: Entry[];
}

export interface MaterialGroup {
  material: string;
  count: number;
  swatches: string[];
  brands: BrandRow[];
}

export const KEYS: SettingKey[] = ['temp', 'flow', 'pa', 'nozzle'];
const fr = (a: string, b: string) => a.localeCompare(b, 'fr', { sensitivity: 'base' });
export const sig = (s: Settings) => KEYS.map((k) => s[k]).join('|');

function toEntry(preset: FilamentPreset): Entry {
  const chips = parsePresetChips(preset.content) ?? {};
  return {
    preset,
    settings: {
      temp: chips.temp ?? '',
      flow: chips.flow ?? '',
      pa: chips.pa ?? '',
      nozzle: parseNozzleFromCompatible(preset.content) ?? '',
    },
    color: displayColorLabel(preset.name, preset.color),
    swatch: preset.color_hex || parseColorFromContent(preset.content),
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/** Material sections (largest first), one row per brand, colours split by shared settings. */
export function groupPresetsByMaterial(presets: FilamentPreset[]): MaterialGroup[] {
  const byMaterial = groupBy(presets.map(toEntry), (e) =>
    displayMaterial(e.preset.name, e.preset.brand, e.preset.material),
  );
  return [...byMaterial.entries()]
    .map(([material, entries]) => ({
      material,
      count: entries.length,
      swatches: entries.map((e) => e.swatch),
      brands: [...groupBy(entries, (e) => e.preset.brand).entries()]
        .sort(([a], [b]) => fr(a, b))
        .map(([brand, rows]) => {
          rows.sort((a, b) => fr(a.color, b.color));
          // Stable sort keeps alphabetical order among equal-sized sets, so ties go to the first colour.
          const sets = [...groupBy(rows, (e) => sig(e.settings)).values()].sort((a, b) => b.length - a.length);
          return {
            brand,
            lines: [sets[0], ...sets.slice(1).filter((s) => s.length > 1)],
            outliers: sets.slice(1).filter((s) => s.length === 1).map((s) => s[0]),
          };
        }),
    }))
    .sort((a, b) => b.count - a.count || fr(a.material, b.material));
}
