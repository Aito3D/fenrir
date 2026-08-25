import { useTranslation } from 'react-i18next';
import type { Dispatch, SetStateAction } from 'react';
import { Field, NumberInput, SectionDivider, TextInput, TriStateRow } from './editorFields';
import type { PresetForm } from './types';

interface TabProps {
  form: PresetForm;
  setForm: Dispatch<SetStateAction<PresetForm>>;
}

/** Cooling tab (spec §7.4): part-cooling fan grid, overhang/bridge fan
 *  tri-state, chamber ventilation pair. */
export function EditorTabCooling({ form, setForm }: TabProps) {
  const { t } = useTranslation();
  const set = (patch: Partial<PresetForm>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionDivider label={t('filamentProfiles.partFan')} />
        <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={t('filamentProfiles.fanMax')} unit="%">
            <NumberInput value={form.fan_max_speed} onChange={(v) => set({ fan_max_speed: v })} />
          </Field>
          <Field label={t('filamentProfiles.fanMin')} unit="%">
            <NumberInput value={form.fan_min_speed} onChange={(v) => set({ fan_min_speed: v })} />
          </Field>
          <Field label={t('filamentProfiles.overhangFan')} unit="%">
            <NumberInput value={form.overhang_fan_speed} onChange={(v) => set({ overhang_fan_speed: v })} />
          </Field>
          <Field label={t('filamentProfiles.noFanLayers')}>
            <NumberInput
              value={form.close_fan_the_first_x_layers}
              onChange={(v) => set({ close_fan_the_first_x_layers: v })}
            />
          </Field>
          <Field label={t('filamentProfiles.noFanAdditional')}>
            <NumberInput
              value={form.close_additional_fan_first_x_layers}
              onChange={(v) => set({ close_additional_fan_first_x_layers: v })}
            />
          </Field>
          <Field label={t('filamentProfiles.initialFan')} unit="%">
            <NumberInput
              value={form.first_x_layer_fan_speed}
              onChange={(v) => set({ first_x_layer_fan_speed: v })}
            />
          </Field>
          <Field label={t('filamentProfiles.minLayerTime')} unit="s">
            <NumberInput value={form.fan_cooling_layer_time} onChange={(v) => set({ fan_cooling_layer_time: v })} />
          </Field>
          <Field label={t('filamentProfiles.overhangThreshold')}>
            <TextInput
              value={form.overhang_fan_threshold}
              onChange={(v) => set({ overhang_fan_threshold: v })}
              placeholder="10%"
            />
          </Field>
          <Field label={t('filamentProfiles.preStartFan')} unit="s">
            <NumberInput value={form.pre_start_fan_time} onChange={(v) => set({ pre_start_fan_time: v })} />
          </Field>
          <Field label={t('filamentProfiles.additionalFan')} unit="%">
            <NumberInput
              value={form.additional_cooling_fan_speed}
              onChange={(v) => set({ additional_cooling_fan_speed: v })}
            />
          </Field>
        </div>
      </div>

      <TriStateRow
        label={t('filamentProfiles.overhangBridgeFan')}
        value={form.enable_overhang_bridge_fan}
        onChange={(v) => set({ enable_overhang_bridge_fan: v })}
      />

      <div>
        <SectionDivider label={t('filamentProfiles.chamberVent')} />
        <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('filamentProfiles.duringPrint')} unit="%">
            <NumberInput
              value={form.during_print_exhaust_fan_speed}
              onChange={(v) => set({ during_print_exhaust_fan_speed: v })}
            />
          </Field>
          <Field label={t('filamentProfiles.endOfPrint')} unit="%">
            <NumberInput
              value={form.complete_print_exhaust_fan_speed}
              onChange={(v) => set({ complete_print_exhaust_fan_speed: v })}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
