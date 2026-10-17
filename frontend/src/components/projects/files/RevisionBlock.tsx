import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Eye, GitFork, Printer, Scissors, Trash2, X } from 'lucide-react';
import { api } from '../../../api/client';
import type { ProjectFileOut, ProjectItemOut, ProjectRevisionOut, RevisionStatus } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { HoldButton } from '../../aito/HoldButton';
import { ModelViewerModal } from '../../ModelViewerModal';
import { inputCls, focusRingCls } from '../../formStyles';
import { formatFileSize } from '../../../utils/file';
import type { FileActions } from './useFileActions';
import {
  PREVIEWABLE_TYPES,
  RESLICE_UI_ENABLED,
  STATUS_CHIP_CLS,
  STATUS_LABEL_KEYS,
  isPrintableFile,
  isSectionEnabled,
  printProfileLine,
} from './filesUi';
import { PrintRevisionFlow } from '../print/PrintRevisionFlow';
import { ResliceDialog } from '../reslice/ResliceDialog';
import { outdatedParams, revisionNumberLabel } from './revisionLabel';
import { DropShield } from '../DropShield';
import { OutdatedChip } from './OutdatedChip';

export interface DerivedOption { id: number; label: string }

interface Props {
  item: ProjectItemOut;
  revision: ProjectRevisionOut;
  derivedOptions: DerivedOption[];
  actions: FileActions;
  /** Opens with the fork form already showing (the card's ⋯ "Fork as new item"). */
  initialForking?: boolean;
}

const btnCls = `inline-flex min-h-[44px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-bambu-gray-light hover:bg-bambu-dark-tertiary hover:text-white md:min-h-0 ${focusRingCls}`;

const isResliceable = (f: ProjectFileOut) => f.filename.toLowerCase().endsWith('.3mf'); // incl. .gcode.3mf, as the backend

