import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../utils';
import { MobileCatalog, type MobileCatalogProps } from '../../../../components/projects/catalog/mobile/MobileCatalog';
import { EMPTY_FILTERS } from '../../../../components/projects/catalog/catalogRules';
import type { ProjectCatalogItem, ProjectFolder } from '../../../../api/client';

const folder = (id: number, name: string, parent_id: number | null = null, project_count = 0, in_production_count = 0): ProjectFolder =>
  ({ id, name, parent_id, project_count, in_production_count });
const item = (id: number, code: string, name: string, o: Partial<ProjectCatalogItem> = {}): ProjectCatalogItem => ({
  id, code, name, description: null, status: 'active', folder_id: null, tags: [], client_names: [], open_orders: [], files_count: 1,
  recommended: { item_id: 1, item_name: 'cap', revision_id: 1, number: 2, status: 'valide', printer_model: null, nozzle_diameter: null, filament_types: ['ASA'], print_time_seconds: 60, filament_used_grams: 1 },
  has_unsliced_only: false, printed_count: 0, target_count: null, last_activity: '2026-11-01T00:00:00', thumbnail_file_id: null, ...o,
});
const FOLDERS = [folder(1, 'Car', null, 3, 1), folder(2, 'Wheel cap', 1, 2), folder(3, 'Labels', null, 0)];
const ITEMS = [
  item(10, 'P-0010', 'Starlink mount', { client_names: ['Marc'], open_orders: [{ order_id: 1098, client_name: 'Marc' }] }),
  item(8, 'P-0008', 'Toyota cap', { folder_id: 2 }),
  item(15, 'P-0015', '350Z cap', { folder_id: 2, printed_count: 4 }),
  item(7, 'P-0007', 'Cache Néiman', { folder_id: 1, files_count: 0, recommended: null }),
];

