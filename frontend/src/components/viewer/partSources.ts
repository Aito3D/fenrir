import { api } from '../../api/client';
import type { ProjectFileOut, ProjectItemOut, ProjectRevisionOut } from '../../api/client';
import type { PrintFileFacts } from '../PrintFacts';
import { isSourceFilename } from '../projects/files/filesUi';

/** What the part viewer is asked to show: a library file, an archive, or a project revision
 *  (its source `.3mf` for the Model tab and its sliced file for the Toolpath tab). */
export type PartSubject =
  | { kind: 'library'; fileId: number; fileType: string; filename: string; nozzleDiameter?: number | null; photos?: string[] | null }
  | { kind: 'archive'; archiveId: number; filename: string; nozzleDiameter?: number | null; photos?: string[] | null }
  | { kind: 'revision'; projectId: number; item: ProjectItemOut; revision: ProjectRevisionOut; code?: string | null };

export interface ModelSource {
  url: string;
  fileType: string;
}
export interface ToolpathSource {
  /** `plate` is appended by the viewer when a plate is picked. */
  url: string;
}
export interface FileEntry {
  id: number;
  filename: string;
  size: number | null;
  role: 'source' | 'sliced' | 'file';
}

export interface PartSources {
  model: ModelSource | null;
  toolpath: ToolpathSource | null;
  /** Where the plates come from: the library file id, or the archive. */
  plates: { kind: 'library'; fileId: number } | { kind: 'archive'; archiveId: number } | null;
  /** Facts of the sliced file (time, grams, layers…); null without one. */
  facts: PrintFileFacts | null;
  /** Printer names to size the bed with, most specific first. */
  printerHints: Array<string | null | undefined>;
  files: FileEntry[];
}

const THREE_MF = new Set(['3mf', 'gcode.3mf']);
const MESH_TYPES = new Set(['3mf', 'gcode.3mf', 'stl', 'step', 'stp']);
const TOOLPATH_TYPES = new Set(['gcode', 'gcode.3mf']);

const normalise = (fileType: string | null | undefined, filename: string): string => {
  const t = (fileType || '').toLowerCase();
  if (t) return t;
  const lower = filename.toLowerCase();
  if (lower.endsWith('.gcode.3mf')) return 'gcode.3mf';
  return lower.split('.').pop() ?? '';
};

/** A library file: the mesh for the 3MF family, STL and STEP; the toolpath for G-code and
 *  the sliced `.gcode.3mf` (which carries both, the bug this viewer fixes). */
function libraryFile(fileId: number, fileType: string, filename: string, size: number | null, role: FileEntry['role']): PartSources {
  const type = normalise(fileType, filename);
  return {
    model: MESH_TYPES.has(type) ? { url: api.getLibraryFileDownloadUrl(fileId), fileType: type === 'gcode.3mf' ? '3mf' : type } : null,
    toolpath: TOOLPATH_TYPES.has(type) ? { url: api.getLibraryFileGcodeUrl(fileId) } : null,
    plates: THREE_MF.has(type) ? { kind: 'library', fileId } : null,
    facts: null,
    printerHints: [],
    files: [{ id: fileId, filename, size, role }],
  };
}

export function sourcesForLibrary(subject: Extract<PartSubject, { kind: 'library' }>): PartSources {
  return libraryFile(subject.fileId, subject.fileType, subject.filename, null, 'file');
}

/** An archive: decided by its capabilities (fetched by the viewer), so this only names URLs. */
export function sourcesForArchive(
  subject: Extract<PartSubject, { kind: 'archive' }>,
  caps: { has_model: boolean; has_gcode: boolean; has_source: boolean },
): PartSources {
  return {
    model: caps.has_model ? { url: caps.has_source ? api.getSource3mfDownloadUrl(subject.archiveId) : api.getArchiveDownload(subject.archiveId), fileType: '3mf' } : null,
    toolpath: caps.has_gcode ? { url: api.getArchiveGcode(subject.archiveId) } : null,
    plates: { kind: 'archive', archiveId: subject.archiveId },
    facts: null,
    printerHints: [],
    files: [{ id: subject.archiveId, filename: subject.filename, size: null, role: 'file' }],
  };
}

