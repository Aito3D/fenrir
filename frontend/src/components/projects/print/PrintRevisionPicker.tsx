import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Printer } from 'lucide-react';
import type { ProjectFileOut, ProjectItemOut, ProjectRevisionOut } from '../../../api/client';
import { Button } from '../../Button';
import { focusRingCls } from '../../formStyles';
import { useIsolatedEscape } from '../../../hooks/useIsolatedEscape';
import { STATUS_CHIP_CLS, STATUS_LABEL_KEYS, chipBase, isPrintableFile, printProfileLine } from '../files/filesUi';
import { OutdatedChip } from '../files/OutdatedChip';
import { outdatedParams, revisionLabel } from '../files/revisionLabel';
import { useProjectTree } from '../projectQueries';
import { DIALOG_CARD_CLS, OVERLAY_CLS } from '../dialogStyles';

interface Props {
  projectId: number;
  /** A printable file was picked; `revisionWarning` is the OUTDATED text for
   *  the print modal (spec §5.3), undefined when the revision is current. */
  onPick: (file: ProjectFileOut, revisionWarning: string | undefined) => void;
  onClose: () => void;
}

/** Which Impression file to print: every Impression revision of the project,
 *  newest first, with its status, print profile, OUTDATED text and printable
 *  files. Shares the project tree cache with the files panel. */
export function PrintRevisionPicker({ projectId, onPick, onClose }: Props) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Escape closes this picker only, never the Aito panel under it.
  useIsolatedEscape(onClose, dialogRef);
  const title = t('projectsPdm.print.pickPrintFile');

  const { data: tree, isPending, isError } = useProjectTree(projectId, { retry: false });

  const entries: { item: ProjectItemOut; revision: ProjectRevisionOut; files: ProjectFileOut[] }[] = (tree?.sections ?? [])
    .filter((s) => s.section === 'impression')
    .flatMap((s) => s.items)
    .flatMap((item) =>
      item.revisions.map((revision) => ({ item, revision, files: revision.files.filter((f) => isPrintableFile(f.filename)) })),
    )
    .filter((e) => e.files.length > 0)
    .sort((a, b) => b.revision.created_at.localeCompare(a.revision.created_at) || b.revision.number - a.revision.number);

  return createPortal(
    <div className={OVERLAY_CLS} onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={DIALOG_CARD_CLS}
      >
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {isPending ? (
            <p className="text-sm text-bambu-gray">{t('common.loading')}</p>
          ) : isError ? (
            <p role="alert" className="text-sm text-red-400">{t('common.errorLoading')}</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('projectsPdm.print.noPrintFiles')}</p>
          ) : (
            entries.map(({ item, revision, files }) => {
              const newer = revision.outdated_by;
              const src = revision.derived_from;
              const stale = newer && src ? outdatedParams(src, newer) : null;
              const profile = printProfileLine(revision.print_profile);
              return (
                <div
                  key={revision.id}
                  data-testid={`pick-revision-${revision.id}`}
                  className="space-y-1.5 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-white">{revisionLabel(item.name, revision.number)}</span>
                    <span className={`${chipBase} ${STATUS_CHIP_CLS[revision.status]}`}>{t(STATUS_LABEL_KEYS[revision.status])}</span>
                    {profile && <span className="text-xs text-bambu-gray">{profile}</span>}
                  </div>
                  {stale && (
                    <OutdatedChip params={stale} />
                  )}
                  <ul className="space-y-1">
                    {files.map((f) => (
                      <li key={f.id}>
                        <button
                          type="button"
                          aria-label={t('projectsPdm.print.printFile', { name: f.filename })}
                          onClick={() => onPick(f, stale ? t('projectsPdm.print.outdatedWarning', stale) : undefined)}
                          className={`flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-bambu-gray-light hover:bg-bambu-dark-tertiary hover:text-white md:min-h-0 ${focusRingCls}`}
                        >
                          <Printer aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0" />
                          <span className="min-w-0 break-all">{f.filename}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </div>
        <div className="flex justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
