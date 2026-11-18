import { useState, useMemo, type ReactNode } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Printer as PrinterIcon, Loader2, AlertCircle, AlertTriangle, Check, Users } from 'lucide-react';
import { api, type PrinterStatus } from '../../api/client';
import { isGcodeCompatible } from '../../utils/printer';
import { effectivePreferLowest } from '../../utils/amsHelpers';
import type { PrinterSelectorProps, AssignmentMode } from './types';
import type { PrinterMappingResult, PrinterMatchStatus } from '../../hooks/useMultiPrinterFilamentMapping';
import {
  buildFilamentComparison,
  buildLoadedFilaments,
  type FilamentRequirement,
} from '../../hooks/useFilamentMapping';
import { useUiSettings } from '../../hooks/useUiSettings';

interface PrinterSelectorWithMappingProps extends PrinterSelectorProps {
  /** Mapping results of the selected printers, for their readiness badge */
  printerMappingResults?: PrinterMappingResult[];
  /** The filament mapping panel of a selected printer, drawn inside its card */
  renderMapping?: (printerId: number) => ReactNode;
  /** Filament requirements for the print */
  filamentReqs?: { filaments: FilamentRequirement[] };
  /** Current assignment mode */
  assignmentMode?: AssignmentMode;
  /** Handler for assignment mode change */
  onAssignmentModeChange?: (mode: AssignmentMode) => void;
  /** Selected target model (when assignmentMode is 'model') */
  targetModel?: string | null;
  /** Handler for target model change */
  onTargetModelChange?: (model: string | null) => void;
  /** Selected target location (when assignmentMode is 'model') */
  targetLocation?: string | null;
  /** Handler for target location change */
  onTargetLocationChange?: (location: string | null) => void;
  /** Suggested model from sliced file (for pre-selection) */
  slicedForModel?: string | null;
}

/** States where the printer is available to accept a new print */
const AVAILABLE_STATES = new Set(['IDLE', 'FINISH', 'FAILED']);

/**
 * Printer selection component with grid-based UI.
 * Supports single or multi-select modes.
 * Each selected printer's card carries its own filament mapping panel.
 */
