import { useTranslation } from 'react-i18next';
import type { Dispatch, SetStateAction } from 'react';
import { Field, NumberInput, SectionDivider, TextInput, TriStateRow } from './editorFields';
import type { PresetForm } from './types';

interface TabProps {
  form: PresetForm;
  setForm: Dispatch<SetStateAction<PresetForm>>;
}

const Z_HOP_OPTIONS: { value: string; labelKey: string }[] = [
  { value: '', labelKey: 'filamentProfiles.nil' },
  { value: 'Normal Lift', labelKey: 'filamentProfiles.zHopNormal' },
  { value: 'Slope Lift', labelKey: 'filamentProfiles.zHopSlope' },
  { value: 'Spiral Lift', labelKey: 'filamentProfiles.zHopSpiral' },
];

/** Retract tab (spec §7.6): retraction/z-hop/wipe grid plus the options
 *  tri-state rows. */
export function EditorTabRetract({ form, setForm }: TabProps) {
  const { t } = useTranslation();
  const set = (patch: Partial<PresetForm>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label={t('filamentProfiles.length')} unit="mm">
          <NumberInput
            value={form.filament_retraction_length}
            onChange={(v) => set({ filament_retraction_length: v })}
            step="0.1"
          />
        </Field>
        <Field label={t('filamentProfiles.speed')} unit="mm/s">
          <NumberInput
            value={form.filament_retraction_speed}
            onChange={(v) => set({ filament_retraction_speed: v })}
          />
        </Field>
        <Field label={t('filamentProfiles.deretractSpeed')} unit="mm/s">
          <NumberInput
            value={form.filament_deretraction_speed}
            onChange={(v) => set({ filament_deretraction_speed: v })}
          />
        </Field>
        <Field label={t('filamentProfiles.zHop')} unit="mm">
          <NumberInput value={form.filament_z_hop} onChange={(v) => set({ filament_z_hop: v })} step="0.1" />
        </Field>
        <Field label={t('filamentProfiles.zHopType')}>
          <div className="flex flex-wrap gap-1.5">
            {Z_HOP_OPTIONS.map((opt) => (
              <button
                key={opt.value || 'nil'}
                type="button"
                onClick={() => set({ filament_z_hop_types: opt.value })}
                aria-pressed={form.filament_z_hop_types === opt.value}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  form.filament_z_hop_types === opt.value
                    ? 'border-bambu-green bg-bambu-green/20 text-bambu-green'
                    : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white'
                }`}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </Field>
        <Field label={t('filamentProfiles.wipeDistance')} unit="mm">
          <NumberInput
            value={form.filament_wipe_distance}
            onChange={(v) => set({ filament_wipe_distance: v })}
            step="0.1"
          />
        </Field>
        <Field label={t('filamentProfiles.retractBeforeWipe')}>
          <TextInput
            value={form.filament_retract_before_wipe}
            onChange={(v) => set({ filament_retract_before_wipe: v })}
            placeholder="85%"
          />
        </Field>
      </div>

      <div>
        <SectionDivider label={t('filamentProfiles.options')} />
        <div className="mt-2 flex flex-col gap-2">
          <TriStateRow
            label={t('filamentProfiles.retractOnLayerChange')}
            value={form.filament_retract_when_changing_layer}
            onChange={(v) => set({ filament_retract_when_changing_layer: v })}
          />
          <TriStateRow
            label={t('filamentProfiles.wipeOnRetract')}
            value={form.filament_wipe}
            onChange={(v) => set({ filament_wipe: v })}
          />
        </div>
      </div>
    </div>
  );
}
