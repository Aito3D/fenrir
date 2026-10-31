import { useTranslation } from 'react-i18next';
import { Box, CircleCheck, Download, Images, Info, Layers, MapPin, Route, TriangleAlert, X } from 'lucide-react';
import { withMediaToken } from '../../api/client';
import type { RevisionPin } from '../../api/client';
import type { PlateMetadata } from '../../types/plates';
import type { PrintFileFacts } from '../PrintFacts';
import { Tooltip } from '../Tooltip';
import { focusRingCls } from '../formStyles';
import { formatDuration } from '../../utils/date';
import { formatFileSize } from '../../utils/file';
import { formatMoney } from '../../utils/pricing';
import type { FileEntry } from './partSources';
import type { PartBounds, PartObject } from './PartScene';
import type { ViewerCheck } from './viewerChecks';
import type { BuildVolume } from './printerBeds';

export interface RailPrint {
  facts: PrintFileFacts | null;
  layerCount: number | null;
  printer: string | null;
  nozzle: string | null;
  layerHeight: string | null;
  bedType: string | null;
  profile: string | null;
  filaments: Array<{ slot: number; type: string; color: string; grams: number | null; meters: number | null }>;
  estimate: { price: number; cost: number } | null;
  currencyCode: string;
}

export interface RailMeta {
  by: string | null;
  date: string | null;
  printed: number;
}

interface Props {
  plates: PlateMetadata[];
  multiPlate: boolean;
  selectedPlateId: number | null;
  onSelectPlate: (id: number | null) => void;
  objects: PartObject[];
  bounds: PartBounds | null;
  hoverIndex: number | null;
  isolatedIndex: number | null;
  onHover: (index: number | null) => void;
  onIsolate: (index: number) => void;
  checks: ViewerCheck[];
  print: RailPrint;
  volume: BuildVolume;
  onBedChange?: (printer: string) => void;
  bedChoices: string[];
  tab: 'model' | 'toolpath';
  onShowToolpath: (() => void) | null;
  pins: RevisionPin[];
  onDeletePin: ((pinId: number) => void) | null;
  files: FileEntry[];
  onDownload: ((file: FileEntry) => void) | null;
  meta: RailMeta;
  /** Photos of the printed result (archives, library files); clicking one shows it beside the part. */
  photos?: string[];
  shownPhoto?: number | null;
  onShowPhoto?: (index: number) => void;
}

const card = 'rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3';
const head = 'mb-2 text-[11px] uppercase tracking-wide text-bambu-gray';

