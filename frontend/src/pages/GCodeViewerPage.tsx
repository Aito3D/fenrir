import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../api/client';
import { PartViewerModal } from '../components/viewer/LazyPartViewerModal';
import type { PartSubject } from '../components/viewer/partSources';

/**
 * `/gcode-viewer?archive=|library_file=[&plate=]`: the part viewer the archives, the File
 * Manager and the projects open, here as a page so old links and bookmarks keep working.
 * It opens on the Toolpath tab and on the plate from the link; closing goes back.
 */
export function GCodeViewerPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();

  // A missing or non-numeric id is "no file given", same as before.
  const archiveId = Number(searchParams.get('archive')) || null;
  const libraryFileId = archiveId ? null : Number(searchParams.get('library_file')) || null;
  const plate = Number(searchParams.get('plate')) || null;

  // The viewer's subject needs the file's name and type, which the URL does not carry.
  const subjectQuery = useQuery({
    queryKey: ['gcode-viewer-subject', archiveId, libraryFileId],
    queryFn: async (): Promise<{ subject: PartSubject; title: string }> => {
      if (archiveId) {
        const a = await api.getArchive(archiveId);
        return {
          subject: { kind: 'archive', archiveId: a.id, filename: a.filename, nozzleDiameter: a.nozzle_diameter, photos: a.photos },
          title: a.print_name || a.filename,
        };
      }
      const f = await api.getLibraryFile(libraryFileId!);
      return {
        subject: { kind: 'library', fileId: f.id, fileType: f.file_type, filename: f.filename, nozzleDiameter: f.nozzle_diameter },
        title: f.print_name || f.filename,
      };
    },
    enabled: Boolean(archiveId || libraryFileId),
    retry: false,
  });

  const handleClose = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate(archiveId ? '/archives' : '/files');
  };

  const message = (text: string) => (
    <div className="flex min-h-[calc(100vh-64px)] lg:h-screen items-center justify-center text-sm text-bambu-gray">{text}</div>
  );

  if (!archiveId && !libraryFileId) return message(t('gcodeViewer.noSource', 'No file was given to preview.'));
  if (subjectQuery.isError) return message(t('gcodeViewer.loadFailed', 'Could not load the G-code for this file.'));
  if (!subjectQuery.data) {
    return (
      <div className="flex min-h-[calc(100vh-64px)] lg:h-screen items-center justify-center">
        <Loader2 className="w-7 h-7 text-bambu-green animate-spin" />
      </div>
    );
  }

  return (
    <PartViewerModal
      subject={subjectQuery.data.subject}
      title={subjectQuery.data.title}
      onClose={handleClose}
      initialTab="toolpath"
      initialPlate={plate}
    />
  );
}
