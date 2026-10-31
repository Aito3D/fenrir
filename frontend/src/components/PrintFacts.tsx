import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Calculator, Coins, Layers } from 'lucide-react';
import { estimateArchiveSalePrice } from '../utils/archivePricing';
import type { CalcConfig } from '../utils/archivePricing';
import { formatMoney } from '../utils/pricing';

/** The facts a sliced file carries (``services.print_file_facts`` on the backend): the same
 *  shape on a File Manager file, a project revision's file and an archive. */
export interface PrintFileFacts {
  print_time_seconds?: number | null;
  filament_used_grams?: number | null;
  filament_type?: string | null;
  /** Comma-joined CSS colours, one per filament used (the archive card's format). */
  filament_color?: string | null;
  filament_vendor?: string | null;
  sliced_for_model?: string | null;
  total_layers?: number | null;
  layer_height?: number | null;
  nozzle_diameter?: number | null;
  object_count?: number | null;
}

interface Props {
  facts: PrintFileFacts;
  /** The calculator's filaments, printers and defaults; null hides the cost rows. */
  calcConfig: CalcConfig | null;
  currencyCode: string;
  /** Printer names to match a calculator printer against, most specific first. */
  printerHints?: Array<string | null | undefined>;
  /** The caller already names the material: show only its colours. */
  omitMaterialType?: boolean;
  className?: string;
}

/** The rows the archive card shows under a print, for a file that is sliced but not printed:
 *  the calculator's machine cost and its suggested price (when the calculator is set up and the
 *  file carries weight and time; energy is inside the price, not a row of its own), then layers, objects, material and colours. Rows
 *  without data are left out; renders nothing when no row has any. */
export function PrintFacts({ facts, calcConfig, currencyCode, printerHints = [], omitMaterialType = false, className = '' }: Props) {
  const { t } = useTranslation();
  const estimate = useMemo(
    () =>
      calcConfig
        ? estimateArchiveSalePrice(
            {
              print_time_seconds: facts.print_time_seconds ?? null,
              filament_used_grams: facts.filament_used_grams ?? null,
              filament_type: facts.filament_type ?? null,
              filament_vendor: facts.filament_vendor ?? null,
            },
            calcConfig.filaments,
            calcConfig.printers,
            calcConfig.defaults,
            [
              ...printerHints,
              facts.sliced_for_model,
            ],
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hints are a fresh array each render; its values are what matter
    [facts, calcConfig, ...printerHints],
  );
  const layers = facts.total_layers && facts.total_layers > 0 ? facts.total_layers : null;
  const layerHeight = facts.layer_height && facts.layer_height > 0 ? facts.layer_height : null;
  const objects = facts.object_count && facts.object_count > 0 ? facts.object_count : null;
  const colors = (facts.filament_color ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  const materialType = omitMaterialType ? null : facts.filament_type;
  if (!estimate && !layers && !layerHeight && !objects && !materialType && colors.length === 0) return null;

  return (
    <div data-testid="print-facts" className={`flex flex-col gap-0.5 text-xs text-bambu-gray ${className}`}>
      {estimate && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span data-testid="print-facts-machine-cost" className="flex items-center gap-1" title={t('calculator.machineCost')}>
            <Coins className="h-3 w-3" aria-hidden />
            {formatMoney(estimate.machineCost, currencyCode)}
          </span>
          <span
            data-testid="print-facts-price"
            className="flex items-center gap-1"
            title={[
              t('archives.card.suggestedPriceTooltip', {
                filament: estimate.filamentName,
                printer: estimate.printerName,
                unitCost: formatMoney(estimate.unitCost, currencyCode),
                sizeMargin: estimate.sizeMargin.toFixed(3),
              }),
              ...(estimate.filamentMatched
                ? []
                : [t('archives.card.suggestedPriceNoFilamentMatch', { material: facts.filament_type || '—', filament: estimate.filamentName })]),
              ...(estimate.floorApplied ? [t('archives.card.suggestedPriceFloor')] : []),
            ].join('\n')}
          >
            <Calculator className="h-3 w-3" aria-hidden />
            {formatMoney(estimate.totalTtc, currencyCode)}
          </span>
        </div>
      )}
      {(layers || layerHeight) && (
        <div data-testid="print-facts-layers" className="flex items-center gap-1">
          <Layers className="h-3 w-3" aria-hidden />
          {layers && <span>{t(layers === 1 ? 'archives.card.layer' : 'archives.card.layers', { count: layers })}</span>}
          {layers && layerHeight && <span className="text-bambu-gray/50">·</span>}
          {layerHeight && <span>{`${layerHeight}mm`}</span>}
        </div>
      )}
      {objects && (
        <div data-testid="print-facts-objects" className="flex items-center gap-1">
          <Box className="h-3 w-3" aria-hidden />
          {t(objects === 1 ? 'archives.card.object' : 'archives.card.objects', { count: objects })}
        </div>
      )}
      {(materialType || colors.length > 0) && (
        <div data-testid="print-facts-material" className="flex items-center gap-1.5">
          {materialType && <span>{materialType}</span>}
          {colors.length > 0 && (
            <span className="flex flex-wrap items-center gap-0.5">
              {colors.map((color, i) => (
                <span key={`${color}-${i}`} className="h-3 w-3 rounded-full border border-black/20" style={{ backgroundColor: color }} title={color} />
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
