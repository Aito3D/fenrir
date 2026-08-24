import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Dispatch, SetStateAction } from 'react';
import { Button } from '../Button';
import { inputCls } from '../formStyles';
import { Field, NumberInput, SectionDivider, TextInput } from './editorFields';
import { extractPaK } from './presetJson';
import type { PresetForm } from './types';

interface TabProps {
  form: PresetForm;
  setForm: Dispatch<SetStateAction<PresetForm>>;
}

interface FlowCalPopoverProps {
  current: string;
  onApply: (next: string) => void;
  onClose: () => void;
}

/** The flow-ratio "cal" popover (spec §7.5): adjust the current ratio by a
 *  percentage rather than typing an absolute number. Dismisses on an outside
 *  click; Enter applies, Escape closes without applying. The Escape handler
 *  stops propagation for the same reason SearchableSelect's does — the
 *  editor modal has its own window-level Escape listener (useDismissableDialog)
 *  that would otherwise close the whole modal underneath this popover. */
function FlowCalPopover({ current, onApply, onClose }: FlowCalPopoverProps) {
  const { t } = useTranslation();
  const [pct, setPct] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [onClose]);

  const apply = () => {
    const pctNum = parseFloat(pct);
    const base = parseFloat(current) || 1;
    const factor = Number.isNaN(pctNum) ? 0 : pctNum;
    const next = Number((base * (1 + factor / 100)).toFixed(3));
    onApply(String(next));
    onClose();
  };

  return (
    <div
      ref={containerRef}
      className="absolute left-0 top-full z-10 mt-1 w-56 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3 shadow-xl"
    >
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-bambu-gray/70">
        {t('filamentProfiles.calTitle')}
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          autoFocus
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              apply();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
          aria-label={t('filamentProfiles.calTitle')}
          className={`${inputCls} font-mono`}
        />
        <Button size="sm" onClick={apply}>
          {t('filamentProfiles.apply')}
        </Button>
      </div>
    </div>
  );
}

/** Extrusion tab (spec §7.5): flow ratio (+ cal popover), max vol. flow,
 *  prime volume, shrinkage, layer slow-down, and the start/end G-code
 *  textareas. Editing start G-code re-derives `pa_k_value` so the General
 *  tab's PA K field stays coupled to it (spec §7.1/§7.5). */
export function EditorTabExtrusion({ form, setForm }: TabProps) {
  const { t } = useTranslation();
  const [calOpen, setCalOpen] = useState(false);
  const set = (patch: Partial<PresetForm>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionDivider label={t('filamentProfiles.flowSection')} />
        <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {/* The "cal" button and its popover live OUTSIDE the Field/<label> so
              the flow-ratio input keeps a clean accessible name ("Flow
              ratio") — nesting a labelable button (and, once open, the
              popover's own input) inside the same <label> would fold their
              text into the flow-ratio input's computed name. */}
          <div className="relative">
            <div className="flex items-end gap-1.5">
              <div className="flex-1">
                <Field label={t('filamentProfiles.flowRatio')}>
                  <NumberInput
                    value={form.filament_flow_ratio}
                    onChange={(v) => set({ filament_flow_ratio: v })}
                    step="0.001"
                    min="0.5"
                    max="1.5"
                  />
                </Field>
              </div>
              <button
                type="button"
                onClick={() => setCalOpen(true)}
                className="shrink-0 rounded-lg border border-bambu-dark-tertiary px-2 py-2 text-xs font-medium text-bambu-gray hover:text-white"
              >
                {t('filamentProfiles.cal')}
              </button>
            </div>
            {calOpen && (
              <FlowCalPopover
                current={form.filament_flow_ratio}
                onApply={(next) => set({ filament_flow_ratio: next })}
                onClose={() => setCalOpen(false)}
              />
            )}
          </div>
          <Field label={t('filamentProfiles.maxVolFlow')} unit="mm³/s">
            <NumberInput
              value={form.filament_max_volumetric_speed}
              onChange={(v) => set({ filament_max_volumetric_speed: v })}
            />
          </Field>
          <Field label={t('filamentProfiles.primeVolume')} unit="mm³">
            <NumberInput value={form.filament_prime_volume} onChange={(v) => set({ filament_prime_volume: v })} />
          </Field>
          <Field label={t('filamentProfiles.shrinkage')}>
            <TextInput
              value={form.filament_shrink}
              onChange={(v) => set({ filament_shrink: v })}
              placeholder="99.25%"
            />
          </Field>
        </div>
      </div>

      <div>
        <SectionDivider label={t('filamentProfiles.layerSlowdown')} />
        <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('filamentProfiles.minTimePerLayer')} unit="s">
            <NumberInput value={form.slow_down_layer_time} onChange={(v) => set({ slow_down_layer_time: v })} />
          </Field>
          <Field label={t('filamentProfiles.minSpeed')} unit="mm/s">
            <NumberInput value={form.slow_down_min_speed} onChange={(v) => set({ slow_down_min_speed: v })} />
          </Field>
        </div>
      </div>

      <div>
        <SectionDivider label={t('filamentProfiles.gcodeSection')} />
        <div className="mt-2 flex flex-col gap-4">
          <Field label={t('filamentProfiles.startGcode')}>
            <textarea
              rows={3}
              spellCheck={false}
              value={form.filament_start_gcode}
              onChange={(e) => {
                const next = e.target.value;
                set({ filament_start_gcode: next, pa_k_value: extractPaK(next) });
              }}
              className="w-full resize-none rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 font-mono text-sm text-white placeholder-bambu-gray focus:border-bambu-green focus:outline-none"
            />
          </Field>
          <Field label={t('filamentProfiles.endGcode')}>
            <textarea
              rows={2}
              spellCheck={false}
              value={form.filament_end_gcode}
              onChange={(e) => set({ filament_end_gcode: e.target.value })}
              className="w-full resize-none rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 font-mono text-sm text-white placeholder-bambu-gray focus:border-bambu-green focus:outline-none"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
