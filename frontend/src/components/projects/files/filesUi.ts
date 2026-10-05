import type { ProjectSection, RevisionStatus } from '../../../api/client';

export const SECTION_ORDER: ProjectSection[] = ['scan', 'modelisation', 'impression', 'usinage', 'docs'];

/** Projects hold printing files only for now (2026-10-05): the other sections stay in the data
 *  model and their existing items stay listed (read-only, under "Older files"), but take nothing
 *  new. Mirror of `ENABLED_SECTIONS` / `PRINTABLE_EXTENSIONS` in backend `services/project_storage.py`:
 *  re-enabling a section is a one-line change on each side. */
export const ENABLED_SECTIONS: readonly ProjectSection[] = ['impression'];
export const PRINTABLE_EXTENSIONS = ['.3mf', '.gcode', '.bgcode'] as const; // `.gcode.3mf` ends in `.3mf`
/** `accept` for every project upload / drop input. */
export const PRINTABLE_ACCEPT = PRINTABLE_EXTENSIONS.join(',');

export function isSectionEnabled(section: ProjectSection): boolean {
  return ENABLED_SECTIONS.includes(section);
}

/** A file a project accepts today: `.3mf` (incl. `.gcode.3mf`), `.gcode` or `.bgcode`, any case. */
export function isPrintableFilename(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return PRINTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The files a project would refuse (empty = all accepted). */
export function nonPrintableFiles(files: readonly File[]): File[] {
  return files.filter((f) => !isPrintableFilename(f.name));
}

export const SECTION_LABEL_KEYS: Record<ProjectSection, string> = {
  scan: 'projectsPdm.files.sectionScan',
  modelisation: 'projectsPdm.files.sectionModelisation',
  impression: 'projectsPdm.files.sectionImpression',
  usinage: 'projectsPdm.files.sectionUsinage',
  docs: 'projectsPdm.files.sectionDocs',
};

export const STATUS_LABEL_KEYS: Record<RevisionStatus, string> = {
  wip: 'projectsPdm.files.statusWip',
  valide: 'projectsPdm.files.statusValide',
  obsolete: 'projectsPdm.files.statusObsolete',
};

export const STATUS_CHIP_CLS: Record<RevisionStatus, string> = {
  wip: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  valide: 'border-bambu-green/40 bg-bambu-green/10 text-bambu-green',
  obsolete: 'border-bambu-dark-tertiary bg-bambu-dark text-bambu-gray',
};

export const PREVIEWABLE_TYPES = ['stl', '3mf', 'gcode.3mf', 'step', 'stp'];

export const chipBase = 'inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium';

/** Files the print queue can take straight from a revision (.3mf, .gcode.3mf, .gcode). */
export function isPrintableFile(filename: string): boolean {
  const name = filename.toLowerCase();
  return name.endsWith('.3mf') || name.endsWith('.gcode');
}

/** One-line print profile summary: `X1C · 0.4 mm · 0.2 mm · PETG` ('' = none). */
export function printProfileLine(profile: Record<string, unknown> | null): string {
  if (!profile) return '';
  return [
    profile.printer_model,
    profile.nozzle_diameter ? `${profile.nozzle_diameter} mm` : null,
    profile.layer_height ? `${profile.layer_height} mm` : null,
    Array.isArray(profile.filament_types) ? profile.filament_types.join(', ') : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
