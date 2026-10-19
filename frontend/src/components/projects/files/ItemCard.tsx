import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Box,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Eye,
  FileDown,
  GitFork,
  Info,
  MoreVertical,
  Package,
  Pencil,
  Plus,
  Printer,
  RotateCw,
  Scissors,
} from 'lucide-react';
import { api } from '../../../api/client';
import type { ProjectFileOut, ProjectItemOut, ProjectRevisionOut, RevisionStatus } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { ContextMenu } from '../../ContextMenu';
import type { ContextMenuItem } from '../../ContextMenu';
import { ModelViewerModal } from '../../ModelViewerModal';
import { inputCls, focusRingCls } from '../../formStyles';
import { formatFileSize } from '../../../utils/file';
import { formatDuration } from '../../../utils/date';
import { PrintRevisionFlow } from '../print/PrintRevisionFlow';
import { DropShield } from '../DropShield';
import type { FileActions } from './useFileActions';
import { useFileDropZone } from './useFileDropZone';
import { useRevisionSlice } from './useRevisionSlice';
import type { RevisionSliceState } from './useRevisionSlice';
import { ItemDetailsTray } from './ItemDetailsTray';
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
}

/** The 4px strip on top of the card: the shown revision's status (decision 14). */
const STRIP_CLS: Record<RevisionStatus, string> = {
  wip: 'bg-amber-400',
  valide: 'bg-bambu-green',
  obsolete: 'bg-slate-500',
};

/** The File Manager card's file-type badge colours: source green, sliced blue. */
const badgeCls = (fileType: string) =>
  fileType === '3mf'
    ? 'bg-bambu-green/90 text-white'
    : fileType === 'gcode' || fileType === 'gcode.3mf'
      ? 'bg-blue-500/90 text-white'
      : 'bg-bambu-gray/90 text-white';

