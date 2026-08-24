import type { BaseFilamentPreset, FilamentPreset } from '../../api/client';
import { EMPTY_FORM, MATERIAL_ALIASES, SYNTHETIC_FIELDS } from './constants';
import type { PresetForm, SortField } from './types';

const NIL = 'nil';

/**
 * All PresetForm fields that are plain strings read/written using the generic
 * "first array element, 'nil' -> ''" rule. Excludes the three synthetic fields
 * (color, nozzle_size, pa_k_value) and the fields with bespoke serialization
 * (enable_pressure_advance, filament_extruder_variant, compatible_printers).
 */
const STRING_FIELDS = [
  'inherits', 'filament_vendor', 'filament_type', 'default_filament_colour', 'filament_notes',
  'nozzle_temperature', 'nozzle_temperature_initial_layer', 'nozzle_temperature_range_low',
  'nozzle_temperature_range_high', 'cool_plate_temp', 'cool_plate_temp_initial_layer',
  'eng_plate_temp', 'eng_plate_temp_initial_layer', 'hot_plate_temp', 'hot_plate_temp_initial_layer',
  'textured_plate_temp', 'textured_plate_temp_initial_layer', 'supertack_plate_temp',
  'supertack_plate_temp_initial_layer', 'fan_max_speed', 'fan_min_speed',
  'close_fan_the_first_x_layers', 'close_additional_fan_first_x_layers', 'fan_cooling_layer_time',
  'overhang_fan_speed', 'during_print_exhaust_fan_speed', 'complete_print_exhaust_fan_speed',
  'pressure_advance', 'filament_flow_ratio', 'filament_max_volumetric_speed', 'filament_prime_volume',
  'filament_retraction_length', 'filament_retraction_speed', 'filament_retract_when_changing_layer',
  'filament_wipe', 'filament_z_hop', 'filament_z_hop_types', 'filament_deretraction_speed',
  'filament_wipe_distance', 'filament_retract_before_wipe', 'slow_down_layer_time',
  'slow_down_min_speed', 'filament_cost', 'filament_density', 'filament_shrink',
  'temperature_vitrification', 'chamber_temperatures', 'additional_cooling_fan_speed',
  'enable_overhang_bridge_fan', 'first_x_layer_fan_speed', 'pre_start_fan_time',
  'overhang_fan_threshold', 'filament_start_gcode', 'filament_end_gcode',
] as const;

// Compile-time guarantee that every entry above is really a string field of PresetForm.
const _stringFieldsCheck: readonly (keyof PresetForm)[] = STRING_FIELDS;
void _stringFieldsCheck;

type StringField = (typeof STRING_FIELDS)[number];

/** Fields written back to JSON as a plain `[value]` array (everything except filament_type/filament_notes). */
const ARRAY_STRING_FIELDS = STRING_FIELDS.filter(
  (f): f is Exclude<StringField, 'inherits' | 'filament_type' | 'filament_notes'> =>
    f !== 'inherits' && f !== 'filament_type' && f !== 'filament_notes',
);

/** Reads a Bambu Studio delta value: array -> first element, 'nil' (string or first element) -> ''. */
function readString(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null) return '';
  const str = String(value);
  return str === NIL ? '' : str;
}

export function extractPaK(gcode: string): string {
  const match = gcode.match(/M900 K([\d.]+)/);
  return match ? match[1] : '';
}

export function parseNozzleFromName(name: string): string | null {
  const match = name.match(/@BBL H2S ([\d.]+)mm/);
  return match ? match[1] : null;
}

export function computeName(vendor: string, type: string, colorLabel: string): string {
  const base = [vendor, type].filter((s) => s !== '').join(' ');
  if (colorLabel === '') return base;
  return base === '' ? colorLabel : `${base} - ${colorLabel}`;
}

