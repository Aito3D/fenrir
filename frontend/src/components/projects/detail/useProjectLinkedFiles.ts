import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import type { LibraryFileListItem } from '../../../api/client';
import { projectKeys } from '../projectQueries';

/** The project's linked File Manager folders, their files and the per-file
 *  completed-run counts (#1897). The page reads them for the complete-sets
 *  target and the details rail, and hands them to the linked-folders panel. */
export function useProjectLinkedFiles(projectId: number) {
  const { data: linkedFolders } = useQuery({
    queryKey: projectKeys.linkedFolders(projectId),
    queryFn: () => api.getLibraryFoldersByProject(projectId),
    enabled: projectId > 0,
  });

  // Single bulk query — replaces the previous N+1 useQueries pattern
  const { data: allProjectFiles, isLoading: projectFilesLoading } = useQuery({
    queryKey: ['project-files', projectId],
    queryFn: () => api.getAllLibraryFiles(null, false, projectId),
    enabled: projectId > 0,
  });

  // Group files by folder_id for the section-based render
  const filesByFolder = useMemo(() => {
    const map = new Map<number, LibraryFileListItem[]>();
    for (const file of allProjectFiles ?? []) {
      if (file.folder_id != null) {
        const arr = map.get(file.folder_id) ?? [];
        arr.push(file);
        map.set(file.folder_id, arr);
      }
    }
    return map;
  }, [allProjectFiles]);

  // Per-file completed-run counts (#1897); a file absent from the response has 0
  const { data: fileProgress } = useQuery({
    queryKey: ['project-file-progress', projectId],
    queryFn: () => api.getProjectFileProgress(projectId),
    enabled: projectId > 0,
  });

  const progressByFileId = useMemo(() => {
    const map = new Map<number, number>();
    for (const row of fileProgress ?? []) map.set(row.file_id, row.completed_count);
    return map;
  }, [fileProgress]);

  return { linkedFolders, allProjectFiles, projectFilesLoading, filesByFolder, progressByFileId };
}
