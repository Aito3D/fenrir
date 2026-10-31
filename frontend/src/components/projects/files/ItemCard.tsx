import { useEffect, useMemo, useRef, useState } from 'react';
import type { ViewerLinkState } from '../../viewer/viewerLink';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Calculator,
  Check,
  Download,
  ExternalLink,
  Eye,
  FileDown,
  GitFork,
  History,
  Info,
  LoaderCircle,
  MoreVertical,
  Pencil,
  Plus,
  Printer,
  Scissors,
  Tag,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { api } from '../../../api/client';
import type { LibraryFileListItem, ProjectFileOut, ProjectItemOut, ProjectRevisionOut, RevisionStatus } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { useCalcConfig } from '../../../hooks/useCalcConfig';
import { useUiSettings } from '../../../hooks/useUiSettings';
import { BulkTagsPickerModal } from '../../BulkTagsPickerModal';
import { ConfirmModal } from '../../ConfirmModal';
import { ContextMenu } from '../../ContextMenu';
import { Tooltip } from '../../Tooltip';
import { FileHistoryModal } from '../../FileHistoryModal';
import { LibraryFileDetailsModal } from '../../LibraryFileDetailsModal';
import { HoldButton } from '../../aito/HoldButton';
import type { ContextMenuItem } from '../../ContextMenu';
import { PartViewerModal } from '../../viewer/PartViewerModal';
import { inputCls, focusRingCls } from '../../formStyles';
import { calculatorPrefillUrl, estimateArchiveSalePrice } from '../../../utils/archivePricing';
import { formatMoney } from '../../../utils/pricing';
import { formatFileSize } from '../../../utils/file';
import { formatDuration } from '../../../utils/date';
import { projectKeys } from '../projectQueries';
import { PrintRevisionFlow } from '../print/PrintRevisionFlow';
import { DropShield } from '../DropShield';
import type { FileActions } from './useFileActions';
import { useFileDropZone } from './useFileDropZone';
import { useRevisionSlice } from './useRevisionSlice';
import type { RevisionSliceState } from './useRevisionSlice';
import { ItemDetailsTray, TRAY_LEAVE_MS } from './ItemDetailsTray';
import { SliceLine } from './SliceLine';
import { UploadSlicedDialog } from './UploadSlicedDialog';
import {
  PREVIEWABLE_TYPES,
  PRINTABLE_ACCEPT,
  STATUS_CHIP_CLS,
  STATUS_LABEL_KEYS,
  chipBase,
  isPrintableFile,
  isSectionEnabled,
  isSourceFilename,
  printProfileLine,
} from './filesUi';
import { outdatedParams, revisionNumberLabel } from './revisionLabel';

interface Props {
  item: ProjectItemOut;
  actions: FileActions;
  /** The details tray is open under this card's row. */
  open: boolean;
  onToggleDetails: () => void;
  /** Arrived after the grid first rendered (a fresh upload): rises in once. */
  entering?: boolean;
  /** Its slot in the section's first-render cascade (0..6), or -1 to settle in at once. */
  revealSlot?: number;
  /** Open the part viewer on mount, on this tab (a copied link to the file); consumed once. */
  autoOpen?: { tab: 'model' | 'toolpath'; state: ViewerLinkState | null } | null;
  onAutoOpened?: () => void;
}

/** A quiet tag laid over the picture: file type, printed count. Dark glass, mono, no colour. */
const pictureTag =
  'inline-flex items-center rounded-md border border-white/10 bg-bambu-dark/75 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide text-bambu-gray-light backdrop-blur-sm';

// 44px touch targets below md (px, not rem: the root rem is 14.4px); 32px-class icon buttons from md up, like the
// files panel's other icon buttons. The five share the footer row with the revision chips.
const actionBtn = `btn-press flex h-[44px] min-w-[44px] items-center justify-center rounded-md text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white md:h-8 md:min-w-8 ${focusRingCls}`;

/** The slice state as a 22px glyph in the picture's corner (design B, 2026-10-31): a check once
 *  sliced, a spinner while slicing, a triangle for a failure, scissors when not sliced yet. The
 *  words are the tooltip and the accessible name. A fresh "sliced" fades in with one press. */