export function parseContentToForm(data: Record<string, unknown>, colorLabel?: string): PresetForm {
  // filament_extruder_variant must never alias EMPTY_FORM's frozen shared array.
  const form: PresetForm = { ...EMPTY_FORM, filament_extruder_variant: [] };

  for (const field of STRING_FIELDS) {
    if (field in data) {
      form[field] = readString(data[field]);
    }
  }

  if ('compatible_printers' in data) {
    const cp = data.compatible_printers;
    if (Array.isArray(cp)) {
      form.compatible_printers = cp.filter((v): v is string => typeof v === 'string').join(', ');
    } else if (typeof cp === 'string') {
      form.compatible_printers = cp;
    }
  }

  if ('filament_extruder_variant' in data) {
    const fev = data.filament_extruder_variant;
    if (Array.isArray(fev)) {
      form.filament_extruder_variant = fev.filter((v): v is string => typeof v === 'string');
    } else if (typeof fev === 'string') {
      form.filament_extruder_variant = fev === '' || fev === NIL ? [] : [fev];
    }
  }

  if ('enable_pressure_advance' in data) {
    const epa = data.enable_pressure_advance;
    if (Array.isArray(epa)) {
      const first = epa[0];
      form.enable_pressure_advance = first === '1' || first === 'true' || first === true;
    } else {
      form.enable_pressure_advance = epa === true || epa === '1' || epa === 'true';
    }
  }

  form.pa_k_value = extractPaK(form.filament_start_gcode);
  form.nozzle_size = '0.4';
  form.color = colorLabel ?? '';

  return form;
}

export function mergeWithParent(child: PresetForm, parent: PresetForm): PresetForm {
  const merged: PresetForm = { ...child };

  // inherits names the child's OWN parent pointer; the resolved parent's inherits
  // (i.e. its own grandparent pointer) must never leak into the child's form.
  for (const field of STRING_FIELDS) {
    if (field === 'inherits') continue;
    merged[field] = child[field] !== '' ? child[field] : parent[field];
  }

  merged.compatible_printers = child.compatible_printers !== '' ? child.compatible_printers : parent.compatible_printers;
  merged.enable_pressure_advance = child.enable_pressure_advance || parent.enable_pressure_advance;
  merged.filament_extruder_variant =
    child.filament_extruder_variant.length > 0
      ? child.filament_extruder_variant
      : [...parent.filament_extruder_variant];

  // Synthetic fields are never inherited from a parent.
  for (const field of SYNTHETIC_FIELDS) {
    merged[field] = child[field];
  }

  return merged;
}

export async function buildResolvedParent(
  inherits: string,
  userPresets: FilamentPreset[],
  basePresets: BaseFilamentPreset[],
  fetchBaseContent: (filename: string) => Promise<string>,
): Promise<PresetForm | null> {
  const chain: PresetForm[] = [];
  const visited = new Set<string>();
  let current = inherits;

  while (current && !visited.has(current)) {
    visited.add(current);

    const userPreset = userPresets.find((p) => p.name === current);
    let content: string;

    if (userPreset) {
      content = userPreset.content;
    } else {
      const basePreset = basePresets.find((p) => p.name === current);
      if (!basePreset) break;
      try {
        content = await fetchBaseContent(basePreset.filename);
      } catch {
        break;
      }
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(content) as Record<string, unknown>;
    } catch {
      break;
    }

    const parsed = parseContentToForm(data);
    chain.unshift(parsed);
    current = parsed.inherits;
  }

  if (chain.length === 0) return null;

  let resolved = chain[0];
  for (let i = 1; i < chain.length; i++) {
    resolved = mergeWithParent(chain[i], resolved);
  }
  return resolved;
}

const KNOWN_KEYS = new Set<string>([...Object.keys(EMPTY_FORM), 'name', 'filament_settings_id', 'from', 'version']);

