import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Eye, GitFork, Plus, Printer, Trash2, X } from 'lucide-react';
import { api } from '../../../api/client';
import type { ProjectFileOut, ProjectItemOut, ProjectRevisionOut, RevisionStatus } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { ConfirmModal } from '../../ConfirmModal';
import { ModelViewerModal } from '../../ModelViewerModal';
import { inputCls, focusRingCls } from '../../formStyles';
import type { FileActions } from './useFileActions';
import { PREVIEWABLE_TYPES, STATUS_CHIP_CLS, STATUS_LABEL_KEYS, chipBase, isPrintableFile } from './filesUi';
import { PrintRevisionFlow } from '../print/PrintRevisionFlow';

export interface DerivedOption { id: number; label: string }

interface Props {
  item: ProjectItemOut;
  revision: ProjectRevisionOut;
  derivedOptions: DerivedOption[];
  actions: FileActions;
}

const btnCls = `inline-flex min-h-[44px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-bambu-gray-light hover:bg-bambu-dark-tertiary hover:text-white md:min-h-0 ${focusRingCls}`;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function RevisionBlock({ item, revision, derivedOptions, actions }: Props) {
  const { t, i18n } = useTranslation();
  const { hasPermission } = useAuth();
  const canUpdate = hasPermission('projects:update');
  const canDelete = hasPermission('projects:delete');
  const canPrint = hasPermission('queue:create'); // POST /queue/'s own gate
  const addInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ProjectFileOut | null>(null);
  const [editingNote, setEditingNote] = useState(false);
  const [forking, setForking] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<ProjectFileOut | null>(null);
  const [printing, setPrinting] = useState<ProjectFileOut | null>(null);
  const busy = actions.isBusy(item.id);
  const label = `R${revision.number}`;
  const editable = revision.status === 'wip' && !revision.used;
  const pp = revision.print_profile as Record<string, unknown> | null;
  const profileLine = pp
    ? [pp.printer_model, pp.nozzle_diameter ? `${pp.nozzle_diameter} mm` : null, pp.layer_height ? `${pp.layer_height} mm` : null,
        Array.isArray(pp.filament_types) ? pp.filament_types.join(', ') : null]
        .filter(Boolean).join(' · ')
    : '';
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
        <span className={`${chipBase} border-amber-500/40 bg-amber-500/10 text-amber-400 whitespace-normal`}>
          {t('projectsPdm.files.outdated', { source: `${src.item_name} R${src.number}`, newer: `R${newer.number}` })}
        </span>
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

      {item.section === 'impression' && (profileLine || pp) && (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-bambu-gray">
          {profileLine && <span className="break-words">{profileLine}</span>}
          {pp && <span className={pp.sliced ? 'text-bambu-green' : 'text-amber-400'}>
            {pp.sliced ? t('projectsPdm.files.sliced') : t('projectsPdm.files.notSliced')}</span>}
          {slicer && <span>{slicer}</span>}
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
              <span className="text-xs text-bambu-gray">{formatSize(f.file_size)}</span>
              <span className="flex flex-wrap gap-1">
                {canPrint && isPrintableFile(f.filename) && (
                  <button type="button" className={btnCls} aria-label={`${t('projectsPdm.print.print')} ${f.filename}`}
                    onClick={() => setPrinting(f)}>
                    <Printer className="h-3.5 w-3.5" />{t('projectsPdm.print.print')}
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
                  <button type="button" className={btnCls} aria-label={t('projectsPdm.files.removeFile', { name: f.filename })}
                    onClick={() => setConfirmRemove(f)}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap gap-1">
        <button type="button" className={btnCls} onClick={() => actions.download(revision.id)}>
          <Download className="h-3.5 w-3.5" />{t('projectsPdm.files.downloadAll')}
        </button>
        {canUpdate && editable && (
          <>
            <button type="button" className={`${btnCls} disabled:opacity-40`} disabled={busy} onClick={() => addInput.current?.click()}>
              <Plus className="h-3.5 w-3.5" />{t('projectsPdm.files.addFiles')}
            </button>
            <input ref={addInput} type="file" multiple className="hidden" data-testid={`add-files-input-${revision.id}`}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (files.length) actions.addFiles(item.id, revision.id, files);
              }} />
          </>
        )}
        {canUpdate && (
          <button type="button" className={btnCls} onClick={() => setForking(`${item.name} (${label})`)}>
            <GitFork className="h-3.5 w-3.5" />{t('projectsPdm.files.fork')}
          </button>
        )}
        {canDelete && !revision.used && (
          <button type="button" className={`${btnCls} text-red-400`} onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-3.5 w-3.5" />{t('projectsPdm.files.deleteRevision')}
          </button>
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
            ? t('projectsPdm.print.outdatedWarning', { source: `${src.item_name} R${src.number}`, newer: `R${newer.number}` })
            : undefined}
          onClose={() => setPrinting(null)}
        />
      )}
      {confirmRemove && (
        <ConfirmModal
          title={t('projectsPdm.files.removeFile', { name: confirmRemove.filename })}
          message={t('projectsPdm.files.confirmRemoveFile', { name: confirmRemove.filename, label: `${item.name} ${label}` })}
          confirmText={t('projectsPdm.files.remove')}
          variant="danger"
          onConfirm={() => { const fileId = confirmRemove.id; setConfirmRemove(null); void actions.removeFile(revision.id, fileId); }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmModal
          title={t('projectsPdm.files.deleteRevision')}
          message={t('projectsPdm.files.confirmDeleteRevision', { label: `${item.name} ${label}` })}
          confirmText={t('projectsPdm.files.deleteRevision')}
          variant="danger"
          onConfirm={() => { setConfirmDelete(false); void actions.deleteRevision(revision.id); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
