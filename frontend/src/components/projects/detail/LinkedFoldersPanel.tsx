import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FileBox, FolderOpen, Loader2, Printer } from 'lucide-react';
import { api } from '../../../api/client';
import type { LibraryFileListItem, LibraryFolder } from '../../../api/client';
import { isSlicedLibraryFile } from '../../../utils/libraryFiles';
import { fileTypeBadgeTone } from '../files/fileTypeBadge';
import { ProjectPanel } from './ProjectPanel';

const BADGE_CLS: Record<ReturnType<typeof fileTypeBadgeTone>, string> = {
  source: 'bg-bambu-green/20 text-bambu-green',
  sliced: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400',
  other: 'bg-bambu-gray/20 text-bambu-gray',
};

/** Per-file print progress (#1897): a printed-count badge without a copies-per-file
 *  target, a done / target bar with one. */
function FileProgress({ done, target }: { done: number; target: number | null }) {
  const { t } = useTranslation();
  if (!target) {
    // No copies-per-file target — show a plain printed-count badge
    return done > 0 ? (
      <span
        className="shrink-0 text-xs px-1.5 py-0.5 rounded-full bg-bambu-dark text-bambu-gray"
        title={t('projectDetail.files.printedCount', { count: done })}
      >
        {done}×
      </span>
    ) : null;
  }
  const pct = Math.min((done / target) * 100, 100);
  const textColor = done >= target ? 'text-status-ok' : done > 0 ? 'text-status-warning' : 'text-bambu-gray';
  const barColor = done >= target ? 'bg-status-ok' : done > 0 ? 'bg-status-warning' : 'bg-bambu-gray';
  return (
    <div className="shrink-0 w-20" title={t('projectDetail.files.progressTooltip', { done, target })}>
      <p className={`text-xs font-medium text-right ${textColor}`}>
        {done} / {target}
      </p>
      <div className="h-1 bg-bambu-dark rounded-full overflow-hidden mt-1">
        <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Linked File Manager folders with their printable files: each folder links to
 *  the File Manager, each sliced file shows its progress and a Print button. */
export function LinkedFoldersPanel({
  folders,
  filesByFolder,
  filesLoading,
  progressByFileId,
  targetSets,
  onPrint,
}: {
  folders: LibraryFolder[];
  filesByFolder: Map<number, LibraryFileListItem[]>;
  filesLoading: boolean;
  progressByFileId: Map<number, number>;
  targetSets: number | null;
  onPrint: (file: LibraryFileListItem) => void;
}) {
  const { t } = useTranslation();
  return (
    <ProjectPanel
      icon={FolderOpen}
      title={t('projectDetail.details.linkedFolders')}
      count={folders.length}
      testId="project-linked-folders"
    >
      <p className="text-xs text-bambu-gray mb-3">
        <Link to="/files" className="text-bambu-green hover:underline">
          {t('projectDetail.files.linkFolders')}
        </Link>
        {' '}{t('projectDetail.files.forQuickAccess')}
      </p>
      <div className="space-y-4">
        {folders.map((folder) => {
          const files = filesByFolder.get(folder.id) ?? [];
          return (
            <div key={folder.id}>
              {/* Folder header — links to File Manager */}
              <Link
                to={`/files?folder=${folder.id}`}
                className="flex items-center justify-between p-3 bg-bambu-dark rounded-lg hover:bg-bambu-dark-tertiary transition-colors mb-2"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FolderOpen className="w-5 h-5 text-bambu-green shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{folder.name}</p>
                    <p className="text-xs text-bambu-gray">
                      {t('projectDetail.files.fileCount', { count: folder.file_count })}
                    </p>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-bambu-gray shrink-0" />
              </Link>

              {/* File list within the folder */}
              {filesLoading ? (
                <div className="flex items-center gap-2 px-3 py-2 text-bambu-gray text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                </div>
              ) : files.length === 0 ? (
                <p className="text-bambu-gray/60 text-xs italic px-3">
                  {t('projectDetail.files.noFiles')}
                </p>
              ) : (
                <div className="space-y-1 pl-3">
                  {files.map((file) => {
                    const printable = isSlicedLibraryFile(file);
                    return (
                      <div
                        key={file.id}
                        className="flex items-center gap-3 p-2 rounded-lg hover:bg-bambu-dark-tertiary transition-colors"
                      >
                        {/* Thumbnail */}
                        <div className="w-10 h-10 shrink-0 rounded bg-bambu-dark overflow-hidden flex items-center justify-center">
                          {file.thumbnail_path ? (
                            <img
                              src={api.getLibraryFileThumbnailUrl(file.id)}
                              alt={file.print_name || file.filename}
                              className="w-full h-full object-cover brightness-125 contrast-110"
                            />
                          ) : (
                            <FileBox className="w-5 h-5 text-bambu-gray/40" />
                          )}
                        </div>

                        {/* Name + type badge */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white truncate" title={file.print_name || file.filename}>
                            {file.print_name || file.filename}
                          </p>
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${BADGE_CLS[fileTypeBadgeTone(file.file_type)]}`}>
                            {file.file_type.toUpperCase()}
                          </span>
                        </div>

                        {/* Per-file print progress (#1897) */}
                        {printable && <FileProgress done={progressByFileId.get(file.id) ?? 0} target={targetSets} />}

                        {/* Print actions for sliced files */}
                        {printable && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => onPrint(file)}
                              title={t('common.print')}
                              className="flex min-h-[44px] min-w-[44px] items-center justify-center p-1.5 rounded hover:bg-bambu-green/20 text-bambu-green transition-colors md:min-h-0 md:min-w-0"
                            >
                              <Printer className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ProjectPanel>
  );
}