function SliceGlyph({ state, percent, error, changed }: { state: RevisionSliceState; percent: number | null; error: string | null; changed: boolean }) {
  const { t } = useTranslation();
  const sliced = state === 'sliced' || state === 'legacy-sliced';
  const label = sliced
    ? t('projectsPdm.files.sliced')
    : state === 'slicing'
      ? percent !== null ? `${t('slice.slicing')} ${percent}%` : t('slice.slicing')
      : state === 'failed'
        ? error ? t('projectsPdm.slice.failed', { detail: error }) : t('queue.status.slice_failed')
        : t('projectsPdm.files.notSliced');
  const tone = sliced || state === 'slicing' ? 'text-bambu-green' : state === 'failed' ? 'text-red-400' : 'text-amber-400';
  const Icon = sliced ? Check : state === 'slicing' ? LoaderCircle : state === 'failed' ? TriangleAlert : Scissors;
  return (
    <Tooltip content={label} side="bottom" align="start">
      <span role="img" aria-label={label} data-testid="slice-glyph" data-state={state}
        className={`flex h-[22px] w-[22px] items-center justify-center rounded-full border border-white/10 bg-bambu-dark/75 backdrop-blur-sm ${tone} ${changed ? 'animate-fade-in' : ''}`}>
        <Icon className={`h-3 w-3 ${state === 'slicing' ? 'animate-spin motion-reduce:animate-none' : ''} ${sliced && changed ? 'animate-slice-done' : ''}`} aria-hidden />
      </span>
    </Tooltip>
  );
}
// 44px touch targets below md (the chip row wraps on a phone card), compact chips from md up.
const chipBtn = `btn-press inline-flex h-[44px] min-w-[44px] items-center justify-center rounded-md border px-2 font-mono text-sm font-semibold md:h-8 md:min-w-[40px] ${focusRingCls}`;

const isPreviewable = (f: ProjectFileOut) =>
  PREVIEWABLE_TYPES.includes(f.file_type.toLowerCase()) ||
  PREVIEWABLE_TYPES.some((p) => f.filename.toLowerCase().endsWith(`.${p}`));

/** The file Print sends: the source `.3mf` (the backend prints its slice, or slices it first),
 *  except a revision sliced before server slicing, which prints its own sliced file. */
function printFileOf(revision: ProjectRevisionOut, state: RevisionSliceState): ProjectFileOut | undefined {
  const printable = revision.files.filter((f) => isPrintableFile(f.filename));
  const source = printable.find((f) => isSourceFilename(f.filename));
  if (state === 'legacy-sliced') return printable.find((f) => !isSourceFilename(f.filename)) ?? source;
  return source ?? printable[0];
}

/** One Printing item as a card (layout D): the picked revision's picture, facts and slice state,
 *  icon actions, and the details tray rendered as the next grid cell. */
