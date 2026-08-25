import { describe, expect, it } from 'vitest';
import {
  buildJson, buildResolvedParent, computeName, displayMaterial, extractPaK,
  mergeWithParent, parseContentToForm, parsePresetChips, parseNozzleFromCompatible,
  presetComparator, rewriteCompatibleForNozzle,
} from '../../../components/filament-profiles/presetJson';
import { EMPTY_FORM } from '../../../components/filament-profiles/constants';
import type { BaseFilamentPreset, FilamentPreset } from '../../../api/client';

const form = (over: Partial<typeof EMPTY_FORM>) => ({ ...EMPTY_FORM, ...over });

describe('parseContentToForm', () => {
  it('takes first element of arrays and maps nil to empty', () => {
    const f = parseContentToForm({
      nozzle_temperature: ['230', '240'], filament_z_hop_types: ['nil'],
      filament_wipe: 'nil', filament_vendor: ['SUNLU'],
      compatible_printers: ['Bambu Lab X1C 0.4 nozzle', 'Bambu Lab P1S 0.4 nozzle'],
      filament_start_gcode: ['M900 L1000 M10\nM900 K0.024'],
      enable_pressure_advance: ['1'],
      filament_extruder_variant: ['Direct Drive Standard', 'Bowden'],
    });
    expect(f.nozzle_temperature).toBe('230');
    expect(f.filament_z_hop_types).toBe('');
    expect(f.filament_wipe).toBe('');
    expect(f.compatible_printers).toBe('Bambu Lab X1C 0.4 nozzle, Bambu Lab P1S 0.4 nozzle');
    expect(f.pa_k_value).toBe('0.024');
    expect(f.enable_pressure_advance).toBe(true);
    expect(f.filament_extruder_variant).toEqual(['Direct Drive Standard', 'Bowden']);
    expect(f.nozzle_size).toBe('0.4');
  });
});

describe('mergeWithParent', () => {
  it('fills only empty fields and never inherits synthetic ones', () => {
    const child = form({ nozzle_temperature: '250', color: '', pa_k_value: '', nozzle_size: '0.4' });
    const parent = form({ nozzle_temperature: '220', fan_max_speed: '90', color: 'Red', pa_k_value: '0.02', nozzle_size: '0.6' });
    const merged = mergeWithParent(child, parent);
    expect(merged.nozzle_temperature).toBe('250');
    expect(merged.fan_max_speed).toBe('90');
    expect(merged.color).toBe('');           // synthetic: never inherited
    expect(merged.pa_k_value).toBe('');
    expect(merged.nozzle_size).toBe('0.4');
  });
});

describe('buildJson (delta writer)', () => {
  it('skips values equal to the resolved parent (spec §9.5)', () => {
    const parent = form({ nozzle_temperature: '220', fan_max_speed: '90' });
    const f = form({ filament_vendor: 'eSUN', filament_type: 'PETG', inherits: 'Base',
                     nozzle_temperature: '220', fan_max_speed: '100' });
    const out = JSON.parse(buildJson(f, {}, parent, 'eSUN PETG'));
    expect(out.nozzle_temperature).toBeUndefined();     // equal to parent → omitted
    expect(out.fan_max_speed).toEqual(['100']);
    expect(out.inherits).toBe('Base');
    expect(out.name).toBe('eSUN PETG');
    expect(out.filament_settings_id).toEqual(['eSUN PETG']);
    expect(out.from).toBe('User');
    expect(out.version).toBe('2.4.0.8');
  });
  it('passes through unknown keys untouched (spec §9.6)', () => {
    const out = JSON.parse(buildJson(form({ filament_vendor: 'V' }), { future_key: ['x'], version: '9.9' }, null, 'V'));
    expect(out.future_key).toEqual(['x']);
    expect(out.version).toBe('9.9');
  });
  it('never writes color or synthetic fields (spec §9.7)', () => {
    const out = JSON.parse(buildJson(form({ color: 'Red', pa_k_value: '0.02', nozzle_size: '0.6', filament_vendor: 'V' }), {}, null, 'V'));
    expect(out.color).toBeUndefined();
    expect(out.pa_k_value).toBeUndefined();
    expect(out.nozzle_size).toBeUndefined();
  });
  it('maps material aliases only when writing', () => {
    const out = JSON.parse(buildJson(form({ filament_type: 'PA12-CF' }), {}, null, 'X'));
    expect(out.filament_type).toEqual(['PA-CF']);
  });
  it('omits filament_type when the form value aliases to the same material as the parent (spec §9.5 alias leak)', () => {
    // Parent stores the canonical name; the form has a synonym that aliases
    // to the same canonical value — this must be recognized as "unchanged"
    // rather than re-emitting filament_type on every save.
    const parent = form({ filament_type: 'PA-CF' });
    const out = JSON.parse(buildJson(form({ filament_type: 'PA12-CF' }), {}, parent, 'X'));
    expect(out.filament_type).toBeUndefined();
  });
  it('splits compatible_printers into a real array', () => {
    const out = JSON.parse(buildJson(form({ compatible_printers: 'A 0.4 nozzle, B 0.4 nozzle' }), {}, null, 'X'));
    expect(out.compatible_printers).toEqual(['A 0.4 nozzle', 'B 0.4 nozzle']);
  });
  it('serializes with 4-space indentation', () => {
    expect(buildJson(form({}), {}, null, 'X')).toContain('\n    "name"');
  });
});

