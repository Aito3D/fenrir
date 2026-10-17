import type {
  ProjectFileOut,
  ProjectItemOut,
  ProjectRevisionOut,
  ProjectSection,
  ProjectTreeResponse,
  RevisionRef,
  RevisionStatus,
} from '../../api/client';

/**
 * Project-tree test data (GET /projects/{id}/tree), typed against the client
 * types so a new field is added here once. Each factory applies its overrides
 * verbatim; a suite whose data differs from these defaults passes the
 * difference at its call site (or in a thin local wrapper).
 */

/** The five sections, in the order the tree route returns them. */
export const PROJECT_SECTIONS: ProjectSection[] = ['scan', 'modelisation', 'impression', 'usinage', 'docs'];

/** A revision file: `file_type` defaults to the last extension, 2 KiB, hash `h<id>`, no thumbnail. */
export function file(id: number, filename: string, overrides: Partial<ProjectFileOut> = {}): ProjectFileOut {
  return {
    id,
    filename,
    file_type: filename.split('.').pop() ?? '',
    file_size: 2048,
    file_hash: `h${id}`,
    has_thumbnail: false,
    created_at: '2026-10-04T10:00:00Z',
    ...overrides,
  };
}

/** R1 of nothing in particular: wip, no lineage, no profile, no files, by paul. */
export function rev(overrides: Partial<ProjectRevisionOut> = {}): ProjectRevisionOut {
  return {
    id: 1,
    number: 1,
    status: 'wip',
    note: null,
    derived_from: null,
    outdated_by: null,
    print_profile: null,
    slicer_name: null,
    slicer_version: null,
    has_snapshot: false,
    used: false,
    print_count: 0,
    pipeline_name: null,
    files: [],
    created_by: 'paul',
    created_at: '2026-10-04T10:00:00Z',
    status_changed_at: null,
    slice_status: null,
    slice_error: null,
    slice_job_id: null,
    sliced_file: null,
    ...overrides,
  };
}

/** An item; `name_key` is the lowercased name. */
export function item(
  id: number,
  section: ProjectSection,
  name: string,
  revisions: ProjectRevisionOut[],
  overrides: Partial<ProjectItemOut> = {},
): ProjectItemOut {
  return { id, section, name, name_key: name.toLowerCase(), forked_from: null, revisions, ...overrides };
}

/** A revision reference (derived_from / outdated_by); `item_id` is `id * 10`. */
export function ref(
  id: number,
  item_name: string,
  section: ProjectSection,
  number: number,
  status: RevisionStatus = 'valide',
): RevisionRef {
  return { id, item_id: id * 10, item_name, section, number, status };
}

/** The tree of project 7 (P-0007): every section, empty unless given. */
export function projectTree(
  items: Partial<Record<ProjectSection, ProjectItemOut[]>> = {},
  { project_id = 7, code = 'P-0007' }: { project_id?: number; code?: string | null } = {},
): ProjectTreeResponse {
  return {
    project_id,
    code,
    sections: PROJECT_SECTIONS.map((section) => ({ section, items: items[section] ?? [] })),
  };
}
