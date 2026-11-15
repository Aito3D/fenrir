import {
  ArrowLeftRight,
  Code,
  Droplet,
  Fan,
  Flame,
  Gauge,
  Info,
  Layers,
  Link,
  Paintbrush,
  Repeat,
  Snowflake,
  StickyNote,
  Thermometer,
  Wind,
  type LucideIcon,
} from 'lucide-react';

/**
 * OrcaSlicer's filament settings panel, tab by tab. Keys were checked against Orca's own option names (OrcaSlicer binary
 * and Bambu's fdm_filament_*.json); labels are filamentTrees.orca.* (Orca's English, translations from Orca's catalogues).
 */
export type FieldKind = 'text' | 'bool' | 'pa' | 'gcode' | 'colour' | 'readonly';
export type FieldSpec = { key: string; unit?: string; caption?: string; kind?: FieldKind; options?: string[] };
export type RowSpec = { label: string; fields: FieldSpec[] };
export type SectionSpec = {
  title: string;
  icon: LucideIcon;
  rows: RowSpec[];
  /** Orca's "Setting Overrides": an enable checkbox before every row. */
  override?: boolean;
  /** Only shown when the node has a value for one of its keys. */
  ifPresent?: boolean;
};
export type TabSpec = { id: string; label: string; sections: SectionSpec[] };

const L = (k: string) => `filamentTrees.orca.${k}`;
const one = (label: string, key: string, unit?: string, extra: Omit<FieldSpec, 'key' | 'unit'> = {}): RowSpec => ({
  label: L(label),
  fields: [{ key, unit, ...extra }],
});
const bool = (label: string, key: string): RowSpec => one(label, key, undefined, { kind: 'bool' });
const pair = (label: string, a: [string, string], b: [string, string], unit: string, unitB = unit): RowSpec => ({
  label: L(label),
  fields: [
    { key: a[1], caption: L(a[0]), unit },
    { key: b[1], caption: L(b[0]), unit: unitB },
  ],
});
const layers = (label: string, base: string): RowSpec =>
  pair(label, ['firstLayer', `${base}_initial_layer`], ['otherLayers', base], '°C');

/** The M900 K editor writes into filament_start_gcode. */
export const PA_KEY = 'filament_start_gcode';

const FILAMENT_TYPES = ['PLA', 'PETG', 'PCTG', 'ABS', 'ASA', 'TPU', 'PC', 'PA', 'PA-CF', 'PET-CF', 'PETG-CF', 'PLA-CF', 'HIPS', 'PVA', 'BVOH', 'PPS', 'PP', 'PE'];

