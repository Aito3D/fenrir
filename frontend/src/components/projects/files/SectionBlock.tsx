import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import type { ProjectItemOut, ProjectSection } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { inputCls, focusRingCls } from '../../formStyles';
import { CollapsibleHeader } from './CollapsibleHeader';
import { ItemRow } from './ItemRow';
import type { DerivedOption } from './RevisionBlock';
import type { FileActions } from './useFileActions';
import { itemNameFromFile, itemNameKey } from './fileDrop';
import { useFileDropZone } from './useFileDropZone';
import { PRINTABLE_ACCEPT, SECTION_LABEL_KEYS } from './filesUi';

interface Props {
  section: ProjectSection;
  items: ProjectItemOut[];
  derivedOptions: DerivedOption[];
  actions: FileActions;
}

export function SectionBlock({ section, items, derivedOptions, actions }: Props) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const canUpdate = hasPermission('projects:update');
  const [open, setOpen] = useState(items.length > 0);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  // Item created by this form whose first upload failed: a retry only re-uploads.
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);

  const onDropFiles = async (dropped: File[]) => {
    if (!actions.acceptsFiles(dropped)) return;
    setOpen(true);
    const itemName = itemNameFromFile(dropped[0].name);
    const key = itemNameKey(itemName);
    const existing = items.find((i) => i.name_key === key);
    if (existing) {
      if (actions.isBusy(existing.id)) showToast(t('projectsPdm.files.itemBusy', { name: existing.name }), 'error');
      else await actions.uploadRevision(existing.id, dropped);
      return;
    }
    const id = await actions.createItem(section, itemName);
    if (id !== undefined) await actions.uploadRevision(id, dropped);
  };
  const { dragOver, ...dropHandlers } = useFileDropZone({ canDrop: canUpdate, onFiles: onDropFiles });

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
      {...dropHandlers}
    >
      <div className="flex flex-wrap items-center gap-2 p-2">
        <h3 className="min-w-0 flex-1 basis-32 text-sm font-semibold text-white">
          <CollapsibleHeader open={open} onToggle={() => setOpen((o) => !o)} label={t(SECTION_LABEL_KEYS[section])} count={items.length} />
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
              <input ref={chooser} type="file" multiple accept={PRINTABLE_ACCEPT} className="hidden" data-testid={`new-item-files-${section}`}
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  if (!actions.acceptsFiles(picked)) {
                    e.target.value = '';
                    return;
                  }
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
