import { api } from '../../api/client';
import { openInSlicer, type SlicerType } from '../../utils/slicer';

/**
 * Check if an archive represents a sliced/printable file.
 * Uses filename (.gcode, .gcode.3mf) as primary check, then falls back to
 * metadata — a .3mf with total_layers or print_time is sliced (contains gcode),
 * while a raw source .3mf (CAD export) has neither.
 */
export function isSlicedFile(archive: { filename?: string | null; total_layers?: number | null; print_time_seconds?: number | null }): boolean {
  const filename = archive.filename;
  if (filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.gcode') || lower.includes('.gcode.')) return true;
  }
  // .3mf can be either sliced or source — check for gcode metadata
  if (archive.total_layers || archive.print_time_seconds) return true;
  return false;
}

/**
 * Open an archive file in the slicer.
 * Fetches a short-lived download token, then builds a token-authenticated URL
 * that bypasses auth middleware (slicer protocol handlers can't send auth headers).
 */
export async function openInSlicerWithToken(
  archiveId: number,
  filename: string,
  resourceType: 'file' | 'source',
  slicer: SlicerType,
): Promise<void> {
  try {
    if (resourceType === 'source') {
      const { token } = await api.createSourceSlicerToken(archiveId);
      const path = api.getSourceSlicerDownloadUrl(archiveId, token, filename);
      openInSlicer(`${window.location.origin}${path}`, slicer);
    } else {
      const { token } = await api.createArchiveSlicerToken(archiveId);
      const path = api.getArchiveSlicerDownloadUrl(archiveId, token, filename);
      openInSlicer(`${window.location.origin}${path}`, slicer);
    }
  } catch {
    // Fallback to direct URL (works when auth is disabled)
    const path = resourceType === 'source'
      ? api.getSource3mfForSlicer(archiveId, filename)
      : api.getArchiveForSlicer(archiveId, filename);
    openInSlicer(`${window.location.origin}${path}`, slicer);
  }
}
