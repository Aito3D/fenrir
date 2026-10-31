/** The Projects catalog (design 2026-10-31): folder tree on the left, the selected project's
 *  printing files on the right, one search over everything, quick filters, filing by button
 *  and by drag-and-drop, and the URL carrying the search and the selection. */
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ProjectListPage } from '../../pages/ProjectListPage';
import type { ProjectCatalogItem, ProjectFolder } from '../../api/client';

const folder = (id: number, name: string, parent_id: number | null = null, project_count = 0, in_production_count = 0): ProjectFolder =>
  ({ id, name, parent_id, project_count, in_production_count });
const rec = (item_name: string, types: string[]) => ({
  item_id: 1, item_name, revision_id: 1, number: 2, status: 'valide' as const, printer_model: 'Bambu Lab X1C',
  nozzle_diameter: '0.4', filament_types: types, print_time_seconds: 3720, filament_used_grams: 21,
});
const item = (id: number, code: string, name: string, o: Partial<ProjectCatalogItem> = {}): ProjectCatalogItem => ({
  id, code, name, description: null, status: 'active', folder_id: null, tags: [], client_names: [], open_orders: [],
  files_count: 1, recommended: null, has_unsliced_only: false, printed_count: 0, target_count: null,
  last_activity: `2026-10-${String(30 - id).padStart(2, '0')}T10:00:00Z`, thumbnail_file_id: null, ...o,
});
const FOLDERS = [folder(1, 'Car', null, 3, 1), folder(2, 'Wheel cap', 1, 2, 1), folder(3, 'Labels')];
const ITEMS = [
  item(1, 'P-0015', '350Z 60mm WheelCap', { folder_id: 2, client_names: ['Nissan Club'], open_orders: [{ order_id: 1098, client_name: 'Nissan Club' }], recommended: rec('cap', ['ASA']), printed_count: 4 }),
  item(2, 'P-0008', 'Toyota Wheel Cap', { folder_id: 2, recommended: rec('cap', ['ASA']) }),
  item(3, 'P-0001', 'Logo F170', { folder_id: 1 }),
  item(4, 'P-0014', 'Support pour Starlink', { recommended: rec('mount', ['PETG']), open_orders: [{ order_id: 1099, client_name: 'Marc' }] }),
  item(5, 'P-0003', 'Scan portière', { files_count: 0 }),
];

let lastCatalog: URLSearchParams;
let calls: string[];

const mediaQuery = (matches: boolean) => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() });