export function RevisionBlock({ item, revision, derivedOptions, actions, initialForking = false }: Props) {
  const { t, i18n } = useTranslation();
  const { hasPermission } = useAuth();
  // Disabled section (printing files only for now): read-only except delete; print and download stay.
  const canUpdate = hasPermission('projects:update') && isSectionEnabled(item.section);
  const canDelete = hasPermission('projects:delete');
  const canPrint = hasPermission('queue:create'); // POST /queue/'s own gate
  // POST /projects/revisions/{id}/reslice's gates.
  const canReslice =
    hasPermission('projects:update') && hasPermission('library:upload') && hasPermission('pipelines:read') && isSectionEnabled(item.section);
  const [preview, setPreview] = useState<ProjectFileOut | null>(null);
  const [editingNote, setEditingNote] = useState(false);
  const [forking, setForking] = useState<string | null>(() =>
    initialForking ? `${item.name} (${revisionNumberLabel(revision.number)})` : null,
  );
  const [printing, setPrinting] = useState<ProjectFileOut | null>(null);
  const [reslicing, setReslicing] = useState<number | null>(null); // source file id
  const running = actions.reslice.runFor(item.id);
  const resliceRunning = running !== undefined && running.error === null;
  const resliceable = revision.files.filter(isResliceable);
  const label = revisionNumberLabel(revision.number);
  const editable = revision.status === 'wip' && !revision.used;
  const pp = revision.print_profile as Record<string, unknown> | null;
  const profileLine = printProfileLine(pp);
  const slicer = [revision.slicer_name, revision.slicer_version].filter(Boolean).join(' ');
  const newer = revision.outdated_by;
  const src = revision.derived_from;

  const submitFork = async () => {
    const name = (forking ?? '').trim();
    if (!name) return;
    setForking(null);
    await actions.fork(item.id, revision.id, name);
  };

  return (
    <div data-testid={`revision-${revision.id}`} className="space-y-2 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-mono text-sm font-semibold text-white">{label}</span>
        <select
          aria-label={t('projectsPdm.files.statusLabel')}
          value={revision.status}
          disabled={!canUpdate}
          onChange={(e) => actions.setStatus(revision.id, e.target.value as RevisionStatus)}
          className={`rounded-md border bg-bambu-dark py-1 pl-1.5 pr-6 text-xs ${STATUS_CHIP_CLS[revision.status]} ${focusRingCls}`}
        >
          {(Object.keys(STATUS_LABEL_KEYS) as RevisionStatus[]).map((s) => (
            <option key={s} value={s}>{t(STATUS_LABEL_KEYS[s])}</option>
          ))}
        </select>
        <span className="min-w-0 break-all text-xs text-bambu-gray">
          {[revision.created_by ? t('projectsPdm.files.byAuthor', { name: revision.created_by }) : null,
            new Date(revision.created_at).toLocaleDateString(i18n.language)].filter(Boolean).join(' · ')}
        </span>
        {revision.print_count > 0 && (
          <span className="text-xs text-bambu-gray-light">{t('projectsPdm.print.printCount', { count: revision.print_count })}</span>
        )}
      </div>

      {newer && src && (
        <OutdatedChip params={outdatedParams(src, newer)} wrapClassLast />
      )}

      {editingNote ? (
        <textarea
          autoFocus
          defaultValue={revision.note ?? ''}
          placeholder={t('projectsPdm.files.notePlaceholder')}
          aria-label={t('projectsPdm.files.noteLabel')}
          rows={2}
          className={inputCls}
          onBlur={(e) => {
            setEditingNote(false);
            const value = e.target.value.trim();
            if (value !== (revision.note ?? '')) actions.setNote(revision.id, value || null);
          }}
        />
      ) : (
        <button
          type="button"
          disabled={!canUpdate}
          onClick={() => setEditingNote(true)}
          className={`block w-full break-words rounded-md px-1 py-0.5 text-left text-sm ${revision.note ? 'text-bambu-gray-light' : 'text-bambu-gray'} ${focusRingCls}`}
        >
          {revision.note || t('projectsPdm.files.notePlaceholder')}
        </button>
      )}

      <label className="flex flex-wrap items-center gap-2 text-xs text-bambu-gray">
        {t('projectsPdm.files.derivedFromLabel')}
        <select
          value={revision.derived_from?.id ?? ''}
          disabled={!canUpdate}
          onChange={(e) => actions.setDerived(revision.id, e.target.value ? Number(e.target.value) : null)}
          className={`min-w-0 max-w-full rounded-md border border-bambu-dark-tertiary bg-bambu-dark py-1 text-xs text-white ${focusRingCls}`}
        >
          <option value="">{t('projectsPdm.files.derivedFromNone')}</option>
          {derivedOptions.filter((o) => o.id !== revision.id).map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      </label>

      {item.section === 'impression' && (profileLine || pp || revision.pipeline_name) && (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-bambu-gray">
          {profileLine && <span className="break-words">{profileLine}</span>}
          {pp && <span className={pp.sliced ? 'text-bambu-green' : 'text-amber-400'}>
            {pp.sliced ? t('projectsPdm.files.sliced') : t('projectsPdm.files.notSliced')}</span>}
          {slicer && <span>{slicer}</span>}
          {revision.pipeline_name && (
            <span>{t('projectsPdm.reslice.viaPipeline', { name: revision.pipeline_name })}</span>
          )}
        </p>
      )}

      {revision.used && <p className="text-xs text-bambu-gray">{t('projectsPdm.files.frozen')}</p>}

      <ul className="space-y-1.5">
        {revision.files.map((f) => {
          const ext = f.file_type.toLowerCase();
          const canPreview = PREVIEWABLE_TYPES.includes(ext) || PREVIEWABLE_TYPES.some((p) => f.filename.toLowerCase().endsWith(`.${p}`));
          return (
            <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {f.has_thumbnail ? (
                <img src={api.getLibraryFileThumbnailUrl(f.id)} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
              ) : (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-bambu-dark-tertiary text-[10px] font-semibold uppercase text-bambu-gray">
                  {ext.split('.').pop()}
                </span>
              )}
              <span className="min-w-0 flex-1 basis-40 break-all text-sm text-white">{f.filename}</span>
              <span className="text-xs text-bambu-gray">{formatFileSize(f.file_size)}</span>
              <span className="flex flex-wrap gap-1 [&>div]:flex">
                {canPrint && isPrintableFile(f.filename) && (
                  <button type="button" className={btnCls} aria-label={t('projectsPdm.print.printFile', { name: f.filename })}
                    onClick={() => setPrinting(f)}>
                    <Printer className="h-3.5 w-3.5" />{t('projectsPdm.print.print')}
                  </button>
                )}
                {RESLICE_UI_ENABLED && canReslice && isResliceable(f) && (
                  <button type="button" className={`${btnCls} disabled:opacity-40`} disabled={resliceRunning}
                    onClick={() => setReslicing(f.id)}>
                    <Scissors className="h-3.5 w-3.5" />{t('projectsPdm.reslice.action')}
                  </button>
                )}
                {canPreview && (
                  <button type="button" className={btnCls} onClick={() => setPreview(f)}>
                    <Eye className="h-3.5 w-3.5" />{t('projectsPdm.files.preview')}
                  </button>
                )}
                <button type="button" className={btnCls} onClick={() => actions.download(revision.id, f.id, f.filename)}>
                  <Download className="h-3.5 w-3.5" />{t('projectsPdm.files.download')}
                </button>
                {canUpdate && editable && revision.files.length > 1 && (
                  <HoldButton
                    onHold={() => void actions.removeFile(revision.id, f.id)}
                    durationMs={1000}
                    label={t('projectsPdm.files.removeFile', { name: f.filename })}
                    hint={t('aito.holdToDelete')}
                    progress="perimeter"
                    className="min-h-[44px] px-2 py-1 text-bambu-gray-light hover:bg-red-400/10 hover:text-red-400 focus-visible:ring-red-400/40 data-[holding=true]:text-red-400 md:min-h-0"
                  >
                    <X className="relative h-3.5 w-3.5" />
                  </HoldButton>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap gap-1 [&>div]:flex">
        <button type="button" className={btnCls} onClick={() => actions.download(revision.id)}>
          <Download className="h-3.5 w-3.5" />{t('projectsPdm.files.downloadAll')}
        </button>
        {canUpdate && (
          <button type="button" className={btnCls} onClick={() => setForking(`${item.name} (${label})`)}>
            <GitFork className="h-3.5 w-3.5" />{t('projectsPdm.files.fork')}
          </button>
        )}
        {canDelete && !revision.used && (
          <HoldButton
            onHold={() => void actions.deleteRevision(revision.id)}
            durationMs={1000}
            label={t('projectsPdm.files.deleteRevision')}
            hint={t('aito.holdToDelete')}
            progress="bar"
            className="min-h-[44px] gap-1 px-2 py-1 text-xs text-red-400 hover:bg-red-400/10 focus-visible:ring-red-400/40 md:min-h-0"
          >
            <Trash2 className="relative h-3.5 w-3.5" /><span className="relative">{t('projectsPdm.files.deleteRevision')}</span>
          </HoldButton>
        )}
      </div>

      {forking !== null && (
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void submitFork(); }}>
          <input autoFocus value={forking} onChange={(e) => setForking(e.target.value)}
            aria-label={t('projectsPdm.files.forkNameLabel')} className={`${inputCls} min-w-0 flex-1 basis-48`}
            onKeyDown={(e) => e.key === 'Escape' && setForking(null)} />
          <button type="submit" className={`${btnCls} bg-bambu-green text-white`}>{t('projectsPdm.files.fork')}</button>
        </form>
      )}

      {preview && (
        <ModelViewerModal libraryFileId={preview.id} title={preview.filename} fileType={preview.file_type}
          onClose={() => setPreview(null)} />
      )}
      {printing && (
        <PrintRevisionFlow
          projectId={actions.projectId}
          file={printing}
          revisionWarning={newer && src
            ? t('projectsPdm.print.outdatedWarning', outdatedParams(src, newer))
            : undefined}
          onClose={() => setPrinting(null)}
        />
      )}
      {RESLICE_UI_ENABLED && reslicing !== null && (
        <DropShield>
          <ResliceDialog
            projectId={actions.projectId}
            files={resliceable}
            initialFileId={reslicing}
            onClose={() => setReslicing(null)}
            onStart={(fileId, pipelineId, queueTaskId) => {
              setReslicing(null);
              void actions.reslice.start(item.id, revision.id, fileId, pipelineId, queueTaskId);
            }}
          />
        </DropShield>
      )}
    </div>
  );
}
