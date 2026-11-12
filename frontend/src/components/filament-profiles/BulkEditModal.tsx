import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../Button';
import { Field, NumberInput } from './editorFields';
import type { Entry } from './presetGroups';
import type { RowChanges } from './presetJson';

const FIELDS = [
  { key: 'temp', label: 'filamentProfiles.nozzleSection', unit: '°C', step: '1' },
  { key: 'flow', label: 'filamentProfiles.flowRatio', step: '0.01' },
  { key: 'pa', label: 'filamentProfiles.paKValue', step: '0.001' },
] as const;

export interface BulkEditModalProps {
  /** One line of a brand row: the colours that share the same settings. */
  line: Entry[];
  onSave: (changes: RowChanges) => Promise<void>;
  onClose: () => void;
}

/** Changes temperature, flow and PA for every colour of a line at once. */
export function BulkEditModal({ line, onSave, onClose }: BulkEditModalProps) {
  const { t } = useTranslation();
  const initial = line[0].settings;
  const [values, setValues] = useState({ temp: initial.temp, flow: initial.flow, pa: initial.pa });
  const [saving, setSaving] = useState(false);

  // An emptied field is left alone: the line never loses a setting from here.
  const changes: RowChanges = {};
  for (const { key } of FIELDS) {
    if (values[key] !== '' && values[key] !== initial[key]) changes[key] = values[key];
  }
  const valid = Object.values(changes).every((v) => /^\d+(\.\d+)?$/.test(v));
  const title = t('filamentProfiles.groupEditLine', { n: line.length });

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(changes);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-overlay-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-6 animate-modal-in"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        <p className="mt-1 text-sm text-bambu-gray">{line.map((entry) => entry.color || entry.preset.name).join(', ')}</p>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {FIELDS.map(({ key, label, step, ...rest }) => (
            <Field key={key} label={t(label)} unit={'unit' in rest ? rest.unit : undefined}>
              <NumberInput value={values[key]} onChange={(v) => setValues((s) => ({ ...s, [key]: v }))} step={step} min="0" />
            </Field>
          ))}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('filamentProfiles.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving || !valid || Object.keys(changes).length === 0}>
            {t(saving ? 'filamentProfiles.saving' : 'filamentProfiles.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