export function buildJson(
  form: PresetForm,
  baseData: Record<string, unknown>,
  resolvedParent: PresetForm | null,
  computedName: string,
): string {
  const out: Record<string, unknown> = {};

  // Step 1: pass unknown baseData keys through untouched.
  for (const [key, value] of Object.entries(baseData)) {
    if (!KNOWN_KEYS.has(key)) {
      out[key] = value;
    }
  }

  // Step 2: forced identity fields.
  out.name = computedName;
  out.filament_settings_id = [computedName];
  out.from = 'User';
  out.inherits = form.inherits;
  out.version = (baseData as { version?: unknown }).version ?? '2.4.0.8';

  // Step 3: per-field delta against the resolved parent.
  for (const field of ARRAY_STRING_FIELDS) {
    const value = form[field];
    if (value === '') continue;
    if (resolvedParent && resolvedParent[field] === value) continue;
    out[field] = [value];
  }

  if (form.filament_notes !== '' && (!resolvedParent || resolvedParent.filament_notes !== form.filament_notes)) {
    out.filament_notes = form.filament_notes;
  }

  if (form.filament_type !== '') {
    const aliasedForm = MATERIAL_ALIASES[form.filament_type] ?? form.filament_type;
    // Alias-map BOTH sides before comparing: a resolved parent's raw
    // filament_type (e.g. "PA-CF") and the form's aliased equivalent for a
    // synonym typed in the picker (e.g. "PA12-CF" -> "PA-CF") must be
    // recognized as unchanged, or the delta wrongly re-emits filament_type.
    const aliasedParent = resolvedParent
      ? (MATERIAL_ALIASES[resolvedParent.filament_type] ?? resolvedParent.filament_type)
      : undefined;
    if (!resolvedParent || aliasedParent !== aliasedForm) {
      out.filament_type = [aliasedForm];
    }
  }

  const parentEpa = resolvedParent?.enable_pressure_advance ?? false;
  if (form.enable_pressure_advance !== parentEpa && (resolvedParent !== null || form.enable_pressure_advance)) {
    out.enable_pressure_advance = [form.enable_pressure_advance ? '1' : '0'];
  }

  if (form.filament_extruder_variant.length > 0) {
    const parentVariant = resolvedParent?.filament_extruder_variant ?? [];
    const same =
      parentVariant.length === form.filament_extruder_variant.length &&
      form.filament_extruder_variant.every((v, i) => v === parentVariant[i]);
    if (!same) {
      out.filament_extruder_variant = form.filament_extruder_variant;
    }
  }

  if (form.compatible_printers !== '') {
    const list = form.compatible_printers
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (list.length > 0) {
      const parentList = resolvedParent
        ? resolvedParent.compatible_printers
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== '')
        : [];
      const same = resolvedParent
        ? parentList.length === list.length && list.every((v, i) => v === parentList[i])
        : false;
      if (!same) {
        out.compatible_printers = list;
      }
    }
  }

  return JSON.stringify(out, null, 4);
}

export function parsePresetChips(content: string): { temp?: string; flow?: string; pa?: string } | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }

  const result: { temp?: string; flow?: string; pa?: string } = {};

  const temp = readString(data.nozzle_temperature);
  if (temp !== '') result.temp = temp;

  const flow = readString(data.filament_flow_ratio);
  if (flow !== '') result.flow = flow;

  const pa = extractPaK(readString(data.filament_start_gcode));
  if (pa !== '') result.pa = pa;

  return result;
}

export function parseNozzleFromCompatible(content: string): string | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }

  const cp = data.compatible_printers;
  let first: string | null = null;
  if (Array.isArray(cp) && typeof cp[0] === 'string') {
    first = cp[0];
  } else if (typeof cp === 'string') {
    first = cp;
  }
  if (first === null) return null;

  const match = first.match(/([\d.]+)\s*nozzle/i);
  return match ? match[1] : null;
}

export function displayMaterial(name: string, brand: string, material: string): string {
  if (!name) {
    return material || '—';
  }

  let working = name;
  if (brand && working.startsWith(brand)) {
    working = working.slice(brand.length).replace(/^[-\s]+/, '');
  }

  const dashIndex = working.indexOf(' - ');
  if (dashIndex !== -1) {
    working = working.slice(0, dashIndex);
  }

  working = working.trim();
  return working || material || '—';
}

export function presetComparator(field: SortField): (a: FilamentPreset, b: FilamentPreset) => number {
  return (a, b) => {
    const primary = String(a[field] ?? '').localeCompare(String(b[field] ?? ''), 'fr', { sensitivity: 'base' });
    if (primary !== 0) return primary;
    return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
  };
}

const NOZZLE_TAG_PATTERN = /^(Bambu Lab (?:H2S|H2D|H2C|X2D)) [\d.]+ nozzle$/;

export function rewriteCompatibleForNozzle(compatible: string, nozzle: string): string {
  return compatible
    .split(',')
    .map((entry) => {
      const trimmed = entry.trim();
      const match = trimmed.match(NOZZLE_TAG_PATTERN);
      return match ? `${match[1]} ${nozzle} nozzle` : trimmed;
    })
    .join(', ');
}