const factsOf = (f: ProjectFileOut | null | undefined): PrintFileFacts | null =>
  f && (f.print_time_seconds || f.filament_used_grams)
    ? {
        print_time_seconds: f.print_time_seconds ?? null,
        filament_used_grams: f.filament_used_grams ?? null,
        filament_type: f.filament_type ?? null,
        filament_color: f.filament_color ?? null,
        filament_vendor: f.filament_vendor ?? null,
        sliced_for_model: f.sliced_for_model ?? null,
        total_layers: f.total_layers ?? null,
        layer_height: f.layer_height ?? null,
        nozzle_diameter: f.nozzle_diameter ?? null,
        object_count: f.object_count ?? null,
      }
    : null;

/** A project revision: the source `.3mf` is the model, the server's sliced file is the toolpath.
 *  Without a source (a revision uploaded already sliced) the sliced file gives both. */
export function sourcesForRevision(subject: Extract<PartSubject, { kind: 'revision' }>): PartSources {
  const { revision } = subject;
  const source = revision.files.find((f) => isSourceFilename(f.filename)) ?? null;
  const sliced = revision.sliced_file ?? revision.files.find((f) => normalise(f.file_type, f.filename) === 'gcode.3mf') ?? null;
  const modelFile = source ?? sliced ?? revision.files[0] ?? null;
  const modelType = modelFile ? normalise(modelFile.file_type, modelFile.filename) : '';
  const files: FileEntry[] = [];
  if (source) files.push({ id: source.id, filename: source.filename, size: source.file_size, role: 'source' });
  if (sliced && sliced.id !== source?.id) files.push({ id: sliced.id, filename: sliced.filename, size: sliced.file_size, role: 'sliced' });
  if (!source && !sliced && modelFile) files.push({ id: modelFile.id, filename: modelFile.filename, size: modelFile.file_size, role: 'file' });
  const timed = sliced ?? (modelType === 'gcode.3mf' ? modelFile : null);
  return {
    model: modelFile && MESH_TYPES.has(modelType) ? { url: api.getLibraryFileDownloadUrl(modelFile.id), fileType: modelType === 'gcode.3mf' ? '3mf' : modelType } : null,
    toolpath: sliced ? { url: api.getLibraryFileGcodeUrl(sliced.id) } : modelFile && TOOLPATH_TYPES.has(modelType) ? { url: api.getLibraryFileGcodeUrl(modelFile.id) } : null,
    plates: sliced ? { kind: 'library', fileId: sliced.id } : modelFile && THREE_MF.has(modelType) ? { kind: 'library', fileId: modelFile.id } : null,
    facts: factsOf(timed),
    printerHints: [revision.print_profile?.printer_model as string | undefined, timed?.sliced_for_model],
    files,
  };
}

export function sourcesFor(subject: PartSubject, archiveCaps?: { has_model: boolean; has_gcode: boolean; has_source: boolean }): PartSources | null {
  if (subject.kind === 'library') return sourcesForLibrary(subject);
  if (subject.kind === 'revision') return sourcesForRevision(subject);
  return archiveCaps ? sourcesForArchive(subject, archiveCaps) : null;
}

/** The nozzle the file was sliced for: the revision's profile, the file's facts, the archive's
 *  own column, or the printer preset embedded in the 3MF ("Bambu Lab H2C 0.4 nozzle"). */
export function nozzleLabel(...sources: Array<unknown>): string | null {
  for (const src of sources) {
    if (src == null || src === '') continue;
    const n = typeof src === 'string' ? Number(src.match(/(\d+(?:\.\d+)?)\s*(?:mm\s*)?nozzle/i)?.[1] ?? src) : Number(src);
    if (Number.isFinite(n) && n > 0) return `${n} mm`;
  }
  return null;
}