describe('buildResolvedParent', () => {
  const bp = (name: string, filename: string): BaseFilamentPreset =>
    ({ id: 1, name, inherits: '', brand: '', material: '', color: '', color_hex: '', filename });
  const up = (name: string, content: string): FilamentPreset =>
    ({ id: 1, name, brand: '', material: '', color: '', color_hex: '', filename: '', content });

  it('user presets shadow base presets and chains fold root-first (spec §9.12)', async () => {
    const user = [up('Mid', JSON.stringify({ inherits: 'Root', nozzle_temperature: ['250'] }))];
    const bases = [bp('Root', 'root.json'), bp('Mid', 'mid-base.json')];
    const fetched: string[] = [];
    const fetchBase = async (fn: string) => {
      fetched.push(fn);
      return JSON.stringify({ nozzle_temperature: ['200'], fan_max_speed: ['80'] });
    };
    const merged = await buildResolvedParent('Mid', user, bases, fetchBase);
    expect(fetched).toEqual(['root.json']);       // user 'Mid' won; only Root fetched
    expect(merged?.nozzle_temperature).toBe('250');
    expect(merged?.fan_max_speed).toBe('80');
  });
  it('cycle guard stops and folds both levels (spec §9.13)', async () => {
    const user = [
      up('A', JSON.stringify({ inherits: 'B' })),
      up('B', JSON.stringify({ inherits: 'A', fan_max_speed: ['80'] })),
    ];
    const merged = await buildResolvedParent('A', user, [], async () => '{}');
    expect(merged).not.toBeNull();               // terminates, no hang
    expect(merged?.fan_max_speed).toBe('80');     // B's field folds into the merged result
  });
  it('unknown parent → null', async () => {
    expect(await buildResolvedParent('Ghost', [], [], async () => { throw new Error('404'); })).toBeNull();
  });
});

describe('card helpers', () => {
  it('parsePresetChips', () => {
    const content = JSON.stringify({ nozzle_temperature: ['230'], filament_flow_ratio: ['0.98'],
      filament_start_gcode: ['M900 L1000 M10\nM900 K0.04'] });
    expect(parsePresetChips(content)).toEqual({ temp: '230', flow: '0.98', pa: '0.04' });
    expect(parsePresetChips('{broken')).toBeNull();
  });
  it('parseNozzleFromCompatible', () => {
    expect(parseNozzleFromCompatible(JSON.stringify({ compatible_printers: ['Bambu Lab X1C 0.4 nozzle'] }))).toBe('0.4');
  });
  it('displayMaterial strips brand and takes pre-dash segment (spec §5.5)', () => {
    expect(displayMaterial('SUNLU PA12-CF - Black', 'SUNLU', 'PA-CF')).toBe('PA12-CF');
    expect(displayMaterial('', '', 'PETG')).toBe('PETG');
    expect(displayMaterial('', '', '')).toBe('—');
  });
  it('rewriteCompatibleForNozzle only touches the four models', () => {
    expect(rewriteCompatibleForNozzle('Bambu Lab H2S 0.4 nozzle, Bambu Lab X1C 0.4 nozzle', '0.6'))
      .toBe('Bambu Lab H2S 0.6 nozzle, Bambu Lab X1C 0.4 nozzle');
  });
  it('computeName', () => {
    expect(computeName('SUNLU', 'PETG', 'Magenta')).toBe('SUNLU PETG - Magenta');
    expect(computeName('', 'PETG', '')).toBe('PETG');
    expect(computeName('', '', '')).toBe('');
  });
  it('extractPaK', () => {
    expect(extractPaK('M900 L1000 M10\nM900 K0.024')).toBe('0.024');
    expect(extractPaK('')).toBe('');
  });
  it('presetComparator is accent-insensitive with name tiebreak', () => {
    const p = (name: string, brand: string) => ({ name, brand } as FilamentPreset);
    const list = [p('b', 'Ésun'), p('a', 'esun'), p('c', 'Bambu')];
    list.sort(presetComparator('brand'));
    expect(list.map((x) => x.name)).toEqual(['c', 'a', 'b']);
  });
});