function props(over: Partial<MobileCatalogProps> = {}): MobileCatalogProps {
  return {
    items: ITEMS, folders: FOLDERS, isLoading: false, q: '', onQChange: vi.fn(), filtering: false, filters: EMPTY_FILTERS,
    onToggleChip: vi.fn(), onToggleMaterial: vi.fn(), materials: ['ASA'], usedTags: [], tagIds: [], onToggleTag: vi.fn(),
    sort: 'activity', onSortChange: vi.fn(), status: 'active', onStatusChange: vi.fn(), folderId: null, onFolderChange: vi.fn(),
    canCreate: true, canUpdate: true, onOpenProject: vi.fn(), onNewProject: vi.fn(), onCreateFolder: vi.fn().mockResolvedValue({}),
    onRenameFolder: vi.fn().mockResolvedValue({}), onDeleteFolder: vi.fn(), onMoveFolder: vi.fn(), hideFab: false, ...over,
  };
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

describe('MobileCatalog', () => {
  it('at the top: the root folders, then the loose projects, with the counts of everything', () => {
    render(<MobileCatalog {...props()} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Projects');
    expect(screen.getByTestId('catalog-mobile-counts')).toHaveTextContent('4');
    const car = screen.getByTestId('catalog-mobile-folder-1');
    expect(car).toHaveTextContent('3 projects · 1 folder · 1 in production');
    expect(screen.getByTestId('catalog-mobile-folder-3')).toBeInTheDocument();
    expect(screen.queryByTestId('catalog-mobile-folder-2')).not.toBeInTheDocument();
    expect(screen.getByText('Not in a folder')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-mobile-row-10')).toHaveTextContent('Marc · order #1098');
    expect(screen.getByTestId('catalog-mobile-row-10')).toHaveTextContent('R2 cap · ASA');
    expect(screen.queryByTestId('catalog-mobile-row-8')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it('a folder row drills in; inside, the title is the folder with a back button and a breadcrumb', async () => {
    const onFolderChange = vi.fn();
    const { rerender } = render(<MobileCatalog {...props({ onFolderChange })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Car' }));
    expect(onFolderChange).toHaveBeenCalledWith(1);
    rerender(<MobileCatalog {...props({ onFolderChange, folderId: 2 })} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Wheel cap');
    expect(screen.getByText('Projects › Car')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-mobile-counts')).toHaveTextContent('2');
    expect(screen.getByTestId('catalog-mobile-row-8')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-mobile-row-15')).toHaveTextContent('4');
    expect(screen.queryByTestId('catalog-mobile-row-10')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onFolderChange).toHaveBeenLastCalledWith(1);
  });

  it('an empty folder says so and that + creates here', () => {
    render(<MobileCatalog {...props({ folderId: 3 })} />);
    expect(screen.getByText('This folder is empty')).toBeInTheDocument();
    expect(screen.getByText('+ creates a project here')).toBeInTheDocument();
  });

  it('searching flattens the list across folders with each row carrying its path', () => {
    render(<MobileCatalog {...props({ filtering: true, q: 'cap', items: ITEMS.filter((i) => /cap/i.test(i.name)) })} />);
    expect(screen.queryByTestId('catalog-mobile-folder-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('catalog-mobile-row-8')).toHaveTextContent('Car › Wheel cap');
    expect(screen.getByTestId('catalog-mobile-row-15')).toBeInTheDocument();
  });

  it('a row opens the project', async () => {
    const onOpenProject = vi.fn();
    render(<MobileCatalog {...props({ onOpenProject })} />);
    await userEvent.click(within(screen.getByTestId('catalog-mobile-row-10')).getByRole('button'));
    expect(onOpenProject).toHaveBeenCalledWith(10);
  });

  it('the filter button opens the sheet: status segments, sort rows, Done; a dot shows off-default filters', async () => {
    const onStatusChange = vi.fn();
    const onSortChange = vi.fn();
    render(<MobileCatalog {...props({ onStatusChange, onSortChange })} />);
    expect(screen.queryByTestId('catalog-filters-dot')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Status and sort' }));
    const sheet = screen.getByTestId('catalog-filter-sheet');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Archived' }));
    expect(onStatusChange).toHaveBeenCalledWith('archived');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Sort: code' }));
    expect(onSortChange).toHaveBeenCalledWith('code');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByTestId('catalog-filter-sheet')).not.toBeInTheDocument());
  });

  it('the + opens New project / New folder; the new-folder sheet creates where you are', async () => {
    const onNewProject = vi.fn();
    const onCreateFolder = vi.fn().mockResolvedValue({});
    render(<MobileCatalog {...props({ onNewProject, onCreateFolder, folderId: 1 })} />);
    await userEvent.click(screen.getByTestId('catalog-mobile-fab'));
    expect(screen.getByRole('menu', { name: 'Create' })).toHaveTextContent('Filed in Car');
    await userEvent.click(screen.getByRole('menuitem', { name: 'New project' }));
    expect(onNewProject).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('catalog-mobile-fab'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'New folder' }));
    const sheet = await screen.findByTestId('catalog-new-folder-sheet');
    expect(sheet).toHaveTextContent('In Car');
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Folder name' }), 'Spoilers');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Create' }));
    expect(onCreateFolder).toHaveBeenCalledWith('Spoilers', 1);
  });

  it('a folder ⋯ sheet renames, creates inside, moves and deletes', async () => {
    const onRenameFolder = vi.fn().mockResolvedValue({});
    const onDeleteFolder = vi.fn();
    const onMoveFolder = vi.fn();
    render(<MobileCatalog {...props({ onRenameFolder, onDeleteFolder, onMoveFolder })} />);
    const menu = () => within(screen.getByTestId('catalog-mobile-folder-1')).getByRole('button', { name: 'Folder actions' });
    await userEvent.click(menu());
    let sheet = screen.getByTestId('catalog-folder-sheet');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Rename' }));
    const input = within(sheet).getByRole('textbox', { name: 'Folder name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Cars');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Rename' }));
    expect(onRenameFolder).toHaveBeenCalledWith(1, 'Cars');
    await waitFor(() => expect(screen.queryByTestId('catalog-folder-sheet')).not.toBeInTheDocument());
    await userEvent.click(menu());
    sheet = screen.getByTestId('catalog-folder-sheet');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Move to folder…' }));
    const select = within(sheet).getByRole('combobox', { name: 'Move to folder…' });
    // Its own subtree is not offered.
    expect(within(select).queryByRole('option', { name: 'Car › Wheel cap' })).not.toBeInTheDocument();
    await userEvent.selectOptions(select, '3');
    expect(onMoveFolder).toHaveBeenCalledWith(1, 3);
    await waitFor(() => expect(screen.queryByTestId('catalog-folder-sheet')).not.toBeInTheDocument());
    await userEvent.click(menu());
    sheet = screen.getByTestId('catalog-folder-sheet');
    await userEvent.click(within(sheet).getByRole('button', { name: /Delete folder/ }));
    expect(onDeleteFolder).toHaveBeenCalledWith(1);
  });

  it('hides the + without create permission and under a modal', () => {
    const { rerender } = render(<MobileCatalog {...props({ canCreate: false })} />);
    expect(screen.queryByTestId('catalog-mobile-fab')).not.toBeInTheDocument();
    rerender(<MobileCatalog {...props({ hideFab: true })} />);
    expect(screen.queryByTestId('catalog-mobile-fab')).not.toBeInTheDocument();
  });
});
