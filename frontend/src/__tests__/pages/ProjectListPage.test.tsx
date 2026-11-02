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
import { file, item as treeItem, projectTree, rev } from '../fixtures/projectTree';

// null = real AuthProvider (auth disabled: every permission granted).
let granted: Set<string> | null = null;
vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const { withGrantedPermissions } = await import('../fixtures/authPermissions');
  return withGrantedPermissions(await importOriginal<typeof import('../../contexts/AuthContext')>(), () => granted);
});

vi.mock('../../components/viewer/PartViewerModal', () => ({
  PartViewerModal: ({ title }: { title: string }) => <div data-testid="part-viewer">{title}</div>,
}));

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
  granted = null;
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
    http.patch('/api/v1/projects/:id', async ({ params, request }) => {
      calls.push(`update:${params.id}:${JSON.stringify(await request.json())}`);
      return HttpResponse.json({ id: Number(params.id) });
    }),
    http.post('/api/v1/projects/ai/reformulate', async ({ request }) => {
      const { text } = (await request.json()) as { text: string };
      calls.push(`ai:${text}`);
      return HttpResponse.json({ text: text.replace('wheelcap', 'Wheel Cap'), model: 'm' });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const list = () => screen.getByRole('listbox', { name: 'Projects' });

// dnd-kit decides what the pointer is over from element rectangles, and jsdom lays nothing out:
// every tree row (`data-catalog-row`) is given a 48px slot in list order, anything else the
// whole viewport. A drag is then real mouse events through dnd-kit's MouseSensor.
const ROW_H = 48;
const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const rows = Array.from(document.querySelectorAll('[data-catalog-row]'));
    const at = rows.indexOf(this);
    const rect = at === -1 ? { x: 0, y: 0, width: 1000, height: 5000 } : { x: 0, y: at * ROW_H, width: 400, height: ROW_H };
    return { ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => rect } as DOMRect;
  };
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
});
const mid = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { clientX: r.left + 20, clientY: r.top + ROW_H / 2 };
};
/** Picks `from` up (past the 5px activation distance) and parks the pointer over `to`. */
async function dragOver(from: Element, to: Element) {
  const start = mid(from);
  fireEvent.mouseDown(from, { ...start, button: 0 });
  fireEvent.mouseMove(document, { clientX: start.clientX, clientY: start.clientY + 12 });
  await waitFor(() => expect(document.body).toHaveClass('catalog-dragging'));
  fireEvent.mouseMove(document, mid(to));
}
/** A whole drag: pick `from` up, drop it on `to`. */
async function drop(from: Element, to: Element, settled: () => void) {
  await dragOver(from, to);
  await waitFor(settled);
  fireEvent.mouseUp(document, mid(to));
  await waitFor(() => expect(document.body).not.toHaveClass('catalog-dragging'));
}
const targeted = (el: Element) => expect(el).toHaveClass('ring-bambu-green');
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

  it('a project row carries no move button: filing is by drag', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-4');
    expect(within(screen.getByTestId('catalog-row-4')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('files a project by dropping it on a folder, and unfiles it on "Not in a folder"', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-4');
    const labels = screen.getByTestId('catalog-folder-3');
    await drop(screen.getByTestId('catalog-row-4'), labels, () => targeted(labels));
    await waitFor(() => expect(calls).toEqual(['move:4:{"folder_id":3}']));
    // The folder flashes as it takes the row, and the row flashes where it lands.
    expect(labels).toHaveClass('catalog-receive');
    expect(screen.getByTestId('catalog-row-4')).toHaveClass('catalog-landed');
    const unfiled = screen.getByTestId('catalog-unfiled');
    await drop(screen.getByTestId('catalog-row-1'), unfiled, () => expect(unfiled).toHaveClass('bg-bambu-green/15'));
    await waitFor(() => expect(calls).toContain('move:1:{"folder_id":null}'));
  });

  it('shows the lifted row under the pointer, dims its slot, and lights the folder a drop would file into', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-4');
    // Dropped on a project row, the dragged one files beside it: the target is that row's folder.
    await dragOver(screen.getByTestId('catalog-row-4'), screen.getByTestId('catalog-row-3'));
    await waitFor(() => targeted(screen.getByTestId('catalog-folder-1')));
    expect(screen.getByTestId('catalog-row-4')).toHaveClass('opacity-40');
    expect(within(screen.getByTestId('catalog-drag-ghost')).getByText('Support pour Starlink')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-row-3')).toHaveClass('bg-bambu-green/[0.06]');
    fireEvent.mouseUp(document, mid(screen.getByTestId('catalog-row-3')));
    await waitFor(() => expect(calls).toEqual(['move:4:{"folder_id":1}']));
  });

  it('a drop into the folder a project is already in changes nothing, and Escape lets go', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-3');
    const car = screen.getByTestId('catalog-folder-1');
    await drop(screen.getByTestId('catalog-row-3'), car, () => targeted(car));
    expect(calls).toEqual([]);
    await dragOver(screen.getByTestId('catalog-row-4'), car);
    await waitFor(() => targeted(car));
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(document.body).not.toHaveClass('catalog-dragging'));
    expect(car).not.toHaveClass('ring-bambu-green');
    expect(calls).toEqual([]);
  });

  it('a drag parked over a closed folder springs it open; it closes again if nothing lands inside', async () => {
    localStorage.setItem('projects-catalog-collapsed', '[1]');
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-4');
    expect(screen.queryByTestId('catalog-row-3')).not.toBeInTheDocument();
    const car = screen.getByTestId('catalog-folder-1');
    await dragOver(screen.getByTestId('catalog-row-4'), car);
    await waitFor(() => targeted(car));
    expect(await screen.findByTestId('catalog-row-3', {}, { timeout: 2000 })).toBeInTheDocument();
    // Let go somewhere else: Car folds back to how the user left it.
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('catalog-row-3')).not.toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem('projects-catalog-collapsed') ?? '[]')).toEqual([1]);
    // Dropped inside, it stays open.
    await dragOver(screen.getByTestId('catalog-row-4'), car);
    await waitFor(() => targeted(car));
    await screen.findByTestId('catalog-row-3', {}, { timeout: 2000 });
    fireEvent.mouseUp(document, mid(car));
    await waitFor(() => expect(calls).toEqual(['move:4:{"folder_id":1}']));
    expect(screen.getByTestId('catalog-row-3')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('projects-catalog-collapsed') ?? '[]')).toEqual([]);
  });

  it('the rows of a folder a click opens cascade in; a page load does not', async () => {
    localStorage.setItem('projects-catalog-collapsed', '[1]');
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-4');
    expect(screen.getByTestId('catalog-row-4').closest('li')).not.toHaveClass('catalog-row-reveal');
    await userEvent.click(within(screen.getByTestId('catalog-folder-1')).getByRole('button', { name: /Car/ }));
    expect(screen.getByTestId('catalog-folder-2')).toHaveClass('catalog-row-reveal');
    expect(screen.getByTestId('catalog-row-3').closest('li')).toHaveClass('catalog-row-reveal');
    // Fourth row under Car (after Wheel cap and its two projects): the fourth slot of the cascade.
    expect(screen.getByTestId('catalog-row-3').closest('li')?.style.getPropertyValue('--reveal-delay')).toBe('54ms');
    expect(screen.getByTestId('catalog-row-4').closest('li')).not.toHaveClass('catalog-row-reveal');
  });

  it('a search turns drag off: a result has no folder on screen to land on', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    await userEvent.type(screen.getByRole('searchbox'), 'cap');
    await waitFor(() => expect(rowNames()).toEqual(['catalog-row-1', 'catalog-row-2']));
    const start = mid(screen.getByTestId('catalog-row-1'));
    fireEvent.mouseDown(screen.getByTestId('catalog-row-1'), { ...start, button: 0 });
    fireEvent.mouseMove(document, { clientX: start.clientX, clientY: start.clientY + 30 });
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body).not.toHaveClass('catalog-dragging');
    fireEvent.mouseUp(document);
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

  it('on a phone the folder browser takes over, with the folder in the URL', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => mediaQuery(query === '(max-width: 767px)')));
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-mobile-folder-1');
    expect(screen.getByTestId('catalog-mobile')).toBeInTheDocument();
    expect(screen.queryByTestId('catalog-row-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('catalog-mobile-row-1')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Car' }));
    expect(window.location.search).toContain('folder=1');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Car');
    await userEvent.click(screen.getByRole('button', { name: 'Wheel cap' }));
    expect(window.location.search).toContain('folder=2');
    expect(screen.getByTestId('catalog-mobile-row-1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(window.location.search).toContain('folder=1');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(window.location.search).not.toContain('folder=');
    await userEvent.click(screen.getByRole('button', { name: 'Car' }));
    await userEvent.click(screen.getByRole('button', { name: 'Wheel cap' }));
    await userEvent.click(within(screen.getByTestId('catalog-mobile-row-2')).getByRole('button'));
    expect(window.location.pathname).toBe('/projects/2');
  });

  it('shows the empty-search message', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    await userEvent.type(screen.getByRole('searchbox'), 'zzz');
    expect(await screen.findByText('No project matches this search')).toBeInTheDocument();
  });

  it('renames the project from the pane title: click, AI check on Enter, Enter again saves', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    const pane = await screen.findByTestId('catalog-pane');
    await userEvent.click(within(pane).getByRole('button', { name: '350Z 60mm WheelCap' }));
    const input = within(pane).getByRole('textbox', { name: 'Title' });
    expect(input).toHaveFocus();
    await userEvent.clear(input);
    await userEvent.type(input, '350Z 60mm wheelcap{Enter}');
    // The text had not been checked yet: Enter checks it, the correction shows, nothing is saved.
    await waitFor(() => expect(input).toHaveValue('350Z 60mm Wheel Cap'));
    expect(calls).toEqual(['ai:350Z 60mm wheelcap']);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(calls).toContain('update:1:{"name":"350Z 60mm Wheel Cap"}'));
    expect(calls.filter((c) => c.startsWith('ai:'))).toHaveLength(1);
    await waitFor(() => expect(within(pane).queryByTestId('catalog-title-editor')).not.toBeInTheDocument());
  });

  it('leaves the title untouched on Escape and on the cross', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    const pane = await screen.findByTestId('catalog-pane');
    await userEvent.click(within(pane).getByRole('button', { name: '350Z 60mm WheelCap' }));
    await userEvent.type(within(pane).getByRole('textbox', { name: 'Title' }), ' bis{Escape}');
    expect(within(pane).queryByTestId('catalog-title-editor')).not.toBeInTheDocument();
    expect(within(pane).getByRole('heading', { name: '350Z 60mm WheelCap' })).toBeInTheDocument();
    await userEvent.click(within(pane).getByRole('button', { name: '350Z 60mm WheelCap' }));
    await userEvent.click(within(pane).getByRole('button', { name: 'Cancel' }));
    expect(within(pane).queryByTestId('catalog-title-editor')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.startsWith('update:') || c.startsWith('ai:'))).toEqual([]);
  });

  it('the pane header carries no printer line: each file has its own setup', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    const pane = await screen.findByTestId('catalog-pane');
    expect(within(pane).queryByText(/Bambu Lab X1C/)).not.toBeInTheDocument();
  });

  it('files a folder inside another by drag-and-drop, never inside its own subtree', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    const wheelCap = screen.getByTestId('catalog-folder-2');
    // Car (1) onto its own child Wheel cap (2): the ghost dims, nothing lights, the drop is refused.
    await dragOver(screen.getByTestId('catalog-folder-1'), wheelCap);
    await waitFor(() => expect(screen.getByTestId('catalog-drag-ghost')).toHaveAttribute('data-invalid', 'true'));
    expect(wheelCap).not.toHaveClass('ring-bambu-green');
    fireEvent.mouseUp(document, mid(wheelCap));
    await waitFor(() => expect(document.body).not.toHaveClass('catalog-dragging'));
    expect(calls).toEqual([]);
    // Labels (3) into Wheel cap (2): a third level. The folder ghost is the folder row.
    await dragOver(screen.getByTestId('catalog-folder-3'), wheelCap);
    await waitFor(() => targeted(wheelCap));
    expect(within(screen.getByTestId('catalog-drag-ghost')).getByText('Labels')).toBeInTheDocument();
    fireEvent.mouseUp(document, mid(wheelCap));
    await waitFor(() => expect(calls).toEqual(['rename:3:{"parent_id":2}']));
  });

  it('the folder menu moves a folder, offering every folder outside its own subtree', async () => {
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    await userEvent.click(within(screen.getByTestId('catalog-folder-1')).getByRole('button', { name: 'Folder actions' }));
    await userEvent.click(await screen.findByText('Move to folder…'));
    const select = within(screen.getByTestId('catalog-folder-1')).getByRole('combobox', { name: 'Move to folder…' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['At the top', 'Labels']);
    await userEvent.selectOptions(select, '3');
    await waitFor(() => expect(calls).toEqual(['rename:1:{"parent_id":3}']));
  });

  it('the header says when the server listed fewer projects than matched', async () => {
    server.use(http.get('/api/v1/projects/catalog', () => HttpResponse.json({ items: ITEMS, truncated: true })));
    render(<ProjectListPage />);
    expect(await screen.findByText('5 of 5+ projects', { exact: false })).toBeInTheDocument();
  });

  it('a complete list reads as complete', async () => {
    server.use(http.get('/api/v1/projects/catalog', () => HttpResponse.json({ items: ITEMS, truncated: false })));
    render(<ProjectListPage />);
    expect(await screen.findByText('5 of 5 projects', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('5+', { exact: false })).not.toBeInTheDocument();
  });

  it('a link to a project inside a closed folder keeps it selected and opens the folder (T-527)', async () => {
    localStorage.setItem('projects-catalog-collapsed', JSON.stringify([1]));
    window.history.replaceState({}, '', '/projects?project=3');
    render(<ProjectListPage />);
    expect(await screen.findByTestId('catalog-row-3')).toBeInTheDocument();
    expect(within(await screen.findByTestId('catalog-pane')).getByRole('heading', { name: 'Logo F170' })).toBeInTheDocument();
    expect(window.location.search).toBe('?project=3');
    expect(JSON.parse(localStorage.getItem('projects-catalog-collapsed') ?? '[]')).toEqual([]);
  });

  it('opens every closed ancestor of a linked project, and only those', async () => {
    localStorage.setItem('projects-catalog-collapsed', JSON.stringify([1, 2, 3]));
    window.history.replaceState({}, '', '/projects?project=2');
    render(<ProjectListPage />);
    expect(await screen.findByTestId('catalog-row-2')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-row-1')).toBeInTheDocument();
    expect(window.location.search).toBe('?project=2');
    expect(JSON.parse(localStorage.getItem('projects-catalog-collapsed') ?? '[]')).toEqual([3]);
  });

  it('a link to a project that matches nothing still falls back to the first visible project', async () => {
    localStorage.setItem('projects-catalog-collapsed', JSON.stringify([1]));
    window.history.replaceState({}, '', '/projects?project=99');
    render(<ProjectListPage />);
    await waitFor(() => expect(window.location.search).toBe('?project=4'));
    expect(JSON.parse(localStorage.getItem('projects-catalog-collapsed') ?? '[]')).toEqual([1]);
  });

  it("closing the selected project's folder keeps the selection and the folder stays closed", async () => {
    window.history.replaceState({}, '', '/projects?project=3');
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-3');
    await userEvent.click(within(screen.getByTestId('catalog-folder-1')).getByRole('button', { name: /Car/ }));
    expect(screen.queryByTestId('catalog-row-3')).not.toBeInTheDocument();
    expect(window.location.search).toBe('?project=3');
    expect(within(screen.getByTestId('catalog-pane')).getByRole('heading', { name: 'Logo F170' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('projects-catalog-collapsed') ?? '[]')).toEqual([1]);
  });

  it("a copied viewer link into a closed folder opens that project's file", async () => {
    server.use(http.get('/api/v1/projects/3/tree', () =>
      HttpResponse.json(projectTree({ impression: [treeItem(77, 'impression', 'Logo plate', [rev({ id: 7, files: [file(70, 'logo.3mf')] })])] }, { project_id: 3 })),
    ));
    localStorage.setItem('projects-catalog-collapsed', JSON.stringify([1]));
    window.history.replaceState({}, '', '/projects?project=3&file=77&tab=toolpath');
    render(<ProjectListPage />);
    expect(await screen.findByTestId('part-viewer')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('project')).toBe('3');
  });

  it('renders folders nested three levels deep', async () => {
    server.use(http.get('/api/v1/projects/folders', () => HttpResponse.json({ folders: [...FOLDERS, folder(4, 'Nissan', 2, 1), folder(5, '350Z', 4, 1)] })));
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    expect(screen.getByTestId('catalog-folder-5')).toHaveStyle({ paddingLeft: `${12 + 3 * 18}px` });
  });
});

describe('ProjectListPage (catalog) permission gating', () => {
  it('read-only: no folder menu, no new-folder control, no create button, no drag, no editable title', async () => {
    granted = new Set(['projects:read']);
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    expect(screen.queryByRole('button', { name: 'Folder actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New folder' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Project' })).not.toBeInTheDocument();
    const pane = await screen.findByTestId('catalog-pane');
    expect(within(pane).queryByRole('button', { name: '350Z 60mm WheelCap' })).not.toBeInTheDocument();
    const start = mid(screen.getByTestId('catalog-row-4'));
    fireEvent.mouseDown(screen.getByTestId('catalog-row-4'), { ...start, button: 0 });
    fireEvent.mouseMove(document, { clientX: start.clientX, clientY: start.clientY + 30 });
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body).not.toHaveClass('catalog-dragging');
    fireEvent.mouseUp(document);
    expect(calls).toEqual([]);
  });

  it('update without create: the folder tools and drag are there, the create button is not', async () => {
    granted = new Set(['projects:read', 'projects:update']);
    render(<ProjectListPage />);
    await screen.findByTestId('catalog-row-1');
    expect(screen.getByRole('button', { name: 'New folder' })).toBeInTheDocument();
    expect(within(screen.getByTestId('catalog-folder-3')).getByRole('button', { name: 'Folder actions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Project' })).not.toBeInTheDocument();
    const labels = screen.getByTestId('catalog-folder-3');
    await dragOver(screen.getByTestId('catalog-row-4'), labels);
    fireEvent.mouseUp(document, mid(labels));
    await waitFor(() => expect(calls).toEqual(['move:4:{"folder_id":3}']));
  });
});
