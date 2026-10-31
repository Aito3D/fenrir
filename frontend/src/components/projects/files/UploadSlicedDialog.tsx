import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, Upload } from 'lucide-react';
import { ApiError } from '../../../api/client';
import type { ProjectRevisionOut } from '../../../api/client';
import { Button } from '../../Button';
import { useToast } from '../../../contexts/ToastContext';
import { useIsolatedEscape } from '../../../hooks/useIsolatedEscape';
import { inputCls } from '../../formStyles';
import { DialogShell } from '../DialogShell';
import { stopDrag } from '../dialogStyles';
import { useDialogExit } from '../useDialogExit';
import type { FileActions } from './useFileActions';
import { SLICED_ACCEPT, isSlicedFilename, printProfileLine } from './filesUi';

interface Props {
  /** The revision whose server slice failed. */
  revision: ProjectRevisionOut;
  actions: FileActions;
  onClose: () => void;
}

/** One difference the server found between the file's settings and the revision's. */
interface Mismatch {
  field: string;
  file: string;
  revision: string;
}

const FIELD_LABEL_KEYS: Record<string, string> = {
  printer_model: 'projectsPdm.slice.fieldPrinter',
  nozzle_diameter: 'projectsPdm.slice.fieldNozzle',
  layer_height: 'projectsPdm.slice.fieldLayer',
  filament_types: 'projectsPdm.slice.fieldFilaments',
};

function mismatchesOf(error: unknown): Mismatch[] | null {
  if (!(error instanceof ApiError) || error.code !== 'settings_mismatch') return null;
  const list = error.detail?.mismatches;
  return Array.isArray(list) ? (list as Mismatch[]) : [];
}

/** The hand-slice fallback of a failed server slice (design 2026-10-30): the operator slices the
 *  same project in Bambu Studio and uploads the exported plate file (`.gcode.3mf`). The server
 *  checks it carries G-code and that its settings match the revision's; a refusal shows here. */
export function UploadSlicedDialog({ revision, actions, onClose }: Props) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const dialogRef = useRef<HTMLFormElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message?: string; mismatches?: Mismatch[] } | null>(null);
  const { closing, requestClose } = useDialogExit(onClose);
  useIsolatedEscape(() => { if (!busy) requestClose(); }, dialogRef);
  const title = t('projectsPdm.slice.uploadTitle');
  const profile = printProfileLine(revision.print_profile);

  const pick = (picked: File | null) => {
    setFile(picked);
    setError(picked && !isSlicedFilename(picked.name) ? { message: t('projectsPdm.slice.uploadNotSliced') } : null);
  };

  const submit = async () => {
    if (!file || busy) return;
    if (!isSlicedFilename(file.name)) {
      setError({ message: t('projectsPdm.slice.uploadNotSliced') });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await actions.uploadSlicedFile(revision.id, file);
      showToast(t('projectsPdm.slice.uploadDone'), 'success');
      requestClose();
    } catch (e) {
      const mismatches = mismatchesOf(e);
      if (mismatches) setError({ mismatches });
      else setError({ message: e instanceof Error && e.message ? e.message : t('projectsPdm.slice.uploadFailed') });
      setBusy(false);
    }
  };

  return (
    <DialogShell dialogRef={dialogRef} title={title} onClose={() => { if (!busy) requestClose(); }} closing={closing}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="space-y-4" onDragOver={stopDrag} onDrop={stopDrag}>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <p className="text-sm text-bambu-gray-light">{t('projectsPdm.slice.uploadHint')}</p>
        {profile && (
          <p className="text-sm text-bambu-gray-light">{t('projectsPdm.slice.uploadMustMatch', { profile })}</p>
        )}
        <label className="block space-y-1 text-sm text-bambu-gray-light">
          <span>{t('projectsPdm.slice.uploadChoose')}</span>
          <input type="file" accept={SLICED_ACCEPT} disabled={busy} className={`${inputCls} file:mr-3 file:border-0 file:bg-transparent file:text-bambu-gray-light`}
            onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        </label>
        {error && (
          <div role="alert" className="flex gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {error.mismatches ? (
              <div>
                <p>{t('projectsPdm.slice.mismatchTitle')}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {error.mismatches.map((m) => (
                    <li key={m.field}>
                      {t('projectsPdm.slice.mismatchRow', {
                        field: FIELD_LABEL_KEYS[m.field] ? t(FIELD_LABEL_KEYS[m.field]) : m.field,
                        file: m.file,
                        revision: m.revision,
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p>{error.message}</p>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={requestClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={!file || busy || !!error?.message}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
            {t('projectsPdm.slice.uploadSubmit')}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}
