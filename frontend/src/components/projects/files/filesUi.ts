import type { ProjectSection, RevisionStatus } from '../../../api/client';

export const SECTION_ORDER: ProjectSection[] = ['scan', 'modelisation', 'impression', 'usinage', 'docs'];

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