// 44px touch targets below md (px, not rem: the root rem is 14.4px); 32px-class icon buttons from md up, like the
// files panel's other icon buttons. One row of five always fits (arithmetic in the task-7 report).
const actionBtn = `flex h-[44px] min-w-[44px] flex-1 items-center justify-center rounded-md text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white md:h-8 md:min-w-8 ${focusRingCls}`;
// 44px touch targets below md (the chip row wraps on a phone card), compact chips from md up.
const chipBtn = `inline-flex h-[44px] min-w-[44px] items-center justify-center rounded-md border px-2 font-mono text-sm font-semibold md:h-8 md:min-w-[40px] ${focusRingCls}`;

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
export function ItemCard({ item, actions, open, onToggleDetails, entering = false }: Props) {
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
  const [printing, setPrinting] = useState<ProjectFileOut | null>(null);
  const [preview, setPreview] = useState<ProjectFileOut | null>(null);
  // The ⋯ fork request: the tray opens that revision's block with its fork form showing.
  const [fork, setFork] = useState<{ revisionId: number; nonce: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameDone = useRef(false);

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
  const outdated = shown?.outdated_by && shown.derived_from ? outdatedParams(shown.derived_from, shown.outdated_by) : null;
  const canSlice = canUpdate && !!source && (slice.state === 'none' || slice.state === 'failed');

  const startRename = () => {
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
  const renameField = renaming !== null && (
    <form className="flex min-w-0 flex-1 basis-40" onSubmit={(e) => { e.preventDefault(); void submitRename(); }}>
      <input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} onBlur={() => void submitRename()}
        aria-label={t('projectsPdm.files.rename')} className={inputCls}
        onKeyDown={(e) => e.key === 'Escape' && cancelRename()} />
    </form>
  );

  const toggleDetails = () => {
    if (open) setFork(null);
    onToggleDetails();
  };

  const menuItems: ContextMenuItem[] = [
    { label: t('projectsPdm.files.details'), icon: <Info className="h-4 w-4" />, onClick: toggleDetails },
    ...(canUpdate ? [{ label: t('projectsPdm.files.rename'), icon: <Pencil className="h-4 w-4" />, onClick: startRename }] : []),
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
  ];

  const icon = (label: string, node: ReactNode, onClick: () => void, extra = '') => (
    <button type="button" title={label} aria-label={label} onClick={onClick} className={`${actionBtn} ${extra}`}>
      {node}
    </button>
  );

  return (
    <>
      <li
        data-testid={`item-card-${item.id}`}
        className={`relative flex flex-col overflow-hidden rounded-lg border bg-bambu-dark-secondary transition-colors ${entering ? 'animate-rise' : ''} ${
          open || dragOver ? 'border-bambu-green ring-1 ring-bambu-green' : 'border-bambu-dark-tertiary can-hover:hover:border-bambu-green/50'
        }`}
        {...dropHandlers}
      >
        <div data-testid={`status-strip-${item.id}`} className={`h-1 shrink-0 ${shown ? STRIP_CLS[shown.status] : 'bg-bambu-dark-tertiary'}`} />
        <div className="relative">
          <div
            data-testid={`card-thumb-${item.id}`}
            className={`flex aspect-square items-center justify-center overflow-hidden bg-bambu-dark transition-opacity duration-200 ease-[var(--ease-signature)] ${older ? 'opacity-40' : ''}`}
          >
            {display?.has_thumbnail ? (
              <img src={api.getLibraryFileThumbnailUrl(display.id)} loading="lazy" alt=""
                className="h-full w-full object-cover brightness-125 contrast-110" />
            ) : (
              <Box className="h-12 w-12 text-bambu-gray/30" aria-hidden />
            )}
          </div>
          {display && (
            <span className={`absolute right-2 top-2 rounded px-1.5 py-0.5 text-xs font-medium ${badgeCls(display.file_type.toLowerCase())}`}>
              {display.file_type.toUpperCase()}
            </span>
          )}
          {outdated && (
            <span title={t('projectsPdm.files.outdated', outdated)}
              className="absolute left-2 top-2 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-black">
              {t('projectsPdm.files.outdatedBadge')}
            </span>
          )}
          {older && (
            <span className="absolute inset-x-0 bottom-0 animate-fade-in bg-black/70 py-1 text-center text-[11px] text-bambu-gray-light">
              {t('projectsPdm.files.olderRevision')}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5">
          {revisions.map((r) => {
            const current = r === shown;
            return (
              <button key={r.id} type="button" aria-pressed={current} title={`${revisionNumberLabel(r.number)} · ${t(STATUS_LABEL_KEYS[r.status])}`}
                onClick={() => setPickedId(r.id)}
                className={`${chipBtn} ${current ? 'border-bambu-green bg-bambu-green/15 text-white' : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white'}`}>
                {revisionNumberLabel(r.number)}
              </button>
            );
          })}
          <button type="button" aria-label={t('projectsPdm.files.newRevision')} title={t('projectsPdm.files.newRevision')}
            disabled={!canUpdate || busy} onClick={() => input.current?.click()}
            className={`${chipBtn} border-dashed border-bambu-dark-tertiary text-bambu-gray hover:border-bambu-green hover:text-bambu-green disabled:opacity-40 disabled:hover:border-bambu-dark-tertiary disabled:hover:text-bambu-gray`}>
            <Plus className="h-4 w-4" />
          </button>
          {shown && (
            <span className={`${chipBase} ml-auto text-[11px] ${STATUS_CHIP_CLS[shown.status]}`}>{t(STATUS_LABEL_KEYS[shown.status])}</span>
          )}
        </div>

        <div className="flex-1 px-3 pb-3 pt-1.5 text-xs text-bambu-gray">
          {renaming !== null && !open ? (
            renameField
          ) : (
            <button type="button" aria-expanded={open} onClick={toggleDetails} title={item.name}
              className={`block min-h-[44px] w-full truncate rounded text-left text-sm font-medium text-white md:min-h-0 ${focusRingCls}`}>
              {item.name}
            </button>
          )}
          {shown && (
            <>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                {display && <span>{formatFileSize(display.file_size)}</span>}
                {timed?.print_time_seconds ? (
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" aria-hidden />{formatDuration(timed.print_time_seconds)}</span>
                ) : null}
                {timed?.filament_used_grams ? (
                  <span className="flex items-center gap-1"><Package className="h-3 w-3" aria-hidden />{`${timed.filament_used_grams.toFixed(1)} g`}</span>
                ) : null}
              </div>
              {profileLine && (
                <div className="mt-1 flex min-w-0 items-center gap-1">
                  <Printer className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate" title={profileLine}>{profileLine}</span>
                </div>
              )}
              <SliceLine key={`${shown.id}-${slice.state}`} state={slice.state} percent={slice.percent} error={slice.error} printCount={shown.print_count}
                changed={slice.state !== firstSlice.current.get(shown.id)}
                onRetry={canUpdate && source ? () => void actions.sliceRevision(shown.id) : undefined} />
              <div className="mt-1 text-[11px]">
                {[shown.created_by ? t('projectsPdm.files.byAuthor', { name: shown.created_by }) : null,
                  new Date(shown.created_at).toLocaleDateString(i18n.language)].filter(Boolean).join(' · ')}
              </div>
            </>
          )}
          {busy && <p role="status" className="mt-1 text-bambu-green">{t('projectsPdm.files.uploading')}</p>}
        </div>

        <div className="flex flex-nowrap items-center gap-0.5 border-t border-bambu-dark-tertiary px-1.5 py-1">
          {canPrint && printFile &&
            icon(t('projectsPdm.print.print'), <Printer className="h-4 w-4" />, () => setPrinting(printFile), sliced ? 'text-bambu-green' : '')}
          {canHandoff && source &&
            icon(t('projectsPdm.slice.openInSlicer'), <ExternalLink className="h-4 w-4" />, () => void actions.openInSlicer(source))}
          {display && isPreviewable(display) && icon(t('projectsPdm.files.preview'), <Eye className="h-4 w-4" />, () => setPreview(display))}
          {shown && display &&
            icon(t('projectsPdm.files.download'), <Download className="h-4 w-4" />, () => void actions.download(shown.id, display.id, display.filename))}
          <button ref={moreRef} type="button" title={t('aito.moreActions')} aria-label={t('aito.moreActions')}
            aria-haspopup="menu" aria-expanded={menu !== null} className={actionBtn}
            onClick={(e) => {
              if (menu) return setMenu(null);
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right, y: rect.bottom });
            }}>
            <MoreVertical className="h-4 w-4" />
          </button>
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

      {open && (
        <ItemDetailsTray
          item={item}
          revision={shown}
          actions={actions}
          dropHandlers={dropHandlers}
          renameField={renameField || null}
          onRename={startRename}
          onClose={toggleDetails}
          fork={fork}
        />
      )}

      {menu && createPortal(
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} anchorRef={moreRef} />,
        document.body,
      )}
      {preview && (
        <DropShield>
          <ModelViewerModal libraryFileId={preview.id} title={preview.filename} fileType={preview.file_type}
            onClose={() => setPreview(null)} />
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
    </>
  );
}

// `changed`: the state moved since the card mounted, so the new line fades in (and a
// fresh "Sliced" gives its check one press). A page load never animates.
function SliceLine({ state, percent, error, printCount, onRetry, changed }: {
  changed: boolean;
  state: RevisionSliceState;
  percent: number | null;
  error: string | null;
  printCount: number;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const enter = changed ? 'animate-fade-in' : '';
  if (state === 'slicing') {
    return (
      <div className={`mt-2 ${enter}`}>
        <div className="mb-1 flex justify-between text-[11px] text-bambu-green">
          <span>{t('slice.slicing')}</span>
          {percent !== null && <span>{`${percent}%`}</span>}
        </div>
        <div role="progressbar" aria-label={t('slice.slicing')} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={percent ?? undefined} className="h-1 overflow-hidden rounded bg-bambu-dark-tertiary">
          <div className={`h-full bg-bambu-green ${percent === null ? 'w-1/3 animate-pulse' : 'w-full origin-left transition-transform duration-300 ease-[var(--ease-signature)]'}`}
            style={percent !== null ? { transform: `scaleX(${percent / 100})` } : undefined} />
        </div>
      </div>
    );
  }
  if (state === 'failed') {
    return (
      <div className={`mt-1 flex flex-wrap items-center gap-x-2 text-red-400 ${enter}`}>
        <span className="flex min-w-0 items-center gap-1 break-words">
          <AlertCircle className="h-3 w-3 shrink-0" aria-hidden />
          {error ? t('projectsPdm.slice.failed', { detail: error }) : t('queue.status.slice_failed')}
        </span>
        {onRetry && (
          <button type="button" onClick={onRetry}
            className={`inline-flex min-h-[44px] items-center gap-1 rounded underline md:min-h-0 ${focusRingCls}`}>
            <RotateCw className="h-3 w-3" aria-hidden />{t('common.retry')}
          </button>
        )}
      </div>
    );
  }
  if (state === 'none') {
    return (
      <div className={`mt-1 flex items-center gap-1 text-amber-400 ${enter}`}>
        <AlertCircle className="h-3 w-3" aria-hidden />{t('projectsPdm.files.notSliced')}
      </div>
    );
  }
  return (
    <div className={`mt-1 flex items-center gap-1 text-bambu-green ${enter}`}>
      <CheckCircle2 className={`h-3 w-3 ${changed ? 'animate-slice-done' : ''}`} aria-hidden />
      <span>{t('projectsPdm.files.sliced')}</span>
      {printCount > 0 && <span>{`· ${t('projectsPdm.print.printCount', { count: printCount })}`}</span>}
    </div>
  );
}