export function ItemCard({ item, actions, open, onToggleDetails, entering = false, revealSlot = -1, autoOpen = null, onAutoOpened }: Props) {
  const { t, i18n } = useTranslation();
  const { hasPermission, hasAnyPermission } = useAuth();
  const canUpdate = hasPermission('projects:update') && isSectionEnabled(item.section);
  const canPrint = hasPermission('queue:create'); // POST /queue/'s own gate
  // The File Manager's desktop-handoff rule: the slicer-token endpoint's ownership read pair.
  const canHandoff = hasAnyPermission('library:read_all', 'library:read_own');
  const revisions = [...item.revisions].sort((a, b) => b.number - a.number);
  const [pickedId, setPickedId] = useState<number | null>(null);
  const shown = revisions.find((r) => r.id === pickedId) ?? revisions[0];
  const older = shown !== undefined && shown !== revisions[0];
  const slice = useRevisionSlice(shown);
  // The slice state each revision first showed on this card: a later change is news worth a
  // short entrance; the state a revision loads with (or is switched to via a chip) is not.
  const firstSlice = useRef(new Map<number, string>());
  if (shown && !firstSlice.current.has(shown.id)) firstSlice.current.set(shown.id, slice.state);
  const busy = actions.isBusy(item.id);
  const input = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Hold the status chip (0.5 s) to open the status picker; a tap only shows the hint.
  const statusRef = useRef<HTMLSpanElement>(null);
  const [statusMenu, setStatusMenu] = useState<{ x: number; y: number } | null>(null);
  const [printing, setPrinting] = useState<ProjectFileOut | null>(null);
  const [preview, setPreview] = useState<ProjectFileOut | null>(null);
  const [previewTab, setPreviewTab] = useState<'model' | 'toolpath' | undefined>(undefined);
  const [previewState, setPreviewState] = useState<ViewerLinkState | null>(null);
  useEffect(() => {
    if (!autoOpen || !shown) return;
    const file = shown.files[0] ?? shown.sliced_file;
    if (!file) return;
    setPreviewTab(autoOpen.tab);
    setPreviewState(autoOpen.state);
    setPreview(file);
    onAutoOpened?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the link's arrival
  }, [autoOpen]);
  // The hand-slice fallback dialog of a failed slice (upload the .gcode.3mf yourself).
  const [uploadSliced, setUploadSliced] = useState(false);
  // The ⋯ fork request: the tray opens that revision's block with its fork form showing.
  const [fork, setFork] = useState<{ revisionId: number; nonce: number } | null>(null);
  // The tray leaves the way it arrived: once `open` drops it stays mounted, inert, for the exit
  // beat (TRAY_LEAVE_MS) and only then unmounts. Reopening within the beat cancels the exit.
  const [leaving, setLeaving] = useState(false);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      setLeaving(false);
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    setLeaving(true);
    const id = window.setTimeout(() => setLeaving(false), TRAY_LEAVE_MS);
    return () => window.clearTimeout(id);
  }, [open]);
  const rename = useItemRename(item, actions);
  // The File Manager card's own entries (minus Print, Preview, Download, which are icons here,
  // and Move to project): calculator, history, tags, file details, delete.
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const canReadLibrary = hasPermission('library:read');
  const canEditLibrary = hasAnyPermission('library:update_own', 'library:update_all');
  const canDelete = hasPermission('projects:delete');
  const [history, setHistory] = useState<ProjectFileOut | null>(null);
  const [details, setDetails] = useState<LibraryFileListItem | null>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // A new revision is the newest: drop a picked older chip so the card shows it.
  const uploadNewRevision = async (files: File[]) => {
    if (await actions.uploadRevision(item.id, files)) setPickedId(null);
  };

  const { dragOver, ...dropHandlers } = useFileDropZone({
    canDrop: canUpdate && !busy,
    canHighlight: canUpdate,
    stopPropagation: 'dragOverAndDrop',
    onFiles: (files) => void uploadNewRevision(files),
  });

  const source = shown?.files.find((f) => isSourceFilename(f.filename));
  const display = source ?? shown?.files[0];
  const printFile = shown ? printFileOf(shown, slice.state) : undefined;
  const sliced = slice.state === 'sliced' || slice.state === 'legacy-sliced';
  // Print time and grams: the server slice, or a legacy revision's own sliced file.
  const timed = shown?.sliced_file ?? (slice.state === 'legacy-sliced' ? printFile : undefined);
  const profileLine = printProfileLine(shown?.print_profile ?? null);
  // The archive card's rows for the sliced file: calculator costs and price, layers, objects, material.
  const calcConfig = useCalcConfig();
  const { data: uiSettings } = useUiSettings();
  const currencyCode = uiSettings?.currency || 'USD';
  const outdated = shown?.outdated_by && shown.derived_from ? outdatedParams(shown.derived_from, shown.outdated_by) : null;
  const printerHints = [shown?.print_profile?.printer_model as string | undefined, timed?.sliced_for_model];
  // The archive card's calculator estimate, for the headline price and its cost (PrintFacts' maths).
  const estimate = useMemo(
    () =>
      timed && calcConfig
        ? estimateArchiveSalePrice(
            {
              print_time_seconds: timed.print_time_seconds ?? null,
              filament_used_grams: timed.filament_used_grams ?? null,
              filament_type: timed.filament_type ?? null,
              filament_vendor: timed.filament_vendor,
            },
            calcConfig.filaments,
            calcConfig.printers,
            calcConfig.defaults,
            printerHints,
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the hints are a fresh array each render; their values are what matter
    [timed, calcConfig, ...printerHints],
  );
  const priceTitle = estimate
    ? [
        t('archives.card.suggestedPriceTooltip', {
          filament: estimate.filamentName,
          printer: estimate.printerName,
          unitCost: formatMoney(estimate.unitCost, currencyCode),
          sizeMargin: estimate.sizeMargin.toFixed(3),
        }),
        ...(estimate.filamentMatched
          ? []
          : [t('archives.card.suggestedPriceNoFilamentMatch', { material: timed?.filament_type || '—', filament: estimate.filamentName })]),
        ...(estimate.floorApplied ? [t('archives.card.suggestedPriceFloor')] : []),
      ].join('\n')
    : undefined;
  const layers = timed?.total_layers && timed.total_layers > 0 ? timed.total_layers : null;
  const objects = timed?.object_count && timed.object_count > 0 ? timed.object_count : null;
  const colours = (timed?.filament_color ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  // One meta line: the print profile (or, without one, what the sliced file says), colours, layers, objects.
  // The printer's family name is the shop's one brand: "H2S", not "Bambu Lab H2S", on the card (the tooltip keeps it).
  const metaFull = profileLine ?? [timed?.sliced_for_model, timed?.layer_height ? `${timed.layer_height} mm` : null, timed?.filament_type].filter(Boolean).join(' · ');
  const metaLead = metaFull.replace(/^Bambu Lab /, '');
  const metaTitle = [metaFull, layers ? t(layers === 1 ? 'archives.card.layer' : 'archives.card.layers', { count: layers }) : null,
    objects ? t(objects === 1 ? 'archives.card.object' : 'archives.card.objects', { count: objects }) : null].filter(Boolean).join(' · ');
  const canSlice = canUpdate && !!source && (slice.state === 'none' || slice.state === 'failed');
  const canUploadSliced = canUpdate && !!source && slice.state === 'failed';
  // Printed how many times: the File Manager's counter on the file Print sends (or the shown
  // file), or the revision's printed quantity from its archives — whichever knows more.
  const printed = Math.max(shown?.print_count ?? 0, printFile?.print_count ?? 0, display?.print_count ?? 0, timed?.print_count ?? 0);
  const historyFile = printFile ?? display;
  const openDetails = async (f: ProjectFileOut) => {
    try {
      const full = await api.getLibraryFile(f.id);
      setDetails({ ...full, fs_modified_at: null });
    } catch {
      showToast(t('common.error'), 'error');
    }
  };

  const toggleDetails = () => {
    if (open) setFork(null);
    onToggleDetails();
  };

  const menuItems: ContextMenuItem[] = [
    { label: t('projectsPdm.files.details'), icon: <Info className="h-4 w-4" />, onClick: toggleDetails },
    ...(canUpdate ? [{ label: t('projectsPdm.files.rename'), icon: <Pencil className="h-4 w-4" />, onClick: rename.start }] : []),
    ...(timed
      ? [{
          label: t('archives.menu.openInCalculator'),
          icon: <Calculator className="h-4 w-4" />,
          onClick: () =>
            navigate(
              calculatorPrefillUrl(
                { filament_used_grams: timed.filament_used_grams ?? null, print_time_seconds: timed.print_time_seconds ?? null, filament_type: timed.filament_type ?? null, filament_vendor: timed.filament_vendor },
                calcConfig,
                [shown?.print_profile?.printer_model as string | undefined, timed.sliced_for_model],
              ),
            ),
        }]
      : []),
    ...(canReadLibrary && historyFile
      ? [{ label: t('fileManager.fileHistory.menuLabel'), icon: <History className="h-4 w-4" />, onClick: () => setHistory(historyFile) }]
      : []),
    ...(shown?.sliced_file
      ? [{
          label: t('projectsPdm.slice.downloadSliced'),
          icon: <FileDown className="h-4 w-4" />,
          onClick: () => void actions.download(shown.id, shown.sliced_file!.id, shown.sliced_file!.filename),
        }]
      : []),
    ...(canSlice && shown
      ? [{
          label: slice.state === 'failed' ? t('queue.retrySlice') : t('slice.action'),
          icon: <Scissors className="h-4 w-4" />,
          onClick: () => void actions.sliceRevision(shown.id),
        }]
      : []),
    ...(canUploadSliced
      ? [{
          label: t('projectsPdm.slice.uploadAction'),
          icon: <Upload className="h-4 w-4" />,
          onClick: () => setUploadSliced(true),
        }]
      : []),
    ...(canUpdate && shown
      ? [{
          label: t('projectsPdm.files.fork'),
          icon: <GitFork className="h-4 w-4" />,
          onClick: () => {
            setFork((f) => ({ revisionId: shown.id, nonce: (f?.nonce ?? 0) + 1 }));
            if (!open) onToggleDetails();
          },
        }]
      : []),
    ...(canEditLibrary && display
      ? [{ label: t('fileManager.tags.title'), icon: <Tag className="h-4 w-4" />, onClick: () => setTagsOpen(true) }]
      : []),
    ...(canReadLibrary && display
      ? [{ label: t('fileManager.details.title'), icon: <Info className="h-4 w-4" />, onClick: () => void openDetails(display) }]
      : []),
    ...(canDelete
      ? [{ label: t('common.delete'), icon: <Trash2 className="h-4 w-4" />, danger: true, onClick: () => setConfirmDelete(true) }]
      : []),
  ];

  // Every icon action says what it does in a tooltip (hover and keyboard focus), not a bare title.
  const icon = (label: string, node: ReactNode, onClick: () => void, extra = '') => (
    <Tooltip content={label}>
      <button type="button" aria-label={label} onClick={onClick} className={`${actionBtn} ${extra}`}>
        {node}
      </button>
    </Tooltip>
  );

  return (
    <>
      <li
        data-testid={`item-card-${item.id}`}
        className={`relative flex flex-col overflow-hidden rounded-lg border bg-bambu-dark-secondary transition-[border-color,box-shadow,transform] duration-150 ${
          entering ? 'animate-rise' : revealSlot >= 0 ? 'catalog-card-in' : ''
        } ${
          open || dragOver
            ? 'border-bambu-green ring-1 ring-bambu-green'
            : 'border-bambu-dark-tertiary can-hover:hover:-translate-y-0.5 can-hover:hover:border-bambu-green/50 can-hover:hover:shadow-lg motion-reduce:hover:translate-y-0'
        }`}
        style={revealSlot >= 0 ? ({ '--reveal-delay': `${revealSlot * 25}ms` } as CSSProperties) : undefined}
        {...dropHandlers}
      >
        <div className="relative">
          <div
            data-testid={`card-thumb-${item.id}`}
            className={`flex aspect-[4/3] items-center justify-center overflow-hidden bg-bambu-dark transition-opacity duration-200 ease-[var(--ease-signature)] ${older ? 'opacity-40' : ''}`}
          >
            {display?.has_thumbnail ? (
              <img src={api.getLibraryFileThumbnailUrl(display.id)} loading="lazy" alt=""
                className="h-full w-full object-cover brightness-125 contrast-110" />
            ) : (
              <Box className="h-12 w-12 text-bambu-gray/30" aria-hidden />
            )}
          </div>
          {/* Top-left: the slice state, then how many times the file was printed (opens its history). */}
          <div className="absolute left-2 top-2 flex items-center gap-1.5">
            {shown && <SliceGlyph state={slice.state} percent={slice.percent} error={slice.error} changed={slice.state !== firstSlice.current.get(shown.id)} />}
            {printed > 0 &&
              (canReadLibrary && historyFile ? (
                <Tooltip content={`${t('fileManager.printedCount', { count: printed })} — ${t('fileManager.fileHistory.viewHistoryAria')}`} side="bottom" align="start">
                  <button type="button" onClick={() => setHistory(historyFile)}
                    className={`${pictureTag} text-bambu-green hover:text-white ${focusRingCls}`}
                    aria-label={t('fileManager.fileHistory.viewHistoryAria')}>
                    {`${printed}×`}
                  </button>
                </Tooltip>
              ) : (
                <Tooltip content={t('fileManager.printedCount', { count: printed })} side="bottom" align="start">
                  <span className={`${pictureTag} text-bambu-green`}>{`${printed}×`}</span>
                </Tooltip>
              ))}
          </div>
          {display && <span className={`${pictureTag} absolute right-2 top-2`}>{display.file_type.toUpperCase()}</span>}
          {outdated && (
            <span title={t('projectsPdm.files.outdated', outdated)}
              className="absolute bottom-2 left-2 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-black">
              {t('projectsPdm.files.outdatedBadge')}
            </span>
          )}
          {older && (
            <span className="absolute inset-x-0 bottom-0 animate-fade-in bg-black/70 py-1 text-center text-[11px] text-bambu-gray-light">
              {t('projectsPdm.files.olderRevision')}
            </span>
          )}
        </div>

        <div className="flex-1 px-3 pb-2 pt-2.5 text-xs text-bambu-gray">
          <div className="flex items-center gap-2">
            {rename.renaming !== null && !open ? (
              rename.field
            ) : (
              <button type="button" aria-expanded={open} onClick={toggleDetails} title={item.name}
                className={`block min-h-[44px] min-w-0 flex-1 truncate rounded text-left text-sm font-medium text-white md:min-h-0 ${focusRingCls}`}>
                {item.name}
              </button>
            )}
            {shown && canUpdate ? (
              // `flex [&>div]:flex`: HoldButton's block wrapper would otherwise add the row's line strut.
              <span ref={statusRef} className="flex shrink-0 [&>div]:flex">
                <HoldButton
                  onHold={(origin) => {
                    const rect = origin ?? statusRef.current?.getBoundingClientRect();
                    if (rect) setStatusMenu({ x: rect.right, y: rect.bottom });
                  }}
                  durationMs={500}
                  progress="bar"
                  barClassName="bg-white/15"
                  pressEffect="none"
                  label={t('projectsPdm.files.statusLabel')}
                  hint={t('projectsPdm.files.holdToChangeStatus')}
                  hintPlacement="bottom"
                  className={`${chipBase} text-[11px] ${STATUS_CHIP_CLS[shown.status]}`}
                >
                  {t(STATUS_LABEL_KEYS[shown.status])}
                </HoldButton>
              </span>
            ) : shown ? (
              <span className={`${chipBase} shrink-0 text-[11px] ${STATUS_CHIP_CLS[shown.status]}`}>{t(STATUS_LABEL_KEYS[shown.status])}</span>
            ) : null}
          </div>
          {shown && (
            <div key={shown.id} className="animate-fade-in">
              {timed && (
                <div className="mt-1.5 flex items-end gap-4">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wide text-bambu-gray/70">{t('projectsPdm.files.headPrint')}</div>
                    <div className="truncate text-sm font-medium text-white">
                      <span>{timed.print_time_seconds ? formatDuration(timed.print_time_seconds) : '—'}</span>
                      {timed.filament_used_grams ? (
                        <>
                          <span className="font-normal text-bambu-gray/50">{' · '}</span>
                          <span className="font-normal text-bambu-gray">{`${timed.filament_used_grams.toFixed(1)} g`}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  {estimate && (
                    <div className="ml-auto shrink-0 text-right">
                      <div className="text-[10px] uppercase tracking-wide text-bambu-gray/70">{t('projectsPdm.files.headPrice')}</div>
                      <div data-testid="print-facts-price" title={priceTitle} className="text-sm font-semibold text-white">
                        {formatMoney(estimate.totalTtc, currencyCode)}
                      </div>
                      <div data-testid="print-facts-machine-cost" title={t('calculator.machineCost')} className="-mt-0.5 text-[11px]">
                        {t('projectsPdm.files.headCost', { amount: formatMoney(estimate.machineCost, currencyCode) })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {(metaLead || colours.length > 0 || layers || objects) && (
                <div className="mt-1.5 flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap" title={metaTitle}>
                  {metaLead && <span className="truncate">{metaLead}</span>}
                  {colours.length > 0 && (
                    <span data-testid="print-facts-material" className="flex shrink-0 items-center gap-0.5">
                      {colours.map((color, i) => (
                        <span key={`${color}-${i}`} className="h-3 w-3 rounded-full border border-black/20" style={{ backgroundColor: color }} title={color} />
                      ))}
                    </span>
                  )}
                  {layers && (
                    <>
                      <span className="shrink-0 text-bambu-gray/50">·</span>
                      <span data-testid="print-facts-layers" className="shrink-0">{t(layers === 1 ? 'archives.card.layer' : 'archives.card.layers', { count: layers })}</span>
                    </>
                  )}
                  {objects && (
                    <>
                      <span className="shrink-0 text-bambu-gray/50">·</span>
                      <span data-testid="print-facts-objects" className="shrink-0">{t(objects === 1 ? 'archives.card.object' : 'archives.card.objects', { count: objects })}</span>
                    </>
                  )}
                </div>
              )}
              <SliceLine key={`${shown.id}-${slice.state}`} state={slice.state} percent={slice.percent} error={slice.error}
                changed={slice.state !== firstSlice.current.get(shown.id)}
                onRetry={canUpdate && source ? () => void actions.sliceRevision(shown.id) : undefined}
                onUpload={canUploadSliced ? () => setUploadSliced(true) : undefined} />
              <div className="mt-1.5 flex items-center gap-1 text-[11px]">
                <span className="truncate">
                  {[shown.created_by ? t('projectsPdm.files.byAuthor', { name: shown.created_by }) : null,
                    new Date(shown.created_at).toLocaleDateString(i18n.language)].filter(Boolean).join(' · ')}
                </span>
                {display && (
                  <>
                    <span className="shrink-0 text-bambu-gray/50">·</span>
                    <span className="shrink-0">{formatFileSize(display.file_size)}</span>
                  </>
                )}
              </div>
            </div>
          )}
          {busy && <p role="status" className="mt-1 text-bambu-green">{t('projectsPdm.files.uploading')}</p>}
        </div>

        {/* One footer: the revision chips, then the actions. */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-bambu-dark-tertiary px-2 py-1.5">
          {revisions.map((r) => {
            const current = r === shown;
            return (
              <Tooltip key={r.id} content={`${revisionNumberLabel(r.number)} · ${t(STATUS_LABEL_KEYS[r.status])}`}>
                <button type="button" aria-pressed={current} onClick={() => setPickedId(r.id)}
                  className={`${chipBtn} ${current ? 'border-bambu-green bg-bambu-green/15 text-white' : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white'}`}>
                  {revisionNumberLabel(r.number)}
                </button>
              </Tooltip>
            );
          })}
          <Tooltip content={t('projectsPdm.files.newRevision')}>
            <button type="button" aria-label={t('projectsPdm.files.newRevision')}
              disabled={!canUpdate || busy} onClick={() => input.current?.click()}
              className={`${chipBtn} border-dashed border-bambu-dark-tertiary text-bambu-gray hover:border-bambu-green hover:text-bambu-green disabled:opacity-40 disabled:hover:border-bambu-dark-tertiary disabled:hover:text-bambu-gray`}>
              <Plus className="h-4 w-4" />
            </button>
          </Tooltip>
          <span className="ml-auto flex flex-nowrap items-center gap-0.5">
            {canPrint && printFile &&
              icon(t('projectsPdm.print.print'), <Printer className="h-4 w-4" />, () => setPrinting(printFile), sliced ? 'text-bambu-green' : '')}
            {canHandoff && source &&
              icon(t('projectsPdm.slice.openInSlicer'), <ExternalLink className="h-4 w-4" />, () => void actions.openInSlicer(source))}
            {display && isPreviewable(display) && icon(t('projectsPdm.files.preview'), <Eye className="h-4 w-4" />, () => setPreview(display))}
            {shown && display &&
              icon(t('projectsPdm.files.download'), <Download className="h-4 w-4" />, () => void actions.download(shown.id, display.id, display.filename))}
            <Tooltip content={t('aito.moreActions')} align="end">
              <button ref={moreRef} type="button" aria-label={t('aito.moreActions')}
                aria-haspopup="menu" aria-expanded={menu !== null} className={actionBtn}
                onClick={(e) => {
                  if (menu) return setMenu(null);
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenu({ x: rect.right, y: rect.bottom });
                }}>
                <MoreVertical className="h-4 w-4" />
              </button>
            </Tooltip>
          </span>
        </div>

        {canUpdate && (
          <input ref={input} type="file" accept={PRINTABLE_ACCEPT} className="hidden" data-testid={`new-revision-input-${item.id}`}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) void uploadNewRevision(files);
            }} />
        )}
      </li>

      {(open || leaving) && (
        <ItemDetailsTray
          item={item}
          revision={shown}
          actions={actions}
          dropHandlers={dropHandlers}
          renameField={rename.field || null}
          onRename={rename.start}
          onClose={toggleDetails}
          fork={fork}
          leaving={!open}
        />
      )}

      {menu && createPortal(
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} anchorRef={moreRef} />,
        document.body,
      )}
      {statusMenu && shown && createPortal(
        <ContextMenu
          x={statusMenu.x}
          y={statusMenu.y}
          anchorRef={statusRef}
          onClose={() => setStatusMenu(null)}
          items={(Object.keys(STATUS_LABEL_KEYS) as RevisionStatus[]).map((status) => ({
            label: t(STATUS_LABEL_KEYS[status]),
            disabled: status === shown.status,
            onClick: () => void actions.setStatus(shown.id, status),
          }))}
        />,
        document.body,
      )}
      {preview && shown && (
        <DropShield>
          <PartViewerModal
            subject={{ kind: 'revision', projectId: actions.projectId, item, revision: shown }}
            title={item.name}
            onClose={() => { setPreview(null); setPreviewTab(undefined); setPreviewState(null); }}
            initialTab={previewTab}
            initialState={previewState}
            onPrint={canPrint && printFile ? () => { setPreview(null); setPrinting(printFile); } : undefined}
            onOpenInSlicer={canHandoff && source ? () => void actions.openInSlicer(source) : undefined}
            onDownload={(f) => void actions.download(shown.id, f.id, f.filename)}
            printed={printed}
          />
        </DropShield>
      )}
      {uploadSliced && shown && (
        <DropShield>
          <UploadSlicedDialog revision={shown} actions={actions} onClose={() => setUploadSliced(false)} />
        </DropShield>
      )}
      {printing && (
        <DropShield>
          <PrintRevisionFlow
            projectId={actions.projectId}
            file={printing}
            revisionWarning={outdated ? t('projectsPdm.print.outdatedWarning', outdated) : undefined}
            onClose={() => setPrinting(null)}
          />
        </DropShield>
      )}
      {history && (
        <DropShield>
          <FileHistoryModal fileId={history.id} filename={history.filename} onClose={() => setHistory(null)} />
        </DropShield>
      )}
      {details && (
        <DropShield>
          <LibraryFileDetailsModal file={details} canEdit={canEditLibrary} onClose={() => setDetails(null)} />
        </DropShield>
      )}
      {tagsOpen && display && (
        <DropShield>
          <BulkTagsPickerModal
            open
            singleMode
            fileIds={[display.id]}
            initialTagIds={display.tag_ids ?? []}
            onClose={() => {
              setTagsOpen(false);
              // The tree carries each file's tag ids: a later open must start from the saved set.
              void queryClient.invalidateQueries({ queryKey: projectKeys.tree(actions.projectId) });
            }}
          />
        </DropShield>
      )}
      {confirmDelete && (
        <ConfirmModal
          title={t('projectsPdm.files.deleteItem')}
          message={t('projectsPdm.files.deleteItemConfirm', { name: item.name })}
          confirmText={t('common.delete')}
          variant="danger"
          isLoading={deleting}
          onConfirm={() => {
            setDeleting(true);
            void actions.deleteItem(item.id).finally(() => {
              setDeleting(false);
              setConfirmDelete(false);
            });
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}

/** The card's inline rename: the draft name (null when closed), the form that edits it, and
 *  `start`. Enter and blur save once (a changed, non-blank name); Escape cancels. */
function useItemRename(item: ProjectItemOut, actions: FileActions) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameDone = useRef(false);

  const start = () => {
    renameDone.current = false;
    setRenaming(item.name);
  };
  const cancelRename = () => {
    renameDone.current = true;
    setRenaming(null);
  };
  const submitRename = async () => {
    if (renameDone.current) return;
    renameDone.current = true;
    const name = (renaming ?? '').trim();
    setRenaming(null);
    if (name && name !== item.name) await actions.renameItem(item.id, name);
  };
  const field = renaming !== null && (
    <form className="flex min-w-0 flex-1 basis-40" onSubmit={(e) => { e.preventDefault(); void submitRename(); }}>
      <input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} onBlur={() => void submitRename()}
        aria-label={t('projectsPdm.files.rename')} className={inputCls}
        onKeyDown={(e) => e.key === 'Escape' && cancelRename()} />
    </form>
  );
  return { renaming, field, start };
}
