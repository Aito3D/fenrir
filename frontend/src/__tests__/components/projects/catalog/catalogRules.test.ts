import { describe, it, expect } from 'vitest';
import {
  applyFilters,
  buildTree,
  descendantIds,
  folderPath,
  isFiltering,
  materialsOf,
  sortItems,
  splitHighlight,
  visibleProjects,
  EMPTY_FILTERS,
} from '../../../../components/projects/catalog/catalogRules';
import type { ProjectCatalogItem, ProjectFolder } from '../../../../api/client';

const folder = (id: number, name: string, parent_id: number | null = null): ProjectFolder => ({
  id, name, parent_id, project_count: 0, in_production_count: 0,
});
const item = (id: number, name: string, o: Partial<ProjectCatalogItem> = {}): ProjectCatalogItem => ({
  id, code: `P-${String(id).padStart(4, '0')}`, name, description: null, status: 'active', folder_id: null, tags: [],
  client_names: [], open_orders: [], files_count: 1, recommended: null, has_unsliced_only: false, printed_count: 0,
  target_count: null, last_activity: `2026-10-${String(id).padStart(2, '0')}T10:00:00Z`, thumbnail_file_id: null, ...o,
});
const rec = (types: string[]) => ({
  item_id: 1, item_name: 'x', revision_id: 1, number: 1, status: 'valide' as const, printer_model: 'X1C',
  nozzle_diameter: '0.4', filament_types: types, print_time_seconds: 100, filament_used_grams: 10,
});

const car = folder(1, 'Car');
const caps = folder(2, 'Wheel cap', 1);
const labels = folder(3, 'Labels');
const items = [
  item(1, 'Logo', { folder_id: 1 }),
  item(2, 'Toyota cap', { folder_id: 2, recommended: rec(['ASA']), printed_count: 3 }),
  item(3, 'Starlink', { open_orders: [{ order_id: 1098, client_name: 'Marc' }], recommended: rec(['petg']) }),
  item(4, 'Scan', { files_count: 0 }),
];

describe('catalogRules', () => {
  it('derives the material chips from the recommended revisions, upper-cased and sorted', () => {
    expect(materialsOf(items)).toEqual(['ASA', 'PETG']);
  });

  it('applies the quick filters', () => {
    const ids = (f: Parameters<typeof applyFilters>[1]) => applyFilters(items, f).map((i) => i.id);
    expect(ids({ chips: new Set(['production']), materials: new Set() })).toEqual([3]);
    expect(ids({ chips: new Set(['ready']), materials: new Set() })).toEqual([2, 3]);
    expect(ids({ chips: new Set(['nofile']), materials: new Set() })).toEqual([4]);
    expect(ids({ chips: new Set(), materials: new Set(['PETG']) })).toEqual([3]);
    expect(ids({ chips: new Set(['ready']), materials: new Set(['ASA']) })).toEqual([2]);
    expect(isFiltering('', EMPTY_FILTERS)).toBe(false);
    expect(isFiltering(' cap', EMPTY_FILTERS)).toBe(true);
    expect(isFiltering('', { chips: new Set(['ready']), materials: new Set() })).toBe(true);
  });

  it('sorts by activity (newest first), code, title and printed count', () => {
    expect(sortItems(items, 'activity').map((i) => i.id)).toEqual([4, 3, 2, 1]);
    expect(sortItems(items, 'code').map((i) => i.id)).toEqual([1, 2, 3, 4]);
    expect(sortItems(items, 'name').map((i) => i.name)).toEqual(['Logo', 'Scan', 'Starlink', 'Toyota cap']);
    expect(sortItems(items, 'printed').map((i) => i.id)[0]).toBe(2);
  });

  it('builds the tree: folders A→Z, sub-folders before projects, unfiled last, collapsed closed', () => {
    const nodes = buildTree([labels, caps, car], items, new Set());
    expect(nodes.map((n) => (n.kind === 'folder' ? `F${n.depth}:${n.folder.name}` : n.kind === 'project' ? `P${n.depth}:${n.item.name}` : `U:${n.count}`)))
      .toEqual(['F0:Car', 'F1:Wheel cap', 'P2:Toyota cap', 'P1:Logo', 'F0:Labels', 'U:2', 'P0:Starlink', 'P0:Scan']);
    const closed = buildTree([labels, caps, car], items, new Set([1]));
    expect(closed.map((n) => (n.kind === 'folder' ? n.folder.name : n.kind === 'project' ? n.item.name : 'unfiled')))
      .toEqual(['Car', 'Labels', 'unfiled', 'Starlink', 'Scan']);
    expect(visibleProjects(nodes).map((i) => i.id)).toEqual([2, 1, 3, 4]);
  });

  it('treats a project filed in an unknown folder as unfiled', () => {
    const nodes = buildTree([car], [item(9, 'Lost', { folder_id: 42 })], new Set());
    expect(nodes.map((n) => n.kind)).toEqual(['folder', 'unfiled', 'project']);
  });

  it('gives a folder path and a subtree', () => {
    expect(folderPath([car, caps, labels], 2)).toEqual(['Car', 'Wheel cap']);
    expect(folderPath([car, caps, labels], null)).toEqual([]);
    expect(folderPath([car], 77)).toEqual([]);
    expect([...descendantIds([car, caps, labels], 1)].sort()).toEqual([1, 2]);
    expect([...descendantIds([car, caps, labels], 3)]).toEqual([3]);
  });

  it('splits text into highlighted segments, accent- and case-insensitively', () => {
    expect(splitHighlight('Étiquette Ocean', 'eti ocean')).toEqual([
      { text: 'Éti', hit: true }, { text: 'quette ', hit: false }, { text: 'Ocean', hit: true },
    ]);
    expect(splitHighlight('Logo', '')).toEqual([{ text: 'Logo', hit: false }]);
    expect(splitHighlight('Logo', 'zzz')).toEqual([{ text: 'Logo', hit: false }]);
  });
});
