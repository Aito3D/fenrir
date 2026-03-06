import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, ChevronDown, ChevronUp } from 'lucide-react';
import type { PrintOptionsProps, PrintOptions as PrintOptionsType } from './types';

const PRINT_OPTIONS_CONFIG = [
  { key: 'bed_levelling', labelKey: 'printModal.options.bedLevelling', descKey: 'printModal.options.bedLevellingDesc' },
  { key: 'flow_cali', labelKey: 'printModal.options.flowCalibration', descKey: 'printModal.options.flowCalibrationDesc' },
  { key: 'vibration_cali', labelKey: 'printModal.options.vibrationCalibration', descKey: 'printModal.options.vibrationCalibrationDesc' },
  { key: 'layer_inspect', labelKey: 'printModal.options.firstLayerInspection', descKey: 'printModal.options.firstLayerInspectionDesc' },
  { key: 'timelapse', labelKey: 'printModal.options.timelapse', descKey: 'printModal.options.timelapseDesc' },
] as const;

/**
 * Print options toggle panel with collapsible UI.
 * Shows bed levelling, flow/vibration calibration, layer inspection, and timelapse options.
 */
export function PrintOptionsPanel({
  options,
  onChange,
  defaultExpanded = false,
}: PrintOptionsProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const handleToggle = (key: keyof PrintOptionsType) => {
    onChange({ ...options, [key]: !options[key] });
  };

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-sm text-bambu-gray hover:text-white transition-colors w-full"
      >
        <Settings className="w-4 h-4" />
        <span>{t('printModal.printOptions')}</span>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 ml-auto" />
        ) : (
          <ChevronDown className="w-4 h-4 ml-auto" />
        )}
      </button>
      {isExpanded && (
        <div className="mt-2 bg-bambu-dark rounded-lg p-3 space-y-2">
          {PRINT_OPTIONS_CONFIG.map(({ key, labelKey, descKey }) => (
            <label key={key} className="flex items-center justify-between cursor-pointer group">
              <div>
                <span className="text-sm text-white">{t(labelKey)}</span>
                <p className="text-xs text-bambu-gray">{t(descKey)}</p>
              </div>
              <div
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  options[key] ? 'bg-bambu-green' : 'bg-bambu-dark-tertiary'
                }`}
                onClick={() => handleToggle(key)}
              >
                <div
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    options[key] ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </div>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