describe('buildJson enable_pressure_advance truth table', () => {
  it('no parent + false -> key omitted', () => {
    const out = JSON.parse(buildJson(form({ enable_pressure_advance: false }), {}, null, 'X'));
    expect(out.enable_pressure_advance).toBeUndefined();
  });
  it('no parent + true -> [\'1\']', () => {
    const out = JSON.parse(buildJson(form({ enable_pressure_advance: true }), {}, null, 'X'));
    expect(out.enable_pressure_advance).toEqual(['1']);
  });
  it('parent true + false -> [\'0\']', () => {
    const parent = form({ enable_pressure_advance: true });
    const out = JSON.parse(buildJson(form({ enable_pressure_advance: false }), {}, parent, 'X'));
    expect(out.enable_pressure_advance).toEqual(['0']);
  });
  it('parent true + true -> omitted', () => {
    const parent = form({ enable_pressure_advance: true });
    const out = JSON.parse(buildJson(form({ enable_pressure_advance: true }), {}, parent, 'X'));
    expect(out.enable_pressure_advance).toBeUndefined();
  });
});

describe('buildJson filament_extruder_variant parent compare', () => {
  it('equal arrays (same order) -> omitted', () => {
    const parent = form({ filament_extruder_variant: ['Direct Drive Standard', 'Bowden'] });
    const out = JSON.parse(
      buildJson(form({ filament_extruder_variant: ['Direct Drive Standard', 'Bowden'] }), {}, parent, 'X'),
    );
    expect(out.filament_extruder_variant).toBeUndefined();
  });
  it('different order -> written', () => {
    const parent = form({ filament_extruder_variant: ['Direct Drive Standard', 'Bowden'] });
    const out = JSON.parse(
      buildJson(form({ filament_extruder_variant: ['Bowden', 'Direct Drive Standard'] }), {}, parent, 'X'),
    );
    expect(out.filament_extruder_variant).toEqual(['Bowden', 'Direct Drive Standard']);
  });
});

describe('buildJson compatible_printers parent compare', () => {
  it('equal comma-string vs parent -> omitted', () => {
    const parent = form({ compatible_printers: 'A 0.4 nozzle, B 0.4 nozzle' });
    const out = JSON.parse(
      buildJson(form({ compatible_printers: 'A 0.4 nozzle, B 0.4 nozzle' }), {}, parent, 'X'),
    );
    expect(out.compatible_printers).toBeUndefined();
  });
  it('different -> written', () => {
    const parent = form({ compatible_printers: 'A 0.4 nozzle, B 0.4 nozzle' });
    const out = JSON.parse(
      buildJson(form({ compatible_printers: 'B 0.4 nozzle, A 0.4 nozzle' }), {}, parent, 'X'),
    );
    expect(out.compatible_printers).toEqual(['B 0.4 nozzle', 'A 0.4 nozzle']);
  });
});

describe('nil round-trip', () => {
  it('parseContentToForm maps nil to empty and buildJson omits the key', () => {
    const f = parseContentToForm({ filament_z_hop_types: ['nil'] });
    expect(f.filament_z_hop_types).toBe('');
    const out = JSON.parse(buildJson(f, {}, null, 'X'));
    expect(out.filament_z_hop_types).toBeUndefined();
  });
});

describe('EMPTY_FORM.filament_extruder_variant isolation', () => {
  it('gives each parse a fresh array and never mutates EMPTY_FORM', () => {
    const a = parseContentToForm({});
    const b = parseContentToForm({});
    expect(a.filament_extruder_variant).not.toBe(b.filament_extruder_variant);
    a.filament_extruder_variant.push('Bowden');
    expect(EMPTY_FORM.filament_extruder_variant).toEqual([]);
  });
});