export const TABS: TabSpec[] = [
  {
    id: 'filament',
    label: L('tabFilament'),
    sections: [
      {
        title: L('basicInfo'),
        icon: Info,
        rows: [
          one('type', 'filament_type', undefined, { options: FILAMENT_TYPES }),
          one('vendor', 'filament_vendor'),
          bool('soluble', 'filament_soluble'),
          bool('support', 'filament_is_support'),
          one('rammingLength', 'filament_change_length', 'mm'),
          one('nozzleHrc', 'required_nozzle_HRC'),
          one('defaultColor', 'default_filament_colour', undefined, { kind: 'colour' }),
          one('diameter', 'filament_diameter', 'mm'),
          one('adhesiveness', 'filament_adhesiveness_category'),
          one('density', 'filament_density', 'g/cm³'),
          one('shrinkXY', 'filament_shrink', '%'),
          one('shrinkZ', 'filament_shrinkage_compensation_z', '%'),
          one('price', 'filament_cost', '/kg'),
          one('softening', 'temperature_vitrification', '°C'),
          one('idleTemp', 'idle_temperature', '°C'),
          pair('recNozzle', ['min', 'nozzle_temperature_range_low'], ['max', 'nozzle_temperature_range_high'], '°C'),
        ],
      },
      {
        title: L('flowPa'),
        icon: Droplet,
        rows: [
          one('flowRatio', 'filament_flow_ratio'),
          bool('enablePa', 'enable_pressure_advance'),
          one('pa', PA_KEY, undefined, { kind: 'pa' }),
          bool('adaptivePa', 'adaptive_pressure_advance'),
        ],
      },
      {
        title: L('chamberSec'),
        icon: Thermometer,
        rows: [
          bool('chamberControl', 'activate_chamber_temp_control'),
          pair('chamberTemp', ['target', 'chamber_temperatures'], ['minimal', 'chamber_minimal_temperature'], '°C'),
        ],
      },
      { title: L('printTemp'), icon: Flame, rows: [layers('nozzle', 'nozzle_temperature')] },
      {
        title: L('bedTemp'),
        icon: Layers,
        rows: [
          layers('plateSuperTack', 'supertack_plate_temp'),
          layers('plateCool', 'cool_plate_temp'),
          layers('plateTexturedCool', 'textured_cool_plate_temp'),
          layers('plateEng', 'eng_plate_temp'),
          layers('plateHot', 'hot_plate_temp'),
          layers('plateTexturedPei', 'textured_plate_temp'),
        ],
      },
      {
        title: L('volSpeed'),
        icon: Gauge,
        rows: [
          bool('adaptiveVol', 'filament_adaptive_volumetric_speed'),
          one('maxVol', 'filament_max_volumetric_speed', 'mm³/s'),
        ],
      },
    ],
  },
  {
    id: 'cooling',
    label: L('tabCooling'),
    sections: [
      {
        title: L('coolingLayer'),
        icon: Snowflake,
        rows: [one('noCoolingFirst', 'close_fan_the_first_x_layers'), one('fullFanLayer', 'full_fan_speed_layer')],
      },
      {
        title: L('partFan'),
        icon: Fan,
        rows: [
          pair('minFanThreshold', ['fanSpeed', 'fan_min_speed'], ['layerTime', 'fan_cooling_layer_time'], '%', 's'),
          pair('maxFanThreshold', ['fanSpeed', 'fan_max_speed'], ['layerTime', 'slow_down_layer_time'], '%', 's'),
          bool('keepFanOn', 'reduce_fan_stop_start_freq'),
          bool('slowDown', 'slow_down_for_layer_cooling'),
          bool('dontSlowOuter', 'dont_slow_down_outer_wall'),
          one('minPrintSpeed', 'slow_down_min_speed', 'mm/s'),
          bool('forceOverhangCooling', 'enable_overhang_bridge_fan'),
          one('overhangThreshold', 'overhang_fan_threshold', undefined, {
            options: ['0%', '10%', '25%', '50%', '75%', '95%'],
          }),
          one('overhangFanSpeed', 'overhang_fan_speed', '%'),
          one('internalBridgeFan', 'internal_bridge_fan_speed', '%'),
          one('supportInterfaceFan', 'support_material_interface_fan_speed', '%'),
          one('ironingFan', 'ironing_fan_speed', '%'),
        ],
      },
      { title: L('auxFan'), icon: Fan, rows: [one('fanSpeed', 'additional_cooling_fan_speed', '%')] },
      {
        title: L('exhaustFan'),
        icon: Wind,
        ifPresent: true,
        rows: [
          bool('airFiltration', 'activate_air_filtration'),
          one('exhaustDuring', 'during_print_exhaust_fan_speed', '%'),
          one('exhaustComplete', 'complete_print_exhaust_fan_speed', '%'),
        ],
      },
    ],
  },
  {
    id: 'overrides',
    label: L('tabOverrides'),
    sections: [
      {
        title: L('retraction'),
        icon: Repeat,
        override: true,
        rows: [
          one('length', 'filament_retraction_length', 'mm'),
          one('zHopHeight', 'filament_z_hop', 'mm'),
          one('zHopType', 'filament_z_hop_types', undefined, {
            options: ['Auto Lift', 'Normal Lift', 'Slope Lift', 'Spiral Lift'],
          }),
          one('liftAbove', 'filament_retract_lift_above', 'mm'),
          one('liftBelow', 'filament_retract_lift_below', 'mm'),
          one('onSurfaces', 'filament_retract_lift_enforce', undefined, {
            options: ['All Surfaces', 'Top Only', 'Bottom Only', 'Top and Bottom'],
          }),
          one('retractSpeed', 'filament_retraction_speed', 'mm/s'),
          one('deretractSpeed', 'filament_deretraction_speed', 'mm/s'),
          one('extraRestart', 'filament_retract_restart_extra', 'mm'),
          one('travelThreshold', 'filament_retraction_minimum_travel', 'mm'),
          bool('retractLayer', 'filament_retract_when_changing_layer'),
          bool('wipe', 'filament_wipe'),
          one('wipeDistance', 'filament_wipe_distance', 'mm'),
          one('retractBeforeWipe', 'filament_retract_before_wipe', '%'),
          one('retractAfterWipe', 'filament_retract_after_wipe', '%'),
          bool('longRetractCut', 'filament_long_retractions_when_cut'),
        ],
      },
      {
        title: L('retractionSwitch'),
        icon: ArrowLeftRight,
        override: true,
        rows: [
          one('toolchangeLength', 'filament_retract_length_toolchange', 'mm'),
          one('toolchangeExtra', 'filament_retract_restart_extra_toolchange', 'mm'),
        ],
      },
      {
        title: L('ironing'),
        icon: Paintbrush,
        override: true,
        rows: [
          one('ironingFlow', 'filament_ironing_flow', '%'),
          one('ironingSpacing', 'filament_ironing_spacing', 'mm'),
          one('ironingInset', 'filament_ironing_inset', 'mm'),
          one('ironingSpeed', 'filament_ironing_speed', 'mm/s'),
        ],
      },
    ],
  },
  {
    id: 'advanced',
    label: L('tabAdvanced'),
    sections: [
      { title: L('startGcode'), icon: Code, rows: [one('startGcode', PA_KEY, undefined, { kind: 'gcode' })] },
      {
        title: L('roleGcode'),
        icon: Code,
        rows: [one('roleGcode', 'filament_change_extrusion_role_gcode', undefined, { kind: 'gcode' })],
      },
      { title: L('endGcode'), icon: Code, rows: [one('endGcode', 'filament_end_gcode', undefined, { kind: 'gcode' })] },
    ],
  },
  {
    id: 'multimaterial',
    label: L('tabMultimaterial'),
    sections: [
      {
        title: L('wipeTower'),
        icon: Layers,
        rows: [
          one('minPurge', 'filament_minimal_purge_on_wipe_tower', 'mm³'),
          one('preExtDist', 'filament_tower_interface_pre_extrusion_dist', 'mm'),
          one('preExtLen', 'filament_tower_interface_pre_extrusion_length', 'mm'),
          one('towerIroning', 'filament_tower_ironing_area', 'mm²'),
          one('purgeLen', 'filament_tower_interface_purge_volume', 'mm'),
          one('interfaceTemp', 'filament_tower_interface_print_temp', '°C'),
          { label: 'filamentProfiles.primeVolume', fields: [{ key: 'filament_prime_volume', unit: 'mm³' }] },
        ],
      },
      {
        title: L('multiFilament'),
        icon: Repeat,
        rows: [
          bool('longRetractEc', 'long_retractions_when_ec'),
          { label: 'filamentProfiles.extruder', fields: [{ key: 'filament_extruder_variant', kind: 'readonly' }] },
        ],
      },
      {
        title: L('toolChangeSingle'),
        icon: ArrowLeftRight,
        rows: [
          one('loadStart', 'filament_loading_speed_start', 'mm/s'),
          one('load', 'filament_loading_speed', 'mm/s'),
          one('unloadStart', 'filament_unloading_speed_start', 'mm/s'),
          one('unload', 'filament_unloading_speed', 'mm/s'),
          one('delayUnload', 'filament_toolchange_delay', 's'),
          one('coolingMoves', 'filament_cooling_moves'),
          one('coolFirst', 'filament_cooling_initial_speed', 'mm/s'),
          one('coolLast', 'filament_cooling_final_speed', 'mm/s'),
          one('stampSpeed', 'filament_stamping_loading_speed'),
          one('stampDist', 'filament_stamping_distance'),
        ],
      },
      {
        title: L('toolChangeMulti'),
        icon: ArrowLeftRight,
        rows: [
          bool('multiRamming', 'filament_multitool_ramming'),
          one('multiRamVol', 'filament_multitool_ramming_volume', 'mm³'),
          one('multiRamFlow', 'filament_multitool_ramming_flow', 'mm³/s'),
        ],
      },
    ],
  },
  { id: 'dependencies', label: L('tabDependencies'), sections: [] },
  {
    id: 'notes',
    label: L('tabNotes'),
    sections: [{ title: L('tabNotes'), icon: StickyNote, rows: [one('tabNotes', 'filament_notes', undefined, { kind: 'gcode' })] }],
  },
];

/** Every key some tab shows; anything else in the node lands in Advanced › Other. */
export const MAPPED_KEYS = new Set(TABS.flatMap((tab) => tab.sections.flatMap((s) => s.rows.flatMap((r) => r.fields.map((f) => f.key)))));

export const DEPENDENCIES_ICON = Link;

const KEY_LABELS = new Map(
  TABS.flatMap((tab) => tab.sections.flatMap((s) => s.rows.flatMap((r) => r.fields.map((f) => [f.key, { row: r.label, caption: f.caption }] as const)))),
);
/** The label an Orca key carries in the settings tabs (the raw key when it has no row). */
export const keyLabel = (t: (key: string) => string, key: string) => {
  const spec = KEY_LABELS.get(key);
  return !spec ? key : spec.caption ? `${t(spec.row)} (${t(spec.caption)})` : t(spec.row);
};
