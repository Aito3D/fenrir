import { useTranslation } from 'react-i18next';
import type { Dispatch, SetStateAction } from 'react';
import { Field, NumberInput, SectionDivider } from './editorFields';
import type { PresetForm } from './types';

interface TabProps {
  form: PresetForm;
  setForm: Dispatch<SetStateAction<PresetForm>>;
}

interface PlateRowProps {
  label: string;
  printLabel: string;
  initialLabel: string;
  printValue: string;
  onPrintChange: (v: string) => void;
  initialValue: string;
  onInitialChange: (v: string) => void;
}

/** One row of the bed-plate table (spec §7.2): plate name + its print/initial
 *  temperature pair. Each cell's accessible name combines the plate name with
 *  its column so the two identically-shaped inputs per row are distinguishable
 *  to assistive tech (and to tests) despite the shared column header doing
 *  that job visually. */
function PlateRow({
  label,
  printLabel,
  initialLabel,
  printValue,
  onPrintChange,
  initialValue,
  onInitialChange,
}: PlateRowProps) {
  return (
    <tr className="border-t border-bambu-dark-tertiary">
      <th scope="row" className="py-2 pr-3 text-left text-sm font-normal text-bambu-gray">
        {label}
      </th>
      <td className="py-2 pr-3">
        <label className="block">
          <span className="sr-only">{printLabel}</span>
          <NumberInput value={printValue} onChange={onPrintChange} />
        </label>
      </td>
      <td className="py-2">
        <label className="block">
          <span className="sr-only">{initialLabel}</span>
          <NumberInput value={initialValue} onChange={onInitialChange} />
        </label>
      </td>
    </tr>
  );
}

/** The print-temperature scale under the nozzle group ("Material Sheet"
 *  design): a fixed 180–320°C axis — the span real filaments actually print
 *  in — with a marker riding the current value. Purely presentational
 *  (aria-hidden): the number lives in the Print field beside it; this shows
 *  WHERE that number sits between "PLA territory" and "PC territory" at a
 *  glance. Hidden entirely when the field is empty rather than parked at an
 *  arbitrary spot. The marker's left transition is declared here and disabled
 *  globally under prefers-reduced-motion via index.css's motion rules. */
function TempScaleStrip({ value }: { value: string }) {
  const temp = parseFloat(value);
  if (Number.isNaN(temp)) return null;
  const pct = Math.min(97, Math.max(2, ((temp - 180) / (320 - 180)) * 100));
  return (
    <div
      aria-hidden="true"
      className="relative mt-3 h-8 overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark"
    >
      <div
        className="absolute inset-0 opacity-20"
        style={{ background: 'linear-gradient(90deg,#0e7490 0%,#16a34a 34%,#ca8a04 62%,#dc2626 100%)' }}
      />
      <div
        className="absolute bottom-0 top-0 w-0.5 bg-rose-300 transition-[left] duration-500 motion-reduce:transition-none"
        style={{ left: `${pct}%` }}
      >
        <span className="absolute left-2 top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[10.5px] text-rose-300">
          {temp}°C
        </span>
      </div>
      <div className="absolute inset-x-2 bottom-0.5 flex justify-between font-mono text-[9px] text-bambu-gray/60">
        <span>180</span>
        <span>230</span>
        <span>280</span>
        <span>320</span>
      </div>
    </div>
  );
}

/** Temps tab (spec §7.2): nozzle temps, material Tg, chamber temp, and the
 *  five-row bed-plate table. */