/** Option A's rail: everything known about the part beside it. */
export function ViewerRail(p: Props) {
  const { t } = useTranslation();
  const size = p.bounds ? p.bounds.max.map((v, i) => v - p.bounds!.min[i]) : null;
  const facts = p.print.facts;
  return (
    <aside data-testid="viewer-rail" className="w-[320px] shrink-0 space-y-3 overflow-y-auto border-l border-bambu-dark-tertiary bg-bambu-dark-secondary p-3">
      {p.multiPlate && p.plates.length > 0 && (
        <section className={card} data-testid="rail-plates">
          <div className={head}>{t('modelViewer.plates')}</div>
          <div className="grid grid-cols-3 gap-2">
            <PlateCard selected={p.selectedPlateId === null} onClick={() => p.onSelectPlate(null)} title={t('modelViewer.allPlates')} sub={t('modelViewer.plateCount', { count: p.plates.length })}>
              <Layers className="h-5 w-5 text-bambu-gray" aria-hidden />
            </PlateCard>
            {p.plates.map((plate) => (
              <PlateCard key={plate.index} selected={p.selectedPlateId === plate.index} onClick={() => p.onSelectPlate(plate.index)}
                title={plate.name || t('modelViewer.plateNumber', { number: plate.index })}
                sub={[t('modelViewer.objectCount', { count: plate.object_count ?? plate.objects?.length ?? 0 }), plate.print_time_seconds ? formatDuration(plate.print_time_seconds) : null].filter(Boolean).join(' · ')}>
                {plate.has_thumbnail && plate.thumbnail_url ? (
                  <img src={withMediaToken(plate.thumbnail_url)} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Layers className="h-5 w-5 text-bambu-gray" aria-hidden />
                )}
              </PlateCard>
            ))}
          </div>
        </section>
      )}

      <section className={card} data-testid="rail-part">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wide text-bambu-gray">{t('partViewer.rail.part')}</span>
          {size && <span className="text-[11px] text-bambu-gray">{`${size[0].toFixed(1)} × ${size[1].toFixed(1)} × ${size[2].toFixed(1)} mm`}</span>}
        </div>
        {p.objects.length === 0 ? (
          <p className="text-xs text-bambu-gray">{p.tab === 'toolpath' ? t('partViewer.rail.objectsFromModel') : t('partViewer.rail.noObjects')}</p>
        ) : (
          <ul className="space-y-0.5">
            {p.objects.map((o) => (
              <li key={o.index}>
                <button type="button" aria-pressed={p.isolatedIndex === o.index} onMouseEnter={() => p.onHover(o.index)} onMouseLeave={() => p.onHover(null)} onClick={() => p.onIsolate(o.index)}
                  title={t('partViewer.rail.isolateHint')}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs ${p.hoverIndex === o.index || p.isolatedIndex === o.index ? 'bg-bambu-dark-tertiary' : 'hover:bg-bambu-dark-tertiary/60'} ${focusRingCls}`}>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-white/25" style={{ backgroundColor: o.color }} />
                  <span className="flex-1 truncate text-white">{o.name}</span>
                  <span className="text-bambu-gray">{o.size.join('×')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {p.objects.length > 1 && <div className="mt-2 text-[11px] text-bambu-gray">{t('partViewer.rail.isolateHint')}</div>}
      </section>

      {p.checks.length > 0 && (
        <section className={card} data-testid="rail-checks">
          <div className={head}>{t('partViewer.rail.checks')}</div>
          <ul className="space-y-1 text-xs">
            {p.checks.map((c) => (
              <li key={c.id} className={`flex items-start gap-2 ${c.level === 'warn' ? 'text-amber-400' : 'text-bambu-gray'}`}>
                {c.level === 'warn' ? <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : c.level === 'ok' ? <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bambu-green" aria-hidden /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
                <span>{t(`partViewer.checks.${c.key}`, c.params)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={card} data-testid="rail-print">
        <div className={head}>{t('partViewer.rail.print')}{!facts && p.tab === 'model' ? ` · ${t('partViewer.rail.notSlicedShort')}` : ''}</div>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
          {facts?.print_time_seconds ? (<><dt className="text-bambu-gray">{t('archives.printTime')}</dt><dd className="text-right tabular-nums text-white">{formatDuration(facts.print_time_seconds)}</dd></>) : null}
          {facts?.filament_used_grams ? (<><dt className="text-bambu-gray">{t('partViewer.print.filament')}</dt><dd className="text-right tabular-nums text-white">{`${facts.filament_used_grams.toFixed(1)} g`}</dd></>) : null}
          {p.print.layerCount || facts?.total_layers ? (<><dt className="text-bambu-gray">{t('partViewer.print.layers')}</dt><dd className="text-right tabular-nums text-white">{[p.print.layerCount ?? facts?.total_layers, p.print.layerHeight].filter(Boolean).join(' · ')}</dd></>) : null}
          <dt className="text-bambu-gray">{t('partViewer.print.printer')}</dt>
          <dd className="text-right text-white">
            {p.onBedChange ? (
              <select value={p.print.printer ?? ''} onChange={(e) => p.onBedChange?.(e.target.value)} aria-label={t('partViewer.print.bed')}
                className="rounded border border-bambu-dark-tertiary bg-bambu-dark px-1 py-0.5 text-[11px] text-white">
                {(p.print.printer && !p.bedChoices.includes(p.print.printer) ? [p.print.printer, ...p.bedChoices] : p.bedChoices).map((name) => (
                  <option key={name} value={name}>{`${name.replace('Bambu Lab ', '')} · ${p.volume.x}×${p.volume.y}`}</option>
                ))}
              </select>
            ) : (
              p.print.printer?.replace('Bambu Lab ', '') || '—'
            )}
          </dd>
          {p.print.nozzle && (<><dt className="text-bambu-gray">{t('partViewer.print.nozzle')}</dt><dd className="text-right tabular-nums text-white" data-testid="rail-nozzle">{p.print.nozzle}</dd></>)}
          {p.print.bedType && (<><dt className="text-bambu-gray">{t('partViewer.print.plate')}</dt><dd className="text-right text-white">{p.print.bedType}</dd></>)}
          {p.print.profile && (<><dt className="text-bambu-gray">{t('partViewer.print.profile')}</dt><dd className="max-w-[160px] truncate text-right text-white" title={p.print.profile}>{p.print.profile}</dd></>)}
        </dl>
        {p.print.filaments.length > 0 && (
          <ul className="mt-2 space-y-1">
            {p.print.filaments.map((f) => (
              <li key={`${f.slot}-${f.type}`} className="flex items-center gap-2 text-xs">
                <span className="w-6 text-bambu-gray">{`A${f.slot}`}</span>
                <span className="h-2.5 w-2.5 rounded-full border border-white/25" style={{ backgroundColor: f.color }} />
                <span className="text-white">{f.type}</span>
                <span className="ml-auto text-bambu-gray">{[f.grams != null ? `${f.grams.toFixed(1)} g` : null, f.meters != null ? `${f.meters.toFixed(1)} m` : null].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        )}
        {p.print.estimate && (
          <div className="mt-3 flex items-end justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-bambu-gray">{t('projectsPdm.files.headPrice')}</div>
              <div className="text-base font-semibold text-white">{formatMoney(p.print.estimate.price, p.print.currencyCode)}</div>
            </div>
            <div className="text-[11px] text-bambu-gray">{t('projectsPdm.files.headCost', { amount: formatMoney(p.print.estimate.cost, p.print.currencyCode) })}</div>
          </div>
        )}
        {p.tab === 'model' && p.onShowToolpath && (
          <button type="button" onClick={p.onShowToolpath} className={`mt-2 flex items-center gap-1 rounded text-xs text-bambu-green hover:underline ${focusRingCls}`}>
            <Route className="h-3.5 w-3.5" aria-hidden />{t('partViewer.rail.seeToolpath')}
          </button>
        )}
      </section>

      {p.pins.length > 0 && (
        <section className={card} data-testid="rail-notes">
          <div className={head}>{t('partViewer.rail.notes')}</div>
          <ul className="space-y-1 text-xs">
            {p.pins.map((pin) => (
              <li key={pin.id} className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
                <span className="flex-1 text-white">{pin.text}{pin.created_by ? <span className="text-bambu-gray">{` · ${pin.created_by}`}</span> : null}</span>
                {p.onDeletePin && (
                  <Tooltip content={t('partViewer.rail.deleteNote')} align="end">
                    <button type="button" onClick={() => p.onDeletePin?.(pin.id)} aria-label={t('partViewer.rail.deleteNote')}
                      className={`flex h-6 w-6 items-center justify-center rounded text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.photos && p.photos.length > 0 && (
        <section className={card} data-testid="rail-photos">
          <div className={head}>{t('partViewer.photos.title')}</div>
          <div className="grid grid-cols-3 gap-1.5">
            {p.photos.map((url, i) => (
              <button key={url} type="button" aria-pressed={p.shownPhoto === i} onClick={() => p.onShowPhoto?.(i)} aria-label={`${t('partViewer.photos.title')} ${i + 1}`}
                className={`aspect-square overflow-hidden rounded-md border bg-bambu-dark ${p.shownPhoto === i ? 'border-bambu-green ring-1 ring-bambu-green' : 'border-bambu-dark-tertiary hover:border-bambu-gray'} ${focusRingCls}`}>
                <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-bambu-gray"><Images className="h-3.5 w-3.5" aria-hidden />{t('partViewer.photos.hint')}</div>
        </section>
      )}

      {p.files.length > 0 && (
        <section className={card} data-testid="rail-files">
          <div className={head}>{t('partViewer.rail.files')}</div>
          <ul className="space-y-1.5 text-xs">
            {p.files.map((f) => (
              <li key={f.id} className="flex items-center gap-2">
                {f.role === 'sliced' ? <Route className="h-3.5 w-3.5 shrink-0 text-bambu-gray" aria-hidden /> : <Box className="h-3.5 w-3.5 shrink-0 text-bambu-gray" aria-hidden />}
                <span className="flex-1 truncate text-white" title={f.filename}>{f.filename}{f.size ? <span className="text-bambu-gray">{` · ${formatFileSize(f.size)}`}</span> : null}</span>
                {p.onDownload && (
                  <Tooltip content={t('projectsPdm.files.download')} align="end">
                    <button type="button" onClick={() => p.onDownload?.(f)} aria-label={`${t('projectsPdm.files.download')} ${f.filename}`}
                      className={`flex h-7 w-7 items-center justify-center rounded-md text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}>
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                )}
              </li>
            ))}
          </ul>
          {(p.meta.by || p.meta.date || p.meta.printed > 0) && (
            <div className="mt-2 text-[11px] text-bambu-gray">
              {[p.meta.by ? t('projectsPdm.files.byAuthor', { name: p.meta.by }) : null, p.meta.date].filter(Boolean).join(' · ')}
              {p.meta.printed > 0 && <span className="text-bambu-green">{` · ${t('fileManager.printedCount', { count: p.meta.printed })}`}</span>}
            </div>
          )}
        </section>
      )}
    </aside>
  );
}

function PlateCard({ selected, onClick, title, sub, children }: { selected: boolean; onClick: () => void; title: string; sub: string; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={selected} onClick={onClick}
      className={`overflow-hidden rounded-lg border bg-bambu-dark text-left ${selected ? 'border-bambu-green ring-1 ring-bambu-green' : 'border-bambu-dark-tertiary hover:border-bambu-gray'} ${focusRingCls}`}>
      <div className="flex aspect-square items-center justify-center overflow-hidden bg-bambu-dark">{children}</div>
      <div className="px-1.5 py-1 text-[11px]"><b className="text-white">{title}</b> <span className="text-bambu-gray">{sub}</span></div>
    </button>
  );
}
