import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import type { ProjectItemOut, ProjectSection } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { inputCls, focusRingCls } from '../../formStyles';
import { ItemRow } from './ItemRow';
import type { DerivedOption } from './RevisionBlock';
import type { FileActions } from './useFileActions';
import { filesFromDataTransfer, itemNameFromFile, itemNameKey } from './fileDrop';
import { SECTION_LABEL_KEYS } from './filesUi';

interface Props {
  section: ProjectSection;
  items: ProjectItemOut[];
  derivedOptions: DerivedOption[];
  actions: FileActions;
}

export function SectionBlock({ section, items, derivedOptions, actions }: Props) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canUpdate = hasPermission('projects:update');
  const [open, setOpen] = useState(items.length > 0);
  const [dragOver, setDragOver] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  // Item created by this form whose first upload failed: a retry only re-uploads.
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!canUpdate) return;
    const dropped = filesFromDataTransfer(e.dataTransfer);
    if (!dropped.length) return;
    setOpen(true);
    const itemName = itemNameFromFile(dropped[0].name);
    const key = itemNameKey(itemName);
    const existing = items.find((i) => i.name_key === key);
    if (existing) {
      if (!actions.isBusy(existing.id)) await actions.uploadRevision(existing.id, dropped);
      return;
    }
    const id = await actions.createItem(section, itemName);
    if (id !== undefined) await actions.uploadRevision(id, dropped);
  };

  const closeForm = () => {
    setCreating(false);
    setName('');
    setFiles([]);
    setCreatedId(null);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || !files.length || submitting) return;
    setSubmitting(true);
    try {
      let id = createdId;
      if (id === null) {
        id = (await actions.createItem(section, trimmed)) ?? null;
        if (id === null) return;
        setCreatedId(id);
      }
      if (await actions.uploadRevision(id, files)) closeForm();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      className={`rounded-xl border bg-bambu-dark-secondary ${dragOver ? 'border-bambu-green' : 'border-bambu-dark-tertiary'}`}
      onDragOver={(e) => { e.preventDefault(); if (canUpdate) setDragOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="flex flex-wrap items-center gap-2 p-2">
        <h3 className="min-w-0 flex-1 basis-32 text-sm font-semibold text-white">
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
            className={`flex min-h-[44px] w-full items-center gap-1.5 rounded-lg text-left md:min-h-0 ${focusRingCls}`}>
            {open ? <ChevronDown className="h-4 w-4 shrink-0 text-bambu-gray" /> : <ChevronRight className="h-4 w-4 shrink-0 text-bambu-gray" />}
            <span>{t(SECTION_LABEL_KEYS[section])}</span>{' '}
            <span className="text-xs font-normal text-bambu-gray">{items.length}</span>
          </button>
        </h3>
        {canUpdate && (
          <button type="button" onClick={() => { setOpen(true); if (creating) closeForm(); else setCreating(true); }}
            className={`inline-flex min-h-[44px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-bambu-green hover:bg-bambu-dark-tertiary md:min-h-0 ${focusRingCls}`}>
            <Plus className="h-3.5 w-3.5" />{t('projectsPdm.files.newItem')}
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-2 px-2 pb-2">
          {creating && (
            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={createdId !== null}
                aria-label={t('projectsPdm.files.itemNameLabel')} placeholder={t('projectsPdm.files.itemNameLabel')}
                className={`${inputCls} min-w-0 flex-1 basis-40`} />
              <button type="button" onClick={() => chooser.current?.click()}
                className={`min-h-[44px] rounded-lg bg-bambu-dark-tertiary px-3 py-1.5 text-xs text-white md:min-h-0 ${focusRingCls}`}>
                {files.length ? files.map((f) => f.name).join(', ') : t('projectsPdm.files.chooseFiles')}
              </button>
              <input ref={chooser} type="file" multiple className="hidden" data-testid={`new-item-files-${section}`}
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  setFiles(picked);
                  if (picked.length && !name.trim()) setName(itemNameFromFile(picked[0].name));
                }} />
              <button type="submit" disabled={!name.trim() || !files.length || submitting}
                className={`min-h-[44px] rounded-lg bg-bambu-green px-3 py-1.5 text-xs text-white disabled:opacity-50 md:min-h-0 ${focusRingCls}`}>
                {submitting ? t('projectsPdm.files.uploading') : t('projectsPdm.files.newItem')}
              </button>
            </form>
          )}
          {items.length === 0 && !creating && <p className="px-1 py-2 text-xs text-bambu-gray">{t('projectsPdm.files.emptySection')}</p>}
          {items.length > 0 && (
            <ul className="space-y-2">
              {items.map((item) => <ItemRow key={item.id} item={item} derivedOptions={derivedOptions} actions={actions} />)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
