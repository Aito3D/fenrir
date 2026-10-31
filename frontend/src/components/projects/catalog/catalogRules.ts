import type { ProjectCatalogItem, ProjectFolder } from '../../../api/client';

/** Pure rules of the Projects catalog (design 2026-10-31): quick filters, sort, the folder tree
 *  and search highlighting. No React, no API. */

export type CatalogChip = 'production' | 'ready' | 'nofile';
export type CatalogSort = 'activity' | 'code' | 'name' | 'printed';

export interface CatalogFilters {
  chips: ReadonlySet<CatalogChip>;
  materials: ReadonlySet<string>;
}

export const EMPTY_FILTERS: CatalogFilters = { chips: new Set(), materials: new Set() };

export const isInProduction = (item: ProjectCatalogItem): boolean => item.open_orders.length > 0;
export const isReady = (item: ProjectCatalogItem): boolean => item.recommended !== null;
export const hasNoFile = (item: ProjectCatalogItem): boolean => item.files_count === 0;

const upper = (s: string) => s.trim().toUpperCase();

/** The distinct materials of the loaded projects' recommended revisions, A→Z: the material chips. */
export function materialsOf(items: readonly ProjectCatalogItem[]): string[] {
  const out = new Set<string>();
  items.forEach((item) => item.recommended?.filament_types.forEach((t) => t.trim() && out.add(upper(t))));
  return [...out].sort((a, b) => a.localeCompare(b));
}

export function applyFilters(items: readonly ProjectCatalogItem[], f: CatalogFilters): ProjectCatalogItem[] {
  return items.filter((item) => {
    if (f.chips.has('production') && !isInProduction(item)) return false;
    if (f.chips.has('ready') && !isReady(item)) return false;
    if (f.chips.has('nofile') && !hasNoFile(item)) return false;
    if (f.materials.size > 0 && !(item.recommended?.filament_types ?? []).some((t) => f.materials.has(upper(t)))) return false;
    return true;
  });
}

export function sortItems(items: readonly ProjectCatalogItem[], sort: CatalogSort): ProjectCatalogItem[] {
  const copy = [...items];
  switch (sort) {
    case 'code':
      return copy.sort((a, b) => (a.code ?? '').localeCompare(b.code ?? '') || a.id - b.id);
    case 'name':
      return copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id);
    case 'printed':
      return copy.sort((a, b) => b.printed_count - a.printed_count || b.last_activity.localeCompare(a.last_activity));
    default:
      return copy.sort((a, b) => b.last_activity.localeCompare(a.last_activity) || b.id - a.id);
  }
}

/** A search term or a chip flattens the tree into a plain result list. */
export const isFiltering = (q: string, f: CatalogFilters): boolean =>
  q.trim() !== '' || f.chips.size > 0 || f.materials.size > 0;

export type TreeNode =
  | { kind: 'folder'; folder: ProjectFolder; depth: number; collapsed: boolean }
  | { kind: 'project'; item: ProjectCatalogItem; depth: number }
  | { kind: 'unfiled'; count: number };

const byName = (a: ProjectFolder, b: ProjectFolder) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id;

/** The browse list: folders A→Z at each level (sub-folders before projects), collapsed folders
 *  closed, then "Not in a folder" with the unfiled projects. Projects keep `items`' order. */
export function buildTree(
  folders: readonly ProjectFolder[],
  items: readonly ProjectCatalogItem[],
  collapsed: ReadonlySet<number>,
): TreeNode[] {
  const children = new Map<number | null, ProjectFolder[]>();
  folders.forEach((f) => children.set(f.parent_id, [...(children.get(f.parent_id) ?? []), f]));
  const known = new Set(folders.map((f) => f.id));
  const inFolder = new Map<number, ProjectCatalogItem[]>();
  const unfiled: ProjectCatalogItem[] = [];
  items.forEach((item) => {
    // A project filed in a folder this list does not know (just deleted) reads as unfiled.
    if (item.folder_id !== null && known.has(item.folder_id)) inFolder.set(item.folder_id, [...(inFolder.get(item.folder_id) ?? []), item]);
    else unfiled.push(item);
  });
  const out: TreeNode[] = [];
  const walk = (parent: number | null, depth: number, seen: Set<number>) => {
    [...(children.get(parent) ?? [])].sort(byName).forEach((folder) => {
      if (seen.has(folder.id)) return; // a cycle can only come from bad data; never loop on it
      const isCollapsed = collapsed.has(folder.id);
      out.push({ kind: 'folder', folder, depth, collapsed: isCollapsed });
      if (isCollapsed) return;
      walk(folder.id, depth + 1, new Set([...seen, folder.id]));
      (inFolder.get(folder.id) ?? []).forEach((item) => out.push({ kind: 'project', item, depth: depth + 1 }));
    });
  };
  walk(null, 0, new Set());
  if (unfiled.length > 0) {
    out.push({ kind: 'unfiled', count: unfiled.length });
    unfiled.forEach((item) => out.push({ kind: 'project', item, depth: 0 }));
  }
  return out;
}

/** The folder's name and its ancestors', root first; [] for no folder or an unknown one. */
export function folderPath(folders: readonly ProjectFolder[], folderId: number | null): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: string[] = [];
  const seen = new Set<number>();
  let current = folderId;
  while (current !== null && byId.has(current) && !seen.has(current)) {
    seen.add(current);
    const folder = byId.get(current)!;
    out.unshift(folder.name);
    current = folder.parent_id;
  }
  return out;
}

/** The folder and every folder below it (a project dragged into its own subtree is refused with these). */
export function descendantIds(folders: readonly ProjectFolder[], folderId: number): Set<number> {
  const out = new Set<number>([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    folders.forEach((f) => {
      if (f.parent_id !== null && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    });
  }
  return out;
}

/** The projects the list shows, top to bottom (keyboard navigation order). */
export const visibleProjects = (nodes: readonly TreeNode[]): ProjectCatalogItem[] =>
  nodes.flatMap((n) => (n.kind === 'project' ? [n.item] : []));

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** `text` cut into plain and matching segments for the search terms (accent- and case-insensitive).
 *  Falls back to one plain segment when folding changes the string's length (ligatures). */
export function splitHighlight(text: string, q: string): { text: string; hit: boolean }[] {
  const terms = q.split(/\s+/).map(fold).filter(Boolean);
  const folded = fold(text);
  if (terms.length === 0 || folded.length !== text.length) return [{ text, hit: false }];
  const marks = new Array<boolean>(text.length).fill(false);
  terms.forEach((term) => {
    let from = 0;
    for (let at = folded.indexOf(term, from); at !== -1; at = folded.indexOf(term, from)) {
      for (let i = at; i < at + term.length; i++) marks[i] = true;
      from = at + term.length;
    }
  });
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1];
    if (last && last.hit === marks[i]) last.text += text[i];
    else out.push({ text: text[i], hit: marks[i] });
  }
  return out;
}