export function EditorTabTemps({ form, setForm }: TabProps) {
  const { t } = useTranslation();
  const set = (patch: Partial<PresetForm>) => setForm((f) => ({ ...f, ...patch }));
  const printCol = t('filamentProfiles.printCol');
  const initialCol = t('filamentProfiles.initialCol');

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionDivider label={t('filamentProfiles.nozzleSection')} />
        <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label={t('filamentProfiles.tempInitial')} unit="°C">
            <NumberInput
              value={form.nozzle_temperature_initial_layer}
              onChange={(v) => set({ nozzle_temperature_initial_layer: v })}
            />
          </Field>
          <Field label={t('filamentProfiles.tempPrint')} unit="°C">
            <NumberInput value={form.nozzle_temperature} onChange={(v) => set({ nozzle_temperature: v })} />
          </Field>
          <Field label={t('filamentProfiles.tempRangeMin')} unit="°C">
            <NumberInput
              value={form.nozzle_temperature_range_low}
              onChange={(v) => set({ nozzle_temperature_range_low: v })}
            />
          </Field>
          <Field label={t('filamentProfiles.tempRangeMax')} unit="°C">
            <NumberInput
              value={form.nozzle_temperature_range_high}
              onChange={(v) => set({ nozzle_temperature_range_high: v })}
            />
          </Field>
        </div>
        <TempScaleStrip value={form.nozzle_temperature} />
      </div>

      <div>
        <SectionDivider label={t('filamentProfiles.materialSection')} />
        <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label={t('filamentProfiles.glassTg')} unit="°C">
            <NumberInput
              value={form.temperature_vitrification}
              onChange={(v) => set({ temperature_vitrification: v })}
            />
          </Field>
        </div>
      </div>

      <div>
        <SectionDivider label={t('filamentProfiles.chamberSection')} />
        <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label={t('filamentProfiles.chamberTemp')} unit="°C">
            <NumberInput value={form.chamber_temperatures} onChange={(v) => set({ chamber_temperatures: v })} />
          </Field>
        </div>
      </div>

      <div>
        <SectionDivider label={t('filamentProfiles.bedPlates')} />
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-bambu-gray/70">
                <th scope="col" className="pb-2 pr-3 font-semibold">{t('filamentProfiles.plate')}</th>
                <th scope="col" className="pb-2 pr-3 font-semibold">{printCol}</th>
                <th scope="col" className="pb-2 font-semibold">{initialCol}</th>
              </tr>
            </thead>
            <tbody>
              <PlateRow
                label={t('filamentProfiles.plateSuperTack')}
                printLabel={`${t('filamentProfiles.plateSuperTack')} ${printCol}`}
                initialLabel={`${t('filamentProfiles.plateSuperTack')} ${initialCol}`}
                printValue={form.supertack_plate_temp}
                onPrintChange={(v) => set({ supertack_plate_temp: v })}
                initialValue={form.supertack_plate_temp_initial_layer}
                onInitialChange={(v) => set({ supertack_plate_temp_initial_layer: v })}
              />
              <PlateRow
                label={t('filamentProfiles.plateCool')}
                printLabel={`${t('filamentProfiles.plateCool')} ${printCol}`}
                initialLabel={`${t('filamentProfiles.plateCool')} ${initialCol}`}
                printValue={form.cool_plate_temp}
                onPrintChange={(v) => set({ cool_plate_temp: v })}
                initialValue={form.cool_plate_temp_initial_layer}
                onInitialChange={(v) => set({ cool_plate_temp_initial_layer: v })}
              />
              <PlateRow
                label={t('filamentProfiles.plateEng')}
                printLabel={`${t('filamentProfiles.plateEng')} ${printCol}`}
                initialLabel={`${t('filamentProfiles.plateEng')} ${initialCol}`}
                printValue={form.eng_plate_temp}
                onPrintChange={(v) => set({ eng_plate_temp: v })}
                initialValue={form.eng_plate_temp_initial_layer}
                onInitialChange={(v) => set({ eng_plate_temp_initial_layer: v })}
              />
              <PlateRow
                label={t('filamentProfiles.plateHot')}
                printLabel={`${t('filamentProfiles.plateHot')} ${printCol}`}
                initialLabel={`${t('filamentProfiles.plateHot')} ${initialCol}`}
                printValue={form.hot_plate_temp}
                onPrintChange={(v) => set({ hot_plate_temp: v })}
                initialValue={form.hot_plate_temp_initial_layer}
                onInitialChange={(v) => set({ hot_plate_temp_initial_layer: v })}
              />
              <PlateRow
                label={t('filamentProfiles.plateTextured')}
                printLabel={`${t('filamentProfiles.plateTextured')} ${printCol}`}
                initialLabel={`${t('filamentProfiles.plateTextured')} ${initialCol}`}
                printValue={form.textured_plate_temp}
                onPrintChange={(v) => set({ textured_plate_temp: v })}
                initialValue={form.textured_plate_temp_initial_layer}
                onInitialChange={(v) => set({ textured_plate_temp_initial_layer: v })}
              />
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