export function PrinterSelector({
  printers,
  selectedPrinterIds,
  onMultiSelect,
  isLoading = false,
  allowMultiple = false,
  showInactive = false,
  disableBusy = false,
  printerMappingResults,
  filamentReqs,
  renderMapping,
  assignmentMode = 'printer',
  onAssignmentModeChange,
  targetModel,
  onTargetModelChange,
  targetLocation,
  onTargetLocationChange,
  slicedForModel,
}: PrinterSelectorWithMappingProps) {
  const { t } = useTranslation();
  const { data: uiSettings } = useUiSettings();
  // State for showing all printers vs only matching model
  const [showAllPrinters, setShowAllPrinters] = useState(false);

  // Filter printers based on showInactive flag
  const activePrinters = showInactive ? printers : printers.filter((p) => p.is_active);

  // Fetch printer statuses to determine busy/idle state
  const statusQueries = useQueries({
    queries: activePrinters.map((printer) => ({
      queryKey: ['printerStatus', printer.id],
      queryFn: () => api.getPrinterStatus(printer.id),
      staleTime: 5000,
    })),
  });

  // Build a map of printer ID -> status for quick lookup
  const printerStatusMap = useMemo(() => {
    const map = new Map<number, PrinterStatus>();
    activePrinters.forEach((printer, idx) => {
      const query = statusQueries[idx];
      if (query?.data) {
        map.set(printer.id, query.data);
      }
    });
    return map;
  }, [activePrinters, statusQueries]);

  const isPrinterBusy = (printerId: number): boolean => {
    const status = printerStatusMap.get(printerId);
    if (!status) return false; // Unknown state — don't block
    if (!status.connected) return true;
    return !AVAILABLE_STATES.has(status.state ?? '');
  };

  const getPrinterStateLabel = (printerId: number): string | null => {
    const status = printerStatusMap.get(printerId);
    if (!status) return null;
    if (!status.connected) return 'Offline';
    const state = status.state;
    if (!state) return null;
    if (state === 'RUNNING') return status.stg_cur_name || 'Printing';
    if (state === 'PREPARE') return 'Preparing';
    if (state === 'PAUSE') return 'Paused';
    if (state === 'IDLE') return 'Idle';
    if (state === 'FINISH') return 'Finished';
    if (state === 'FAILED') return 'Failed';
    return state;
  };

  // Filter by sliced model (only in printer mode, when slicedForModel is set)
  const displayPrinters = useMemo(() => {
    if (assignmentMode !== 'printer' || !slicedForModel || showAllPrinters) {
      return activePrinters;
    }
    // Filter to only show printers matching the sliced model
    const matching = activePrinters.filter((p) => p.model === slicedForModel);
    // If no matching printers, show all
    if (matching.length === 0) return activePrinters;
    // A selected printer is never hidden: its card is where its mapping lives.
    return activePrinters.filter((p) => p.model === slicedForModel || selectedPrinterIds.includes(p.id));
  }, [activePrinters, assignmentMode, slicedForModel, showAllPrinters, selectedPrinterIds]);

  // Check if there are hidden printers due to model filtering
  const hiddenPrinterCount = activePrinters.length - displayPrinters.length;

  // Get unique models from available printers (for model-based assignment)
  const uniqueModels = useMemo(() => {
    const models = activePrinters
      .map(p => p.model)
      .filter((m): m is string => Boolean(m));
    return [...new Set(models)].sort();
  }, [activePrinters]);

  // Get unique locations for the selected target model (for location filtering)
  const uniqueLocations = useMemo(() => {
    if (!targetModel) return [];
    const locations = activePrinters
      .filter(p => p.model === targetModel && p.location)
      .map(p => p.location)
      .filter((l): l is string => Boolean(l));
    return [...new Set(locations)].sort();
  }, [activePrinters, targetModel]);

  // Check if model-based assignment is available (need callbacks and multiple printers of same model)
  const modelAssignmentAvailable = onAssignmentModeChange && onTargetModelChange && uniqueModels.length > 0;

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="w-6 h-6 text-bambu-green animate-spin" />
      </div>
    );
  }

  if (displayPrinters.length === 0) {
    return (
      <div className="flex items-center gap-2 text-red-700 dark:text-red-400 text-sm mb-4">
        <AlertCircle className="w-4 h-4" />
        No {showInactive ? '' : 'active '}printers available
      </div>
    );
  }

  const handlePrinterClick = (printerId: number) => {
    if (disableBusy && isPrinterBusy(printerId)) return;

    if (allowMultiple) {
      if (selectedPrinterIds.includes(printerId)) {
        onMultiSelect(selectedPrinterIds.filter((id) => id !== printerId));
      } else {
        onMultiSelect([...selectedPrinterIds, printerId]);
      }
    } else {
      onMultiSelect([printerId]);
    }
  };

  const handleSelectAll = () => {
    const selectable = disableBusy
      ? displayPrinters.filter((p) => !isPrinterBusy(p.id))
      : displayPrinters;
    onMultiSelect(selectable.map((p) => p.id));
  };

  const handleDeselectAll = () => {
    onMultiSelect([]);
  };

  const isSelected = (printerId: number) => selectedPrinterIds.includes(printerId);
  const selectedCount = selectedPrinterIds.length;

  // Whether the printer already holds the filaments this print needs, shown
  // on every card so the choice of printer can be made on it. A selected
  // printer reports the mapping that will be sent (manual picks included); the
  // others, what auto-matching would give them.
  const readinessOf = (printerId: number): PrinterMatchStatus | null => {
    if (!filamentReqs?.filaments?.length) return null;
    const result = printerMappingResults?.find((r) => r.printerId === printerId);
    if (result) return result.status ? result.matchStatus : null;
    const status = printerStatusMap.get(printerId);
    if (!status?.connected) return null;
    const comparison = buildFilamentComparison(
      filamentReqs,
      buildLoadedFilaments(status),
      {},
      effectivePreferLowest(uiSettings?.prefer_lowest_filament, status.ams_filament_backup),
      undefined,
      status.fila_switch?.installed === true,
    );
    if (comparison.some((f) => f.status === 'mismatch')) return 'missing';
    return comparison.some((f) => f.status === 'type_only') ? 'partial' : 'full';
  };

  return (
    <div className="space-y-2 mb-6">
      {/* Assignment mode toggle (model vs specific printer) */}
      {modelAssignmentAvailable && (
        <div className="flex gap-2 mb-4">
          <button
            type="button"
            onClick={() => {
              onAssignmentModeChange!('printer');
              onTargetModelChange!(null);
            }}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
              assignmentMode === 'printer'
                ? 'border-bambu-green bg-bambu-green/10 text-white'
                : 'border-bambu-dark-tertiary bg-bambu-dark text-bambu-gray hover:border-bambu-gray'
            }`}
          >
            <PrinterIcon className="w-4 h-4" />
            <span className="text-sm">Specific Printer</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onAssignmentModeChange!('model');
              onMultiSelect([]);
              // Pre-select the sliced-for model when it has printers. NEVER
              // silently fall back to another model (#2578): uniqueModels is
              // alphabetically sorted, so the old `uniqueModels[0]` default
              // quietly targeted e.g. H2D for an X1C-sliced file whenever the
              // metadata hadn't loaded yet. Leave it unset and let the user
              // pick from the dropdown instead.
              const defaultModel = slicedForModel && uniqueModels.includes(slicedForModel)
                ? slicedForModel
                : null;
              onTargetModelChange!(defaultModel);
            }}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
              assignmentMode === 'model'
                ? 'border-bambu-green bg-bambu-green/10 text-white'
                : 'border-bambu-dark-tertiary bg-bambu-dark text-bambu-gray hover:border-bambu-gray'
            }`}
          >
            <Users className="w-4 h-4" />
            {/* In model mode the label must reflect the ACTUAL scheduler
                target, not the slice metadata — an edited queue item can
                target a different model than the file was sliced for (#2578). */}
            <span className="text-sm">
              Any {(assignmentMode === 'model' ? targetModel : null) || slicedForModel || 'Model'}
            </span>
          </button>
        </div>
      )}

      {/* Model selection and location filter (when in model mode) */}
      {assignmentMode === 'model' && modelAssignmentAvailable && (
        <div className="space-y-3 mb-4">
          {/* Model selector — always visible in model mode so a wrong target
              on an existing queue item can be seen and fixed (#2578).
              Incompatible models are disabled: G-code sliced for one model
              must only go to that model or its interchange family. */}
          <div>
            <label className="block text-xs text-bambu-gray mb-1">
              Target Model
              {slicedForModel && <span className="ml-2 text-bambu-gray/70">(sliced for {slicedForModel})</span>}
            </label>
            <select
              value={targetModel || ''}
              onChange={(e) => {
                onTargetModelChange!(e.target.value || null);
                // Clear location when model changes
                if (onTargetLocationChange) {
                  onTargetLocationChange(null);
                }
              }}
              className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none text-sm"
            >
              <option value="">Select a model...</option>
              {uniqueModels.map((model) => {
                const compatible = isGcodeCompatible(slicedForModel, model);
                return (
                  <option key={model} value={model} disabled={!compatible}>
                    {model}
                    {!compatible ? ` — incompatible with ${slicedForModel} G-code` : ''}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Cross-model state on an existing row: same file/target mismatch
              the specific-printer path already warns about (#2578). */}
          {slicedForModel && targetModel && targetModel !== slicedForModel && (
            isGcodeCompatible(slicedForModel, targetModel) ? (
              <div className="p-3 bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-300 dark:border-yellow-500/30 rounded-lg flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />
                <span className="text-sm text-yellow-700 dark:text-yellow-400">
                  File was sliced for {slicedForModel}, but will be dispatched to a {targetModel} printer
                </span>
              </div>
            ) : (
              <div className="p-3 bg-red-50 dark:bg-red-500/10 border border-red-300 dark:border-red-500/30 rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0" />
                <span className="text-sm text-red-700 dark:text-red-400">
                  File was sliced for {slicedForModel} and cannot be dispatched to {targetModel} printers —
                  select a compatible model
                </span>
              </div>
            )
          )}

          {/* Location filter (only show when target model is selected and locations exist) */}
          {targetModel && uniqueLocations.length > 0 && onTargetLocationChange && (
            <div>
              <label className="block text-xs text-bambu-gray mb-1">Location Filter (optional)</label>
              <select
                value={targetLocation || ''}
                onChange={(e) => onTargetLocationChange(e.target.value || null)}
                className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none text-sm"
              >
                <option value="">Any location</option>
                {uniqueLocations.map((location) => (
                  <option key={location} value={location}>
                    {location}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Info text */}
          {targetModel && (
            <p className="text-xs text-bambu-gray">
              Scheduler will assign to first available idle {targetModel} printer
              {targetLocation ? ` in ${targetLocation}` : ''}
            </p>
          )}
        </div>
      )}

      {/* Multi-select header (only in printer mode) */}
      {assignmentMode === 'printer' && allowMultiple && displayPrinters.length > 1 && (
        <div className="flex items-center justify-between text-xs text-bambu-gray mb-2">
          <span>
            {selectedCount === 0
              ? 'Select printers'
              : `${selectedCount} printer${selectedCount !== 1 ? 's' : ''} selected`}
          </span>
          <div className="flex gap-2">
            {selectedCount < displayPrinters.length && (
              <button
                type="button"
                onClick={handleSelectAll}
                className="text-bambu-green hover:text-bambu-green/80 transition-colors"
              >
                Select all
              </button>
            )}
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={handleDeselectAll}
                className="text-bambu-gray hover:text-white transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* Printer list (only in printer mode) */}
      {assignmentMode === 'printer' && displayPrinters.map((printer) => {
        const selected = isSelected(printer.id);
        const busy = isPrinterBusy(printer.id);
        const disabled = disableBusy && busy;
        const stateLabel = getPrinterStateLabel(printer.id);
        const readiness = readinessOf(printer.id);
        const mapping = selected ? renderMapping?.(printer.id) : null;

        return (
          // The card is the border; the button is its header, and a selected
          // printer's filament mapping unfolds inside the same border.
          <div
            key={printer.id}
            className={`rounded-lg border transition-colors duration-200 ${
              disabled
                ? 'border-bambu-dark-tertiary bg-bambu-dark opacity-50'
                : selected
                ? 'border-bambu-green bg-bambu-green/10'
                : 'border-bambu-dark-tertiary bg-bambu-dark hover:border-bambu-gray'
            } ${!printer.is_active ? 'opacity-60' : ''}`}
          >
            <button
              type="button"
              onClick={() => handlePrinterClick(printer.id)}
              disabled={disabled}
              aria-pressed={selected}
              className={`w-full flex items-center gap-3 p-3 rounded-lg transition-transform duration-100 active:scale-[0.99] motion-reduce:transition-none ${
                disabled ? 'cursor-not-allowed' : ''
              }`}
            >
              <div
                className={`p-2 rounded-lg transition-colors duration-200 ${
                  disabled ? 'bg-bambu-dark-tertiary' : selected ? 'bg-bambu-green/20' : 'bg-bambu-dark-tertiary'
                }`}
              >
                <PrinterIcon
                  className={`w-5 h-5 transition-colors duration-200 ${
                    disabled ? 'text-bambu-gray/50' : selected ? 'text-bambu-green' : 'text-bambu-gray'
                  }`}
                />
              </div>
              <div className="text-left flex-1 min-w-0">
                <p className={`font-medium truncate ${disabled ? 'text-bambu-gray' : 'text-white'}`}>
                  {printer.name}
                  {!printer.is_active && <span className="text-bambu-gray text-xs ml-2">(inactive)</span>}
                </p>
                <p className="text-xs text-bambu-gray">{printer.model || 'Unknown model'}</p>
              </div>
              {readiness && (
                <span
                  className={`animate-rise shrink-0 text-xs px-2 py-0.5 rounded-full transition-colors duration-200 ${
                    readiness === 'full'
                      ? 'bg-bambu-green/20 text-bambu-green'
                      : readiness === 'partial'
                      ? 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-400'
                      : 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-400'
                  }`}
                >
                  {readiness === 'full'
                    ? t('printModal.statusReady')
                    : readiness === 'partial'
                    ? t('printModal.statusColorMismatch')
                    : t('printModal.statusTypeNotFound')}
                </span>
              )}
              {stateLabel && (
                <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${
                  busy
                    ? 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-400'
                    : 'bg-bambu-dark-tertiary text-bambu-gray'
                }`}>
                  {stateLabel}
                </span>
              )}
              {allowMultiple && (
                <div
                  className={`shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors duration-150 ${
                    disabled
                      ? 'border-bambu-gray/30'
                      : selected
                      ? 'bg-bambu-green border-bambu-green'
                      : 'border-bambu-gray/50'
                  }`}
                >
                  {selected && <Check className="w-3 h-3 text-white animate-slice-done" />}
                </div>
              )}
            </button>
            {mapping}
          </div>
        );
      })}

      {/* Show hidden printers toggle */}
      {assignmentMode === 'printer' && hiddenPrinterCount > 0 && !showAllPrinters && (
        <button
          type="button"
          onClick={() => setShowAllPrinters(true)}
          className="text-xs text-bambu-gray hover:text-white transition-colors mt-2 flex items-center gap-1"
        >
          <AlertTriangle className="w-3 h-3 text-yellow-600 dark:text-yellow-400" />
          {hiddenPrinterCount} other printer{hiddenPrinterCount > 1 ? 's' : ''} hidden (different model) —
          <span className="underline">show all</span>
        </button>
      )}

      {/* Show matching only toggle */}
      {assignmentMode === 'printer' && showAllPrinters && slicedForModel && (
        <button
          type="button"
          onClick={() => setShowAllPrinters(false)}
          className="text-xs text-bambu-gray hover:text-white transition-colors mt-2"
        >
          <span className="underline">Show only {slicedForModel} printers</span>
        </button>
      )}

      {/* Warning when no printer selected (only in printer mode) */}
      {assignmentMode === 'printer' && selectedCount === 0 && (
        <p className="text-xs text-orange-700 dark:text-orange-400 mt-1 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          Select at least one printer
        </p>
      )}

      {/* Warning when no model selected (only in model mode) */}
      {assignmentMode === 'model' && !targetModel && (
        <p className="text-xs text-orange-700 dark:text-orange-400 mt-1 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          Select a target printer model
        </p>
      )}
    </div>
  );
}