beforeEach(() => {
  localStorage.clear();
  calls = [];
  window.history.replaceState({}, '', '/projects');
  // The test setup's matchMedia answers "narrow"; the catalog is a wide-screen page by default.
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mediaQuery(true)));
  server.use(
    http.get('/api/v1/projects/catalog', ({ request }) => {
      lastCatalog = new URL(request.url).searchParams;
      const q = (lastCatalog.get('q') ?? '').toLowerCase();
      return HttpResponse.json({ items: q ? ITEMS.filter((p) => p.name.toLowerCase().includes(q)) : ITEMS });
    }),
    http.get('/api/v1/projects/folders', () => HttpResponse.json({ folders: FOLDERS })),
    http.get('/api/v1/projects/tags', () => HttpResponse.json([])),
    http.get('/api/v1/projects/:id/tree', ({ params }) =>
      HttpResponse.json({ project_id: Number(params.id), code: 'P-0000', sections: [{ section: 'impression', items: [] }] }),
    ),
    http.get('/api/v1/projects/:id/orders', () => HttpResponse.json({ orders: [] })),
    http.patch('/api/v1/projects/:id/folder', async ({ params, request }) => {
      calls.push(`move:${params.id}:${JSON.stringify(await request.json())}`);
      return HttpResponse.json({ id: Number(params.id), folder_id: null });
    }),
    http.post('/api/v1/projects/folders', async ({ request }) => {
      calls.push(`create:${JSON.stringify(await request.json())}`);
      return HttpResponse.json(folder(9, 'New'), { status: 201 });
    }),
    http.patch('/api/v1/projects/folders/:id', async ({ params, request }) => {
      calls.push(`rename:${params.id}:${JSON.stringify(await request.json())}`);
      return HttpResponse.json(folder(Number(params.id), 'Renamed'));
    }),
    http.delete('/api/v1/projects/folders/:id', ({ params }) => {
      calls.push(`delete:${params.id}`);
      return new HttpResponse(null, { status: 204 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const list = () => screen.getByRole('listbox', { name: 'Projects' });
const rowNames = () => within(list()).getAllByRole('option').map((o) => o.getAttribute('data-testid'));

describe('ProjectListPage (catalog)', () => {
  it('shows the folder tree with counts, projects filed inside, and the unfiled ones last', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    expect(within(screen.getByTestId('catalog-folder-1')).getByText('Car')).toBeInTheDocument();
    expect(within(screen.getByTestId('catalog-folder-1')).getByText('3')).toBeInTheDocument();
    expect(within(screen.getByTestId('catalog-folder-2')).getByText('Wheel cap')).toBeInTheDocument();
    expect(rowNames()).toEqual(['catalog-row-1', 'catalog-row-2', 'catalog-row-3', 'catalog-row-4', 'catalog-row-5']);
    expect(screen.getByText('Not in a folder')).toBeInTheDocument();
    expect(screen.getByText('5 of 5 projects', { exact: false })).toBeInTheDocument();
    // The row facts: client, files · recommended revision, material.
    expect(screen.getByTestId('catalog-row-1')).toHaveTextContent('Nissan Club · 1 file · R2 cap · ASA');
    expect(screen.getByTestId('catalog-row-5')).toHaveTextContent('No printing file yet');
  });

  it('collapses a folder and remembers it', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    await userEvent.click(within(screen.getByTestId('catalog-folder-1')).getByRole('button', { name: /Car/ }));
    expect(screen.queryByTestId('catalog-row-3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('catalog-folder-2')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('projects-catalog-collapsed') ?? '[]')).toEqual([1]);
  });

  it('selects the first project on a wide screen, shows its pane and puts it in the URL', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    await waitFor(() => expect(window.location.search).toBe('?project=1'));
    const pane = await screen.findByTestId('catalog-pane');
    expect(within(pane).getByRole('heading', { name: '350Z 60mm WheelCap' })).toBeInTheDocument();
    expect(within(pane).getByText('#1098 · Nissan Club')).toBeInTheDocument();
    expect(within(pane).getByRole('link', { name: /Open project/ })).toHaveAttribute('href', '/projects/1');
    await userEvent.click(screen.getByTestId('catalog-row-4'));
    expect(window.location.search).toBe('?project=4');
    expect(within(await screen.findByTestId('catalog-pane')).getByRole('heading', { name: 'Support pour Starlink' })).toBeInTheDocument();
  });

  it('a search flattens the tree, shows each hit with its folder path and reaches the server', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    await userEvent.type(screen.getByRole('searchbox'), 'cap');
    await waitFor(() => expect(lastCatalog.get('q')).toBe('cap'));
    await waitFor(() => expect(rowNames()).toEqual(['catalog-row-1', 'catalog-row-2']));
    expect(screen.queryByTestId('catalog-folder-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('catalog-row-1')).toHaveTextContent('Car › Wheel cap');
    expect(window.location.search).toContain('q=cap');
    expect(within(screen.getByTestId('catalog-row-1')).getAllByText('Cap', { selector: 'mark' }).length).toBeGreaterThan(0);
  });

  it('quick filters narrow the list without a server round trip', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    await userEvent.click(screen.getByRole('button', { name: 'In production' }));
    expect(rowNames()).toEqual(['catalog-row-1', 'catalog-row-4']);
    await userEvent.click(screen.getByRole('button', { name: 'PETG' }));
    expect(rowNames()).toEqual(['catalog-row-4']);
    await userEvent.click(screen.getByRole('button', { name: 'In production' }));
    await userEvent.click(screen.getByRole('button', { name: 'PETG' }));
    await userEvent.click(screen.getByRole('button', { name: 'No file yet' }));
    expect(rowNames()).toEqual(['catalog-row-5']);
    expect(lastCatalog.get('q')).toBeNull();
  });

  it('moves the selection with the arrow keys', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    // Wait for the selection to be RENDERED (the URL changes before React re-renders the page).
    await waitFor(() => expect(screen.getByTestId('catalog-row-1')).toHaveAttribute('aria-selected', 'true'));
    fireEvent.keyDown(screen.getByTestId('catalog-row-1'), { key: 'ArrowDown' });
    await waitFor(() => expect(window.location.search).toBe('?project=2'));
    fireEvent.keyDown(screen.getByTestId('catalog-row-2'), { key: 'ArrowUp' });
    await waitFor(() => expect(window.location.search).toBe('?project=1'));
    fireEvent.keyDown(screen.getByTestId('catalog-row-1'), { key: '/' });
    expect(screen.getByRole('searchbox')).toHaveFocus();
  });

  it('creates a folder from the inline row', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    await userEvent.click(screen.getByRole('button', { name: 'New folder' }));
    await userEvent.type(screen.getByLabelText('Folder name'), 'Accessories');
    await userEvent.selectOptions(screen.getByLabelText('At the top'), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls).toEqual(['create:{"name":"Accessories","parent_id":1}']));
    await waitFor(() => expect(screen.queryByLabelText('Folder name')).not.toBeInTheDocument());
  });

  it('files a project with the move button', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-4');
    await userEvent.click(within(screen.getByTestId('catalog-row-4')).getByRole('button', { name: 'Move to folder…' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Move to folder…' }), '3');
    await waitFor(() => expect(calls).toEqual(['move:4:{"folder_id":3}']));
  });

  it('files a project by dropping it on a folder, and unfiles it on "Not in a folder"', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-4');
    const data: Record<string, string> = {};
    const dataTransfer = {
      setData: (k: string, v: string) => { data[k] = v; },
      getData: (k: string) => data[k],
      types: ['application/x-fenrir-project'],
      effectAllowed: 'move',
      dropEffect: 'none',
    };
    fireEvent.dragStart(screen.getByTestId('catalog-row-4'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('catalog-folder-3'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('catalog-folder-3'), { dataTransfer });
    await waitFor(() => expect(calls).toEqual(['move:4:{"folder_id":3}']));
    fireEvent.dragStart(screen.getByTestId('catalog-row-1'), { dataTransfer });
    const unfiled = screen.getByText('Not in a folder').closest('li') as HTMLElement;
    fireEvent.dragOver(unfiled, { dataTransfer });
    fireEvent.drop(unfiled, { dataTransfer });
    await waitFor(() => expect(calls).toContain('move:1:{"folder_id":null}'));
  });

  it("the folder menu renames and deletes", async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    await userEvent.click(within(screen.getByTestId('catalog-folder-3')).getByRole('button', { name: 'Folder actions' }));
    await userEvent.click(await screen.findByText('Rename'));
    const input = screen.getByLabelText('Folder name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Stickers{Enter}');
    await waitFor(() => expect(calls).toEqual(['rename:3:{"name":"Stickers"}']));
    await userEvent.click(within(screen.getByTestId('catalog-folder-3')).getByRole('button', { name: 'Folder actions' }));
    await userEvent.click(await screen.findByText('Delete folder'));
    await waitFor(() => expect(calls).toContain('delete:3'));
  });

  it('on a narrow screen a row opens the project page instead of a pane', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mediaQuery(false)));
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    expect(screen.queryByTestId('catalog-pane')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('catalog-row-2'));
    expect(window.location.pathname).toBe('/projects/2');
  });

  it('shows the empty-search message', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    await userEvent.type(screen.getByRole('searchbox'), 'zzz');
    expect(await screen.findByText('No project matches this search')).toBeInTheDocument();
  });
});
