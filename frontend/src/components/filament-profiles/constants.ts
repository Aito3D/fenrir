import type { PresetForm } from './types';

export const EMPTY_FORM: PresetForm = {
  color: '',
  inherits: '',
  filament_vendor: '',
  filament_type: '',
  default_filament_colour: '',
  filament_notes: '',
  nozzle_temperature: '',
  nozzle_temperature_initial_layer: '',
  nozzle_temperature_range_low: '',
  nozzle_temperature_range_high: '',
  cool_plate_temp: '',
  cool_plate_temp_initial_layer: '',
  eng_plate_temp: '',
  eng_plate_temp_initial_layer: '',
  hot_plate_temp: '',
  hot_plate_temp_initial_layer: '',
  textured_plate_temp: '',
  textured_plate_temp_initial_layer: '',
  supertack_plate_temp: '',
  supertack_plate_temp_initial_layer: '',
  fan_max_speed: '',
  fan_min_speed: '',
  close_fan_the_first_x_layers: '',
  close_additional_fan_first_x_layers: '',
  fan_cooling_layer_time: '',
  overhang_fan_speed: '',
  during_print_exhaust_fan_speed: '',
  complete_print_exhaust_fan_speed: '',
  enable_pressure_advance: false,
  pressure_advance: '',
  filament_flow_ratio: '',
  filament_max_volumetric_speed: '',
  filament_prime_volume: '',
  filament_retraction_length: '',
  filament_retraction_speed: '',
  filament_retract_when_changing_layer: '',
  filament_wipe: '',
  filament_z_hop: '',
  filament_z_hop_types: '',
  filament_deretraction_speed: '',
  filament_wipe_distance: '',
  filament_retract_before_wipe: '',
  slow_down_layer_time: '',
  slow_down_min_speed: '',
  filament_cost: '',
  filament_density: '',
  filament_shrink: '',
  temperature_vitrification: '',
  chamber_temperatures: '',
  additional_cooling_fan_speed: '',
  enable_overhang_bridge_fan: '',
  first_x_layer_fan_speed: '',
  pre_start_fan_time: '',
  overhang_fan_threshold: '',
  filament_extruder_variant: [],
  compatible_printers: '',
  filament_start_gcode: '',
  filament_end_gcode: '',
  pa_k_value: '',
  nozzle_size: '0.4',
};

// Frozen so the single shared empty array can be safely referenced by every `{ ...EMPTY_FORM }`
// spread without risk of one caller's mutation leaking into another's (or into EMPTY_FORM itself).
Object.freeze(EMPTY_FORM.filament_extruder_variant);

/** Fields synthesized/managed by the app UI — never inherited from a parent, never written to preset JSON. */
export const SYNTHETIC_FIELDS = ['color', 'nozzle_size', 'pa_k_value'] as const;

export const VENDORS = ['Bambu Lab', 'eSUN', 'Inslogic', 'Polymaker', 'Prusa', 'SUNLU'];

export const CANONICAL_MATERIALS = [
  'PLA', 'ABS', 'ASA', 'ASA-CF', 'PETG', 'PCTG', 'TPU', 'TPU-AMS', 'PC', 'PA', 'PA-CF', 'PA-GF',
  'PA6-CF', 'PLA-CF', 'PET-CF', 'PETG-CF', 'PVA', 'HIPS', 'PLA-AERO', 'PPS', 'PPS-CF', 'PPA-CF',
  'PPA-GF', 'ABS-GF', 'ASA-AERO', 'PE', 'PP', 'EVA', 'PHA', 'BVOH', 'PE-CF', 'PP-CF', 'PP-GF',
];

export const MATERIAL_ALIASES: Record<string, string> = {
  'PA12-CF': 'PA-CF',
  'PA6-GF': 'PA-GF',
  'PAHT-CF': 'PA-CF',
  PA12: 'PA',
  PA6: 'PA',
  'PC-ABS': 'PC',
  'PC-HT': 'PC',
  'PLA+': 'PLA',
  'PLA Basic': 'PLA',
  'PLA-ST': 'PLA',
  'PLA-LW': 'PLA-AERO',
  'LW-PLA': 'PLA-AERO',
  'PPS-GF': 'PP-GF',
  'TPU 95A': 'TPU',
  'TPU 90A': 'TPU',
  'TPU 87A': 'TPU',
  'TPU 64D': 'TPU',
};

export const MATERIAL_OPTIONS: string[] = Array.from(
  new Set([...CANONICAL_MATERIALS, ...Object.keys(MATERIAL_ALIASES)]),
).sort((a, b) => a.localeCompare(b));

export const EXTRUDER_VARIANTS = ['Direct Drive Standard', 'Direct Drive High Flow', 'Bowden'];

export const NOZZLE_SIZES = ['0.2', '0.4', '0.6', '0.8'];

export const QUICK_ADD_MODELS = ['H2S', 'H2D', 'H2C', 'X2D'];

export const DEFAULT_COMPATIBLE_PRINTERS =
  'Bambu Lab H2S 0.4 nozzle, Bambu Lab H2D 0.4 nozzle, Bambu Lab H2C 0.4 nozzle, Bambu Lab X2D 0.4 nozzle';

export const Z_HOP_TYPES = [
  { value: '', label: 'nil' },
  { value: 'Normal Lift', label: 'Normal Lift' },
  { value: 'Slope Lift', label: 'Slope Lift' },
  { value: 'Spiral Lift', label: 'Spiral Lift' },
];

/**
 * Maps a display material string to a Tailwind text color class representing its family.
 * Always returns a class (defaults to sky for unrecognized materials).
 */
export function materialFamilyClass(material: string): string {
  const m = (material || '').toUpperCase();

  // PETG/PCTG/PET-CF family must be checked before the generic P* / PA patterns.
  if (m.startsWith('PETG') || m.startsWith('PCTG') || m.startsWith('PET-CF')) {
    return 'text-sky-300';
  }
  if (m.startsWith('PLA')) {
    return 'text-green-400';
  }
  if (m.startsWith('ABS') || m.startsWith('ASA')) {
    return 'text-orange-400';
  }
  if (m.startsWith('TPU')) {
    return 'text-teal-400';
  }
  // Nylon family: PA, PA6, PA12, PAHT-CF, PPA-*, and any *-CF/*-GF variants of the above.
  // Must be checked before PP/PPS since PPA also starts with "PP".
  if (m.startsWith('PA') || m.startsWith('PPA')) {
    return 'text-violet-400';
  }
  if (m.startsWith('PC')) {
    return 'text-rose-400';
  }
  if (m.startsWith('PP')) {
    return 'text-amber-400';
  }

  return 'text-sky-300';
}
