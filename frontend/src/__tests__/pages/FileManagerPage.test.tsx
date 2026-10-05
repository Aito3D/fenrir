/**
 * Tests for the FileManagerPage component.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FileManagerPage } from '../../pages/FileManagerPage';
import { openInSlicer } from '../../utils/slicer';
import { setAuthToken } from '../../api/client';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

// Only the protocol-handler launch is stubbed — it would navigate the jsdom
// window. Everything else in the module is a pure predicate, so keep the real
// implementations: isSliceableFilename decides which rows even offer the
// action these tests click.
vi.mock('../../utils/slicer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/slicer')>()),
  openInSlicer: vi.fn(),
}));

vi.mock('../../components/SliceModal', () => ({
  SliceModal: ({ source }: { source: { filename: string } }) => (
    <div data-testid="slice-modal">{source.filename}</div>
  ),
}));

// The viewer pulls in three.js; the tests only care whether it opened.
vi.mock('../../components/ModelViewerModal', () => ({
  ModelViewerModal: ({ title }: { title: string }) => <div data-testid="model-viewer-modal">{title}</div>,
}));

// Mock data
const mockFolders = [
  {
    id: 1,
    name: 'Functional Parts',
    parent_id: null,
    file_count: 5,
    project_id: null,
    archive_id: null,
    project_name: null,
    archive_name: null,
    // #2680: distinctive year so the folder-pane display test can assert on it
    // without colliding with the file mtimes below.
    latest_activity_at: '2031-04-05T10:00:00Z',
    children: [
      {
        id: 2,
        name: 'Brackets',
        parent_id: 1,
        file_count: 3,
        project_id: null,
        archive_id: null,
        project_name: null,
        archive_name: null,
        latest_activity_at: '2032-06-07T10:00:00Z',
        children: [],
      },
    ],
  },
  {
    id: 3,
    name: 'Art Projects',
    parent_id: null,
    file_count: 2,
    project_id: 1,
    archive_id: null,
    project_name: 'My Art Project',
    archive_name: null,
    // No activity timestamp — must render no date line rather than an
    // "Invalid Date" placeholder.
    latest_activity_at: null,
    children: [],
  },
];

const mockFiles = [
  {
    id: 1,
    filename: 'benchy.gcode.3mf',
    file_path: '/library/benchy.gcode.3mf',
    file_size: 1048576,
    file_type: '3mf',
    folder_id: null,
    thumbnail_path: '/thumbnails/1.png',
    print_name: 'Benchy',
    print_time_seconds: 3600,
    filament_type: 'PLA, PETG',
    filament_used_grams: 12.3,
    print_count: 5,
    duplicate_count: 0,
    created_at: '2024-01-01T00:00:00Z',
    // #2680: real on-disk mtime in a distinctive year so the display test can
    // prove fs_modified_at is preferred over created_at (2024).
    fs_modified_at: '2030-06-15T12:00:00Z',
  },
  {
    id: 2,
    filename: 'bracket.stl',
    file_path: '/library/bracket.stl',
    file_size: 524288,
    file_type: 'stl',
    folder_id: null,
    thumbnail_path: null,
    print_name: null,
    print_time_seconds: null,
    print_count: 0,
    duplicate_count: 2,
    created_at: '2024-01-02T00:00:00Z',
  },
  {
    id: 3,
    filename: 'cube.gcode.3mf',
    file_path: '/library/cube.gcode.3mf',
    file_size: 2048576,
    file_type: '3mf',
    folder_id: null,
    thumbnail_path: '/thumbnails/3.png',
    print_name: 'Cube',
    print_time_seconds: 1800,
    print_count: 2,
    duplicate_count: 0,
    created_at: '2024-01-03T00:00:00Z',
  },
];

// Per-folder contents. The columns view lists every level's files, so each
// folder needs its own set — otherwise the same name shows up in two columns
// and the queries below cannot tell them apart.
const mockFolderFiles: Record<string, Record<string, unknown>[]> = {
  '1': [
    {
      id: 11,
      filename: 'spacer.3mf',
      file_path: '/library/functional/spacer.3mf',
      file_size: 131072,
      file_type: '3mf',
      folder_id: 1,
      thumbnail_path: null,
      print_name: 'Spacer',
      print_time_seconds: 900,
      print_count: 0,
      duplicate_count: 0,
      created_at: '2024-02-01T00:00:00Z',
    },
  ],
  '2': [
    {
      id: 12,
      filename: 'clamp.stl',
      file_path: '/library/functional/brackets/clamp.stl',
      file_size: 65536,
      file_type: 'stl',
      folder_id: 2,
      thumbnail_path: null,
      print_name: null,
      print_time_seconds: null,
      print_count: 0,
      duplicate_count: 0,
      created_at: '2024-02-02T00:00:00Z',
    },
    {
      id: 13,
      filename: 'hinge.3mf',
      file_path: '/library/functional/brackets/hinge.3mf',
      file_size: 98304,
      file_type: '3mf',
      folder_id: 2,
      thumbnail_path: null,
      print_name: 'Hinge',
      print_time_seconds: 1200,
      print_count: 1,
      duplicate_count: 0,
      created_at: '2024-02-03T00:00:00Z',
    },
  ],
  '3': [
    {
      id: 14,
      filename: 'vase.3mf',
      file_path: '/library/art/vase.3mf',
      file_size: 262144,
      file_type: '3mf',
      folder_id: 3,
      thumbnail_path: null,
      print_name: 'Vase',
      print_time_seconds: 5400,
      print_count: 0,
      duplicate_count: 0,
      created_at: '2024-02-04T00:00:00Z',
    },
  ],
};

// A request carrying folder_id wants that folder's own files. Without one,
// include_root decides as the server does: true is the root level (the files in
// no folder), false the whole library ("All Files", every folder included).
const filesForRequest = (request: Request) => {
  const params = new URL(request.url).searchParams;
  const folderId = params.get('folder_id');
  if (folderId) return mockFolderFiles[folderId] ?? [];
  return params.get('include_root') === 'true' ? mockFiles : [...mockFiles, ...Object.values(mockFolderFiles).flat()];
};

const mockStats = {
  total_files: 10,
  total_folders: 3,
  total_size_bytes: 104857600,
  disk_free_bytes: 10737418240,
  disk_total_bytes: 107374182400,
};

type Row = (typeof mockFiles)[number] & { created_by_username?: string | null; tags?: Array<{ id: number; name: string }> };

/** msw handler that applies the listing's server-side search/filter/sort/paging
 * over an in-memory row set and reports X-Total-Count, so the page tests see
 * the same contract the backend now honours. */
function pagedFilesHandler(rows: Row[] | ((request: Request) => Row[]), onRequest?: (params: URLSearchParams) => void) {
  return http.get('/api/v1/library/files', ({ request }) => {
    const p = new URL(request.url).searchParams;
    onRequest?.(p);
    let out = [...(typeof rows === 'function' ? rows(request) : rows)];
    const search = p.get('search')?.toLowerCase();
    if (search) {
      out = out.filter(
        (f) =>
          f.filename.toLowerCase().includes(search) ||
          (f.print_name ?? '').toLowerCase().includes(search) ||
          (f.tags ?? []).some((t) => t.name.toLowerCase().includes(search)),
      );
    }
    const type = p.get('file_type');
    if (type) out = out.filter((f) => f.file_type === type);
    const by = p.get('created_by')?.toLowerCase();
    if (by) out = out.filter((f) => (f.created_by_username ?? '').toLowerCase().includes(by));
    const sort = p.get('sort');
    const dir = p.get('direction') === 'desc' ? -1 : 1;
    out.sort((a, b) => {
      let c = 0;
      if (sort === 'name') c = (a.print_name || a.filename).localeCompare(b.print_name || b.filename);
      else if (sort === 'date') c = Date.parse((a as Row).fs_modified_at ?? a.created_at) - Date.parse((b as Row).fs_modified_at ?? b.created_at);
      else if (sort === 'size') c = a.file_size - b.file_size;
      else if (sort === 'type') c = a.file_type.localeCompare(b.file_type);
      else if (sort === 'prints') c = a.print_count - b.print_count;
      else c = a.filename.localeCompare(b.filename);
      return c * dir || a.id - b.id;
    });
    const offset = Number(p.get('offset') ?? 0);
    const limit = Number(p.get('limit') ?? 100);
    return HttpResponse.json(out.slice(offset, offset + limit), { headers: { 'X-Total-Count': String(out.length) } });
  });
}

describe('FileManagerPage', () => {
  beforeEach(() => {
    // Clear localStorage to ensure consistent view mode
    localStorage.clear();

    server.use(
      http.get('/api/v1/library/folders', () => {
        return HttpResponse.json(mockFolders);
      }),
      pagedFilesHandler((request) => filesForRequest(request) as Row[]),
      http.get('/api/v1/library/stats', () => {
        return HttpResponse.json(mockStats);
      }),
      http.get('/api/v1/settings/', () => {
        return HttpResponse.json({
          check_updates: false,
          check_printer_firmware: false,
          library_disk_warning_gb: 5,
        });
      }),
      http.post('/api/v1/library/folders', async ({ request }) => {
        const body = await request.json() as { name: string };
        return HttpResponse.json({ id: 4, name: body.name, parent_id: null, children: [] });
      }),
      http.delete('/api/v1/library/folders/:id', () => {
        return HttpResponse.json({ success: true });
      }),
      http.delete('/api/v1/library/files/:id', () => {
        return HttpResponse.json({ success: true });
      }),
      http.post('/api/v1/library/files/move', () => {
        return HttpResponse.json({ success: true });
      }),
      http.post('/api/v1/library/files/add-to-queue', () => {
        return HttpResponse.json({ added: [{ file_id: 1, queue_id: 1 }], errors: [] });
      }),
      http.get('/api/v1/projects/', () => {
        return HttpResponse.json([{ id: 1, name: 'Test Project', color: '#00ae42' }]);
      }),
      http.get('/api/v1/archives/', () => {
        return HttpResponse.json([{ id: 1, print_name: 'Test Archive', filename: 'test.3mf' }]);
      })
    );
  });

  describe('rendering', () => {
    it('renders the page title', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('File Manager')).toBeInTheDocument();
      });
    });

    it('renders the page description', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Organize and manage your print files')).toBeInTheDocument();
      });
    });

    it('shows New Folder button', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('New Folder')).toBeInTheDocument();
      });
    });

    it('shows Upload button', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });
    });
  });

  describe('stats display', () => {
    it('shows filament type and weight on file cards', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('PLA, PETG')).toBeInTheDocument();
        expect(screen.getByText('12.3g')).toBeInTheDocument();
      });
    });

    it('shows file count', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Files:')).toBeInTheDocument();
        expect(screen.getByText('10')).toBeInTheDocument();
      });
    });

    it('shows folder count', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Folders:')).toBeInTheDocument();
        // Folder count appears multiple places, just verify the label is present
        const foldersLabel = screen.getByText('Folders:');
        expect(foldersLabel.nextElementSibling?.textContent).toBe('3');
      });
    });

    it('shows total size', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Size:')).toBeInTheDocument();
        expect(screen.getByText('100.0 MB')).toBeInTheDocument();
      });
    });

    it('shows free space', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Free:')).toBeInTheDocument();
      });
    });
  });

  describe('folder sidebar', () => {
    it('shows All Files option', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('All Files')).toBeInTheDocument();
      });
    });

    it('shows folder tree', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Functional Parts')).toBeInTheDocument();
        expect(screen.getByText('Art Projects')).toBeInTheDocument();
      });
    });

    it('shows nested folders', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Brackets')).toBeInTheDocument();
      });
    });

    it('shows linked folder indicator', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        // Art Projects has a project_id
        expect(screen.getByText('Art Projects')).toBeInTheDocument();
      });
    });
  });

  describe('file display', () => {
    it('shows files in grid', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });
    });

    it('shows file type badges', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        // File type badges show uppercase type
        expect(screen.getAllByText('3MF').length).toBeGreaterThan(0);
        expect(screen.getAllByText('STL').length).toBeGreaterThan(0);
      });
    });

    it('shows print count', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Printed 5x')).toBeInTheDocument();
      });
    });

    it('shows duplicate badge', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        // Duplicate badge shows count, there may be multiple "2"s on the page
        // so we check that at least one element with "2" exists
        const elements = screen.getAllByText('2');
        expect(elements.length).toBeGreaterThan(0);
      });
    });
  });

  describe('view modes', () => {
    it('has grid view button', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByTitle('Grid view')).toBeInTheDocument();
      });
    });

    it('has list view button', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByTitle('List view')).toBeInTheDocument();
      });
    });

    it('can switch to list view', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      // Wait for files to load first
      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });

      // Both view mode buttons should be present and clickable
      const gridButton = screen.getByTitle('Grid view');
      const listButton = screen.getByTitle('List view');

      expect(gridButton).toBeInTheDocument();
      expect(listButton).toBeInTheDocument();

      // Click list view button - verify no errors occur
      await user.click(listButton);

      // Clicking grid button should also work
      await user.click(gridButton);

      // Verify files are still displayed after toggling
      expect(screen.getByText('Benchy')).toBeInTheDocument();
    });

    it('can switch to columns view and descend through folder columns', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Column view'));

      // Scoped to the columns pane — the folder names also live in the tree
      // sidebar, so unscoped queries would double-match.
      const columns = within(screen.getByTestId('columns-view'));
      expect(columns.getByText('Functional Parts')).toBeInTheDocument();
      expect(columns.getByText('Art Projects')).toBeInTheDocument();
      // Root files render in the files pane.
      expect(columns.getByText('Benchy')).toBeInTheDocument();

      // Descend: clicking a folder opens its child column, and the level the
      // user just left keeps listing its own files.
      await user.click(columns.getByText('Functional Parts'));
      await waitFor(() => {
        expect(columns.getByText('Brackets')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(columns.getByText('Benchy')).toBeInTheDocument();
      });
      expect(within(screen.getByTestId('columns-files-pane')).getByText('Spacer')).toBeInTheDocument();

      // Leaf folder: selecting it adds no further column and the pane swaps to
      // its contents.
      await user.click(columns.getByText('Brackets'));
      await waitFor(() => {
        expect(within(screen.getByTestId('columns-files-pane')).getByText('clamp.stl')).toBeInTheDocument();
      });
    });

    it('hides folder columns while a search filters across folders', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Column view'));
      const columns = within(screen.getByTestId('columns-view'));
      expect(columns.getByText('Functional Parts')).toBeInTheDocument();

      await user.type(screen.getByPlaceholderText('Search files...'), 'benchy');

      // Search results span every folder — the per-level columns disappear,
      // the matching file stays.
      await waitFor(() => {
        expect(columns.queryByText('Functional Parts')).not.toBeInTheDocument();
      });
      expect(columns.getByText('Benchy')).toBeInTheDocument();
    });

    it('navigates the columns with the arrow keys', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Column view'));
      const columns = within(screen.getByTestId('columns-view'));
      // The highlight sits on the row, which also hosts the folder kebab —
      // the name button itself is unstyled.
      const activeClassOf = (name: string) =>
        columns.getByText(name).closest('[data-folder-id]')?.className ?? '';

      // The pane auto-focuses when the view opens, so keys work immediately.
      // Down from the root selects the first folder (name-sorted: Art
      // Projects), Down again moves to its sibling.
      await user.keyboard('{ArrowDown}');
      await waitFor(() => {
        expect(activeClassOf('Art Projects')).toContain('bg-bambu-green/20');
      });
      await user.keyboard('{ArrowDown}');
      await waitFor(() => {
        expect(activeClassOf('Functional Parts')).toContain('bg-bambu-green/20');
      });

      // Right descends into the first child folder…
      await user.keyboard('{ArrowRight}');
      await waitFor(() => {
        expect(activeClassOf('Brackets')).toContain('bg-bambu-green/20');
      });
      // …and Left climbs back up to the parent.
      await user.keyboard('{ArrowLeft}');
      await waitFor(() => {
        expect(activeClassOf('Functional Parts')).toContain('bg-bambu-green/20');
      });

      // Right on a folder without child folders moves the focus into the
      // files pane; Down walks the file rows. Wait for the refetched file
      // list before the second Right — during the folder switch the pane can
      // be momentarily empty.
      await user.keyboard('{ArrowRight}');
      await waitFor(() => {
        expect(activeClassOf('Brackets')).toContain('bg-bambu-green/20');
        expect(columns.getByText('clamp.stl')).toBeInTheDocument();
      });
      await user.keyboard('{ArrowRight}');
      await waitFor(() => {
        expect(columns.getByText('clamp.stl').closest('[title="clamp.stl"]')?.className).toContain('ring-1');
      });
      await user.keyboard('{ArrowDown}');
      await waitFor(() => {
        expect(columns.getByText('Hinge').closest('[title="Hinge"]')?.className).toContain('ring-1');
      });
      // Left leaves the files pane again.
      await user.keyboard('{ArrowLeft}');
      await waitFor(() => {
        expect(columns.getByText('Hinge').closest('[title="Hinge"]')?.className).not.toContain('ring-1');
      });
    });

    it('keeps the columns pane mounted while a folder\'s files load', async () => {
      const user = userEvent.setup();
      // First files request (initial load) resolves immediately, later ones
      // (the refetch a keyboard descent triggers) stay pending briefly.
      let filesCalls = 0;
      server.use(
        http.get('/api/v1/library/files', async ({ request }) => {
          filesCalls += 1;
          if (filesCalls > 1) await new Promise((resolve) => setTimeout(resolve, 150));
          return HttpResponse.json(filesForRequest(request));
        })
      );
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });
      await user.click(screen.getByTitle('Column view'));
      expect(screen.getByTestId('columns-view')).toBeInTheDocument();

      // Descend while the folder's file list is still in flight. Swapping
      // the pane for the global spinner here would strip its tabindex and,
      // in real browsers, drop keyboard focus to <body> for good.
      await user.keyboard('{ArrowDown}');
      expect(screen.getByTestId('columns-view')).toBeInTheDocument();

      await waitFor(() => {
        expect(within(screen.getByTestId('columns-files-pane')).getByText('Vase')).toBeInTheDocument();
      });
    });

    // #3020 follow-up: the files pane carries the list row's icon strip, so
    // the columns view offers every per-file action in the same order.
    const listRow = (name: string) => screen.getByText(name).closest('div[class*="cursor-pointer"]') as HTMLElement;
    const actionTitlesOf = (row: HTMLElement) =>
      Array.from(row.querySelector('[data-file-actions]')!.querySelectorAll('button')).map((b) => b.title);

    it('offers the same per-file actions as the list view, in the same order', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await user.click(screen.getByTitle('List view'));
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());
      const listBenchy = actionTitlesOf(listRow('Benchy'));
      const listBracket = actionTitlesOf(listRow('bracket.stl'));
      // Fenrir: printable files also get Move to project (projects PDM phase 5).
      expect(listBenchy).toEqual(['Print', '3D Preview', 'Download', 'File details', 'Rename', 'Move to project…', 'Delete']);
      expect(listBracket).toContain('Generate Thumbnail');

      await user.click(screen.getByTitle('Column view'));
      const columns = within(screen.getByTestId('columns-view'));
      await waitFor(() => expect(columns.getByText('Benchy')).toBeInTheDocument());
      expect(actionTitlesOf(columns.getByText('Benchy').closest('[data-file-id]') as HTMLElement)).toEqual(listBenchy);
      expect(actionTitlesOf(columns.getByText('bracket.stl').closest('[data-file-id]') as HTMLElement)).toEqual(listBracket);
    });

    it('fires a row action without toggling the row selection', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await user.click(screen.getByTitle('Column view'));
      const columns = within(screen.getByTestId('columns-view'));
      const row = columns.getByText('Benchy').closest('[data-file-id]') as HTMLElement;

      await user.click(within(row).getByTitle('Rename'));
      // The rename modal edits the base name; the extension is fixed.
      expect(await screen.findByDisplayValue('benchy')).toBeInTheDocument();
      expect(row.className).not.toContain('bg-bambu-green/10');

      await user.click(screen.getByText('Cancel'));
      await user.click(within(row).getByTitle('Delete'));
      expect(await screen.findByText('Delete File')).toBeInTheDocument();
    });

    it('reveals the focused row\'s actions and keeps the rest touch-reachable (#2865)', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await user.click(screen.getByTitle('Column view'));
      const columns = within(screen.getByTestId('columns-view'));
      const stripWrapper = (name: string) =>
        (columns.getByText(name).closest('[data-file-id]') as HTMLElement).querySelector('[data-file-actions]')!.parentElement!;

      // Right from the root moves the focus into the files pane.
      await user.keyboard('{ArrowRight}');
      await waitFor(() => expect(stripWrapper('Benchy').className).not.toContain('opacity-0'));

      // Other rows hide the strip only for pointers that can hover — never a
      // bare opacity-0 — and stay out of the Tab order.
      expect(stripWrapper('bracket.stl').className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
      expect(stripWrapper('bracket.stl').className).toContain('can-hover:opacity-0');
      expect(within(stripWrapper('bracket.stl')).getByTitle('Download')).toHaveAttribute('tabindex', '-1');
      expect(within(stripWrapper('Benchy')).getByTitle('Download')).toHaveAttribute('tabindex', '0');

      // Tab from the pane lands on the focused row's first action.
      await user.tab();
      expect(document.activeElement).toBe(within(stripWrapper('Benchy')).getByTitle('Print'));
    });

    it('reaches and triggers the focused file\'s actions from the keyboard', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await user.click(screen.getByTitle('Column view'));
      const columns = within(screen.getByTestId('columns-view'));
      await user.keyboard('{ArrowRight}');
      await waitFor(() => {
        expect(columns.getByText('Benchy').closest('[title="Benchy"]')?.className).toContain('ring-1');
      });
      const row = columns.getByText('Benchy').closest('[data-file-id]') as HTMLElement;

      // The context-menu key jumps into the strip; Left/Right walk it.
      await user.keyboard('{ContextMenu}');
      expect(document.activeElement).toBe(within(row).getByTitle('Print'));
      await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
      expect(document.activeElement).toBe(within(row).getByTitle('File details'));
      await user.keyboard('{ArrowLeft}');
      expect(document.activeElement).toBe(within(row).getByTitle('Download'));

      // Escape hands focus back to the pane, so the arrows walk rows again.
      await user.keyboard('{Escape}');
      expect(document.activeElement).toBe(screen.getByTestId('columns-view'));
      await user.keyboard('{ArrowDown}');
      await waitFor(() => {
        expect(columns.getByText('bracket.stl').closest('[title="bracket.stl"]')?.className).toContain('ring-1');
      });

      // Enter on a strip button activates that button, not the row.
      await user.keyboard('{Shift>}{F10}{/Shift}');
      const bracketRow = columns.getByText('bracket.stl').closest('[data-file-id]') as HTMLElement;
      expect(document.activeElement?.closest('[data-file-id]')).toBe(bracketRow);
      within(bracketRow).getByTitle('Rename').focus();
      await user.keyboard('{Enter}');
      // .stl is not a split-off extension, so the whole name is editable.
      expect(await screen.findByDisplayValue('bracket.stl')).toBeInTheDocument();
    });

    it('offers the tree\'s folder actions on folder rows', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await user.click(screen.getByTitle('Column view'));
      const columns = within(screen.getByTestId('columns-view'));
      const row = columns.getByText('Art Projects').closest('[data-folder-id]') as HTMLElement;
      const kebab = within(row).getByTitle('Actions');
      // Unselected row: kebab hidden only for pointers that can hover (#2865).
      expect(kebab.closest('.flex-shrink-0')!.className).toContain('can-hover:opacity-0');

      await user.click(kebab);
      expect(within(row).getByRole('button', { name: 'Rename' })).toBeInTheDocument();
      // Art Projects is linked to a project, so the link entry offers a change.
      expect(within(row).getByRole('button', { name: 'Change Link...' })).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
      // Opening the menu did not select the folder.
      expect(row.className).not.toContain('bg-bambu-green/20');

      await user.click(within(row).getByRole('button', { name: 'Rename' }));
      expect(await screen.findByDisplayValue('Art Projects')).toBeInTheDocument();
    });

    it('opens the selected folder\'s kebab from the keyboard', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await user.click(screen.getByTitle('Column view'));
      const columns = within(screen.getByTestId('columns-view'));
      await user.keyboard('{ArrowDown}');
      const row = columns.getByText('Art Projects').closest('[data-folder-id]') as HTMLElement;
      await waitFor(() => expect(row.className).toContain('bg-bambu-green/20'));
      // The selected row's kebab is the only folder control in the Tab order.
      expect(within(row).getByTitle('Actions')).toHaveAttribute('tabindex', '0');
      expect(
        within(columns.getByText('Functional Parts').closest('[data-folder-id]') as HTMLElement).getByTitle('Actions'),
      ).toHaveAttribute('tabindex', '-1');

      await user.keyboard('{ContextMenu}');
      expect(within(row).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    });

    it('closes the folder kebab menu on a second click and keeps it opaque while open', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await user.click(screen.getByTitle('Column view'));
      const columns = within(screen.getByTestId('columns-view'));
      const row = columns.getByText('Art Projects').closest('[data-folder-id]') as HTMLElement;
      const kebab = within(row).getByTitle('Actions');
      const wrapper = kebab.closest('[data-folder-actions]') as HTMLElement;
      expect(wrapper.className).toContain('can-hover:opacity-0');

      await user.click(kebab);
      expect(within(row).getByRole('button', { name: 'Rename' })).toBeInTheDocument();
      // The menu is a descendant of the hover-revealed wrapper: while it is
      // open the wrapper must not depend on hover/focus to stay visible.
      expect(wrapper.className).not.toContain('opacity-0');

      await user.click(kebab);
      expect(within(row).queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
      expect(wrapper.className).toContain('can-hover:opacity-0');
    });

    it('hands focus back to the pane after the folder kebab', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await user.click(screen.getByTitle('Column view'));
      const columns = within(screen.getByTestId('columns-view'));
      await user.keyboard('{ArrowDown}');
      const artRow = columns.getByText('Art Projects').closest('[data-folder-id]') as HTMLElement;
      const functionalRow = columns.getByText('Functional Parts').closest('[data-folder-id]') as HTMLElement;
      await waitFor(() => expect(artRow.className).toContain('bg-bambu-green/20'));

      // Escape closes the menu and returns focus to the pane, so the arrows
      // keep walking rows instead of dying on the kebab.
      await user.keyboard('{ContextMenu}');
      expect(within(artRow).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
      expect(document.activeElement).toBe(within(artRow).getByTitle('Actions'));
      await user.keyboard('{Escape}');
      expect(within(artRow).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
      expect(document.activeElement).toBe(screen.getByTestId('columns-view'));
      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(functionalRow.className).toContain('bg-bambu-green/20'));
      await user.keyboard('{ArrowUp}');
      await waitFor(() => expect(artRow.className).toContain('bg-bambu-green/20'));

      // Down straight out of an open menu closes it and moves the selection.
      await user.keyboard('{ContextMenu}');
      expect(within(artRow).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
      await user.keyboard('{ArrowDown}');
      expect(within(artRow).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
      await waitFor(() => expect(functionalRow.className).toContain('bg-bambu-green/20'));
      expect(document.activeElement).toBe(screen.getByTestId('columns-view'));

      // Activating an entry with Enter must not strand focus on <body>.
      await user.keyboard('{ContextMenu}');
      await user.tab();
      expect(document.activeElement).toBe(within(functionalRow).getByRole('button', { name: 'Rename' }));
      await user.keyboard('{Enter}');
      expect(await screen.findByDisplayValue('Functional Parts')).toBeInTheDocument();
      expect(document.activeElement).not.toBe(document.body);
    });

    it('does not open the row preview when a strip icon is double-clicked', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await user.click(screen.getByTitle('Column view'));
      const columns = within(screen.getByTestId('columns-view'));
      const row = columns.getByText('bracket.stl').closest('[data-file-id]') as HTMLElement;

      await user.dblClick(within(row).getByTitle('Rename'));
      expect(await screen.findByDisplayValue('bracket.stl')).toBeInTheDocument();
      expect(screen.queryByTestId('model-viewer-modal')).not.toBeInTheDocument();

      // The row itself still opens the viewer.
      await user.click(screen.getByText('Cancel'));
      await user.dblClick(columns.getByText('bracket.stl'));
      expect(await screen.findByTestId('model-viewer-modal')).toBeInTheDocument();
    });

    // Every column is that level's contents, folders AND files. Before this a
    // folder holding files but no subfolders looked empty until it was the
    // selection.
    const descendToBrackets = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByTitle('Column view'));
      const columns = within(screen.getByTestId('columns-view'));
      await user.click(columns.getByText('Functional Parts'));
      await user.click(await columns.findByText('Brackets'));
      return columns;
    };

    it('lists an intermediate level\'s folders and its files in the same column', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await descendToBrackets(user);

      const level = within(screen.getByTestId('columns-level-folder-1'));
      expect(level.getByText('Brackets')).toBeInTheDocument();
      await waitFor(() => expect(level.getByText('Spacer')).toBeInTheDocument());

      // The root column lists the files that sit in no folder at all.
      const root = within(screen.getByTestId('columns-level-root'));
      await waitFor(() => expect(root.getByText('Benchy')).toBeInTheDocument());
      expect(root.getByText('Functional Parts')).toBeInTheDocument();
    });

    it('focuses a file in an intermediate column without moving the folder selection', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await descendToBrackets(user);
      const pane = within(screen.getByTestId('columns-files-pane'));
      await waitFor(() => expect(pane.getByText('clamp.stl')).toBeInTheDocument());

      const level = within(screen.getByTestId('columns-level-folder-1'));
      await user.click(await level.findByText('Spacer'));

      expect(level.getByText('Spacer').closest('[data-file-id]')?.className).toContain('ring-1');
      // Brackets is still the selection: its own files still fill the pane.
      expect(pane.getByText('clamp.stl')).toBeInTheDocument();
      expect(level.getByText('Brackets').closest('[data-folder-id]')?.className).toContain('bg-bambu-green/20');
    });

    it('opens the preview on double-click from an intermediate column', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await descendToBrackets(user);
      const level = within(screen.getByTestId('columns-level-folder-1'));
      await user.dblClick(await level.findByText('Spacer'));

      expect(await screen.findByTestId('model-viewer-modal')).toBeInTheDocument();
    });

    it('keeps a level\'s folders visible while its files are still loading', async () => {
      const user = userEvent.setup();
      server.use(
        http.get('/api/v1/library/files', async ({ request }) => {
          if (new URL(request.url).searchParams.get('folder_id') === '1') {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          return HttpResponse.json(filesForRequest(request));
        })
      );
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await descendToBrackets(user);

      // The column paints its folders straight away and marks the pending file
      // list instead of blocking.
      const level = within(screen.getByTestId('columns-level-folder-1'));
      expect(level.getByText('Brackets')).toBeInTheDocument();
      expect(level.getByText('…')).toBeInTheDocument();
      await waitFor(() => expect(level.getByText('Spacer')).toBeInTheDocument());
    });

    it('leaves the rightmost pane as a leaf folder\'s contents', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await user.click(screen.getByTitle('Column view'));
      const columns = within(screen.getByTestId('columns-view'));
      await user.click(columns.getByText('Art Projects'));

      const pane = within(screen.getByTestId('columns-files-pane'));
      await waitFor(() => expect(pane.getByText('Vase')).toBeInTheDocument());
      // A leaf contributes no column of its own.
      expect(screen.queryByTestId('columns-level-folder-3')).not.toBeInTheDocument();
    });

    it('walks from a column\'s last folder into that column\'s files and back', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await descendToBrackets(user);
      const level = within(screen.getByTestId('columns-level-folder-1'));
      await waitFor(() => expect(level.getByText('Spacer')).toBeInTheDocument());
      screen.getByTestId('columns-view').focus();
      const spacerRow = () => level.getByText('Spacer').closest('[data-file-id]') as HTMLElement;

      // Brackets is the column's only folder, so the next row down is the
      // column's first file: the only way a keyboard reaches it at all.
      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(spacerRow().className).toContain('ring-1'));

      // Up steps back onto the folder, which stayed the selection throughout.
      await user.keyboard('{ArrowUp}');
      await waitFor(() => expect(spacerRow().className).not.toContain('ring-1'));
      expect(level.getByText('Brackets').closest('[data-folder-id]')?.className).toContain('bg-bambu-green/20');
    });

    it('keeps the selection\'s count and actions while the selected folder\'s own pane is empty', async () => {
      const user = userEvent.setup();
      server.use(
        http.get('/api/v1/library/files', ({ request }) =>
          HttpResponse.json(new URL(request.url).searchParams.get('folder_id') === '2' ? [] : filesForRequest(request))
        )
      );
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await descendToBrackets(user);
      const level = within(screen.getByTestId('columns-level-folder-1'));
      await user.click(await level.findByText('Spacer'));

      // Brackets lists nothing, yet a file ticked one column to the left still
      // gets its count, its bulk actions and a way to clear it.
      expect(await screen.findByText('1 selected')).toBeInTheDocument();
      await user.click(screen.getByText('Clear'));
      await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
    });

    it('drops the selection when another folder is selected', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await descendToBrackets(user);
      const level = within(screen.getByTestId('columns-level-folder-1'));
      await user.click(await level.findByText('Spacer'));
      expect(await screen.findByText('1 selected')).toBeInTheDocument();

      // Move or Delete must never act on rows that have left the screen.
      await user.click(within(screen.getByTestId('columns-level-root')).getByText('Art Projects'));
      await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
    });

    it('lists only the files in no folder beside the root column, like every other level', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      // Grid view at the root is "All Files", which descends into the folders.
      await waitFor(() => expect(screen.getByText('Spacer')).toBeInTheDocument());

      await user.click(screen.getByTitle('Column view'));

      // The root level's own files, the same ones its column lists once a
      // folder is selected — nothing from inside a folder.
      const pane = within(await screen.findByTestId('columns-files-pane'));
      await waitFor(() => expect(pane.getByText('Benchy')).toBeInTheDocument());
      expect(pane.queryByText('Spacer')).not.toBeInTheDocument();
      expect(pane.queryByText('Vase')).not.toBeInTheDocument();
    });

    it('says the root has no files outside folders, not that the library is empty', async () => {
      const user = userEvent.setup();
      // Every file sits in a folder: the root level's own list is empty.
      server.use(
        http.get('/api/v1/library/files', ({ request }) =>
          HttpResponse.json(
            new URL(request.url).searchParams.get('include_root') === 'true'
              ? []
              : Object.values(mockFolderFiles).flat()
          )
        )
      );
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Spacer')).toBeInTheDocument());

      await user.click(screen.getByTitle('Column view'));

      const pane = within(await screen.findByTestId('columns-files-pane'));
      expect(await pane.findByText('No files outside folders')).toBeInTheDocument();
      expect(pane.queryByText('No files yet')).not.toBeInTheDocument();
    });

    it('offers the toolbar actions for files ticked in an earlier column', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await descendToBrackets(user);
      const root = within(screen.getByTestId('columns-level-root'));
      await user.click(await root.findByText('Benchy'));

      // One sliced file ticked in the root column, while the pane lists
      // Brackets: it can still be previewed and printed.
      const toolbar = () => screen.getByText(/\d selected/).closest('div') as HTMLElement;
      expect(await screen.findByText('1 selected')).toBeInTheDocument();
      expect(within(toolbar()).getByRole('button', { name: 'Preview' })).toBeInTheDocument();
      expect(within(toolbar()).getByRole('button', { name: 'Print' })).toBeInTheDocument();

      // A second one makes it one job for either file.
      await user.click(root.getByText('Cube'));
      expect(await within(toolbar()).findByRole('button', { name: 'Print (2 alternatives)' })).toBeInTheDocument();
    });

    it('offers Combine to 3MF for STLs ticked across columns', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await descendToBrackets(user);
      // bracket.stl sits in the root column, clamp.stl in the Brackets pane.
      await user.click(await within(screen.getByTestId('columns-level-root')).findByText('bracket.stl'));
      await user.click(await within(screen.getByTestId('columns-files-pane')).findByText('clamp.stl'));

      expect(await screen.findByText('2 selected')).toBeInTheDocument();
      const toolbar = screen.getByText('2 selected').closest('div') as HTMLElement;
      expect(within(toolbar).getByRole('button', { name: 'Combine to 3MF' })).toBeInTheDocument();
    });

    it('offers Select All until every file of the pane is ticked, and keeps other ticks', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await descendToBrackets(user);
      await user.click(await within(screen.getByTestId('columns-level-folder-1')).findByText('Spacer'));
      await user.click(await within(screen.getByTestId('columns-files-pane')).findByText('clamp.stl'));

      // Two ticked, but only one of the pane's two files.
      expect(await screen.findByText('2 selected')).toBeInTheDocument();
      expect(screen.getByText('Select All')).toBeInTheDocument();

      await user.click(screen.getByText('Select All'));

      expect(await screen.findByText('3 selected')).toBeInTheDocument();
      expect(screen.getByText('Deselect All')).toBeInTheDocument();
    });

    it('shows a document\'s type icon in place of a missing thumbnail', async () => {
      const user = userEvent.setup();
      server.use(
        http.get('/api/v1/library/files', ({ request }) =>
          HttpResponse.json(
            new URL(request.url).searchParams.get('folder_id')
              ? filesForRequest(request)
              : [...mockFiles, { ...mockFiles[0], id: 99, filename: 'manual.pdf', file_type: 'pdf', print_name: null, thumbnail_path: null }]
          )
        )
      );
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      await user.click(screen.getByTitle('Column view'));
      const pane = within(screen.getByTestId('columns-files-pane'));
      const pdfRow = (await pane.findByText('manual.pdf')).closest('[data-file-id]') as HTMLElement;
      // The thumbnail slot, not the action strip (whose preview button uses
      // the same icon for a PDF).
      const thumbnailSlot = pdfRow.querySelector('.w-10.h-10') as HTMLElement;
      expect(thumbnailSlot.querySelector('.lucide-file-text')).not.toBeNull();
      expect(thumbnailSlot.querySelector('.lucide-file-box')).toBeNull();
    });
  });

  describe('search and filter', () => {
    it('has search input', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search files...')).toBeInTheDocument();
      });
    });

    it('has type filter', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('All types')).toBeInTheDocument();
      });
    });

    it('has sort options', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        // Sort dropdown should show Name as default option (persisted to localStorage)
        expect(screen.getByDisplayValue('Name')).toBeInTheDocument();
      });
    });
  });

  describe('selection', () => {
    it('shows select all button', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Select All')).toBeInTheDocument();
      });
    });

    it('can select files', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });

      // Click on the file card to select it
      const fileCard = screen.getByText('Benchy').closest('div[class*="cursor-pointer"]');
      if (fileCard) {
        await user.click(fileCard);
      }

      await waitFor(() => {
        expect(screen.getByText('1 selected')).toBeInTheDocument();
      });
    });

    it('Select All replaces a selection the search has hidden in the grid', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      const benchyCard = screen.getByText('Benchy').closest('div[class*="cursor-pointer"]');
      expect(benchyCard).not.toBeNull();
      await user.click(benchyCard!);
      expect(await screen.findByText('1 selected')).toBeInTheDocument();

      // Benchy leaves the screen; Select All must not keep it ticked, or a
      // bulk Delete would remove a file nobody can see.
      await user.type(screen.getByPlaceholderText('Search files...'), 'vase');
      await waitFor(() => expect(screen.queryByText('Benchy')).not.toBeInTheDocument());
      await user.click(screen.getByText('Select All'));

      expect(await screen.findByText('1 selected')).toBeInTheDocument();
      expect(screen.getByText('Deselect All')).toBeInTheDocument();
    });

    it('shows bulk actions when files selected', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Select All')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Select All'));

      await waitFor(() => {
        expect(screen.getByText('Move')).toBeInTheDocument();
        expect(screen.getByText('Delete')).toBeInTheDocument();
      });
    });
  });

  describe('new folder modal', () => {
    it('opens new folder modal', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('New Folder')).toBeInTheDocument();
      });

      await user.click(screen.getByText('New Folder'));

      await waitFor(() => {
        expect(screen.getByText('Folder Name')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('e.g., Functional Parts')).toBeInTheDocument();
      });
    });

    it('can create a folder', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('New Folder')).toBeInTheDocument();
      });

      await user.click(screen.getByText('New Folder'));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g., Functional Parts')).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText('e.g., Functional Parts');
      await user.type(input, 'My New Folder');

      const createButton = screen.getByRole('button', { name: 'Create' });
      await user.click(createButton);

      // Modal should close after creation
      await waitFor(() => {
        expect(screen.queryByText('Folder Name')).not.toBeInTheDocument();
      });
    });
  });

  describe('empty state', () => {
    it('shows empty state when no files', async () => {
      server.use(
        http.get('/api/v1/library/files', () => {
          return HttpResponse.json([]);
        })
      );

      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('No files yet')).toBeInTheDocument();
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });
    });
  });

  describe('bulk-action print button', () => {
    // PR #1625 consolidated print actions: the old single-file-selected
    // "Schedule" button now opens the unified PrintModal (which carries
    // schedule options inside). The bulk-action toolbar shows a single
    // "Print" button only when exactly one sliced file is selected, and
    // hides it for multi-selection. The button is targeted by its accessible
    // name ("Print") + role to disambiguate from the file-card dropdown's
    // own Print entry, which stays collapsed unless its kebab is opened.
    it('shows a Print button in the bulk toolbar when one sliced file is selected', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });

      // Select a sliced file (benchy.gcode.3mf) by clicking on its card
      const fileCard = screen.getByText('Benchy').closest('div[class*="cursor-pointer"]');
      if (fileCard) {
        await user.click(fileCard);
      }

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Print$/ })).toBeInTheDocument();
      });
    });

    it('hides the bulk Print button when multiple files are selected', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Select All')).toBeInTheDocument();
      });

      // Select all files
      await user.click(screen.getByText('Select All'));

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /^Print$/ })).not.toBeInTheDocument();
      });
    });
  });

  describe('move files', () => {
    // Select all 3 mock files, open the move modal, pick "Functional Parts"
    // as the target, and confirm — leaving the mocked POST response (set up
    // per-test via server.use) to drive the toast assertions below.
    const selectAllAndConfirmMove = async (user: ReturnType<typeof userEvent.setup>) => {
      // Just the three root files: the default handler also returns the
      // per-folder files for an "All Files" listing.
      server.use(pagedFilesHandler(mockFiles));
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Select All')).toBeInTheDocument();
      });
      await user.click(screen.getByText('Select All'));

      await waitFor(() => {
        expect(screen.getByText('3 selected')).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: 'Move' }));

      let modal: HTMLElement;
      await waitFor(() => {
        const heading = screen.getByText('Move 3 File(s)');
        modal = heading.closest('.animate-modal-in') as HTMLElement;
        expect(modal).toBeInTheDocument();
      });
      await user.click(within(modal!).getByText('Functional Parts'));
      await user.click(within(modal!).getByRole('button', { name: 'Move' }));
    };

    it('shows the plain success toast when nothing is skipped', async () => {
      server.use(
        http.post('/api/v1/library/files/move', () => {
          return HttpResponse.json({ status: 'success', moved: 3, skipped: 0, skipped_reasons: [] });
        })
      );
      const user = userEvent.setup();

      await selectAllAndConfirmMove(user);

      await waitFor(() => {
        expect(screen.getByText('Files moved')).toBeInTheDocument();
      });
      // Selection cleared and modal closed, same as before this change.
      expect(screen.queryByText('Move 3 File(s)')).not.toBeInTheDocument();
      expect(screen.queryByText('3 selected')).not.toBeInTheDocument();
    });

    it('shows a warning toast naming skipped files and reasons when some files are skipped', async () => {
      server.use(
        http.post('/api/v1/library/files/move', () => {
          return HttpResponse.json({
            status: 'success',
            moved: 2,
            skipped: 3,
            skipped_reasons: [
              { file_id: 1, code: 'name_collision', reason: 'a file named "x" already exists in target' },
              { file_id: 2, code: 'name_collision', reason: 'a file named "y" already exists in target' },
              { file_id: 3, code: 'source_missing', reason: 'source file missing on disk' },
            ],
          });
        })
      );
      const user = userEvent.setup();

      await selectAllAndConfirmMove(user);

      await waitFor(() => {
        expect(
          screen.getByText('2 moved, 3 skipped: 2 filename collision, 1 file no longer on disk')
        ).toBeInTheDocument();
      });
      expect(screen.queryByText('Files moved')).not.toBeInTheDocument();
      // Selection cleared and modal closed exactly as the success path does.
      expect(screen.queryByText('Move 3 File(s)')).not.toBeInTheDocument();
      expect(screen.queryByText('3 selected')).not.toBeInTheDocument();
    });
  });

  describe('STL thumbnail generation', () => {
    it('shows Generate Thumbnails button', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Generate Thumbnails')).toBeInTheDocument();
      });
    });

    it('Generate Thumbnails button has correct title', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        const button = screen.getByTitle('Generate thumbnails for STL and PDF files missing them');
        expect(button).toBeInTheDocument();
      });
    });

    it('can click Generate Thumbnails button', async () => {
      const user = userEvent.setup();

      server.use(
        http.post('/api/v1/library/generate-stl-thumbnails', () => {
          return HttpResponse.json({
            processed: 1,
            succeeded: 1,
            failed: 0,
            results: [{ file_id: 2, success: true }],
          });
        })
      );

      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Generate Thumbnails')).toBeInTheDocument();
      });

      const button = screen.getByText('Generate Thumbnails');
      await user.click(button);

      // Button should work without error
      await waitFor(() => {
        expect(screen.getByText('Generate Thumbnails')).toBeInTheDocument();
      });
    });

    it('shows STL file without thumbnail in file list', async () => {
      render(<FileManagerPage />);

      await waitFor(() => {
        // bracket.stl has no thumbnail_path
        expect(screen.getByText('bracket.stl')).toBeInTheDocument();
        expect(screen.getAllByText('STL').length).toBeGreaterThan(0);
      });
    });

    // Since #2976 the server renders PDF thumbnails too, so the per-file
    // action is offered for PDFs and stays hidden for types it cannot render.
    describe('per-file action for PDFs', () => {
      const pdfFile = {
        id: 40,
        filename: 'drawing.pdf',
        file_path: '/library/drawing.pdf',
        file_size: 4096,
        file_type: 'pdf',
        folder_id: null,
        thumbnail_path: null,
        print_name: null,
        print_time_seconds: null,
        print_count: 0,
        duplicate_count: 0,
        created_at: '2024-01-04T00:00:00Z',
      };
      const stepFile = { ...pdfFile, id: 41, filename: 'part.step', file_path: '/library/part.step', file_type: 'step' };

      beforeEach(() => {
        server.use(
          http.get('/api/v1/library/files', () => HttpResponse.json([...mockFiles, pdfFile, stepFile])),
        );
      });

      const openMenu = async (user: ReturnType<typeof userEvent.setup>, filename: string) => {
        const card = screen.getByText(filename).closest('.group') as HTMLElement;
        const kebab = card.querySelector('.lucide-ellipsis-vertical')?.closest('button') as HTMLButtonElement;
        await user.click(kebab);
        return card;
      };

      it('offers Generate Thumbnail in the card menu of a PDF', async () => {
        const user = userEvent.setup();
        server.use(
          http.post('/api/v1/library/generate-stl-thumbnails', async ({ request }) => {
            const body = (await request.json()) as { file_ids?: number[] };
            return HttpResponse.json({
              processed: 1,
              succeeded: 1,
              failed: 0,
              results: [{ file_id: body.file_ids?.[0], success: true }],
            });
          })
        );
        render(<FileManagerPage />);
        await waitFor(() => expect(screen.getByText('drawing.pdf')).toBeInTheDocument());

        const card = await openMenu(user, 'drawing.pdf');
        await user.click(within(card).getByText('Generate Thumbnail'));

        expect(await screen.findByText('Thumbnail generated')).toBeInTheDocument();
      });

      it('does not offer it for STEP, which only the browser can render', async () => {
        const user = userEvent.setup();
        render(<FileManagerPage />);
        await waitFor(() => expect(screen.getByText('part.step')).toBeInTheDocument());

        const card = await openMenu(user, 'part.step');
        expect(within(card).queryByText('Generate Thumbnail')).not.toBeInTheDocument();
      });

      it('offers the action in the list view strip of a PDF', async () => {
        const user = userEvent.setup();
        render(<FileManagerPage />);
        await waitFor(() => expect(screen.getByText('drawing.pdf')).toBeInTheDocument());

        await user.click(screen.getByRole('button', { name: /list/i }));

        // List rows are CSS grids; the row is the nearest grid ancestor.
        await waitFor(() => {
          const row = screen.getByText('drawing.pdf').closest('.grid') as HTMLElement;
          expect(within(row).getByTitle('Generate Thumbnail')).toBeInTheDocument();
        });
        const stepRow = screen.getByText('part.step').closest('.grid') as HTMLElement;
        expect(within(stepRow).queryByTitle('Generate Thumbnail')).not.toBeInTheDocument();
      });
    });
  });

  describe('upload modal (FileUploadModal)', () => {
    it('opens upload modal when Upload button is clicked', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
        expect(screen.getByText(/Drag & drop/)).toBeInTheDocument();
      });
    });

    it('closes upload modal when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => {
        expect(screen.queryByText('Upload Files')).not.toBeInTheDocument();
      });
    });

    it('shows 3MF extraction info when 3MF file is added', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });

      const threemfFile = new File(['content'], 'model.gcode.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();

      await user.upload(fileInput, threemfFile);

      await waitFor(() => {
        expect(screen.getByText('3MF files detected')).toBeInTheDocument();
        expect(screen.getByText(/Printer model.*will be automatically extracted/i)).toBeInTheDocument();
      });
    });

    it('shows STL thumbnail option when STL file is added', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });

      const stlFile = new File(['solid test'], 'model.stl', { type: 'application/sla' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();

      await user.upload(fileInput, stlFile);

      await waitFor(() => {
        expect(screen.getByText('STL thumbnail generation')).toBeInTheDocument();
        expect(screen.getByText(/Thumbnails can be generated/i)).toBeInTheDocument();
      });
    });

    it('shows ZIP options when ZIP file is added', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });

      const zipFile = new File(['pk'], 'models.zip', { type: 'application/zip' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, zipFile);

      await waitFor(() => {
        expect(screen.getByText('ZIP files detected')).toBeInTheDocument();
        expect(screen.getByText(/Preserve folder structure/)).toBeInTheDocument();
      });
    });

    it('can add a file via the file input', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });

      const file = new File(['content'], 'model.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(screen.getByText('model.3mf')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Upload \(1\)/i })).toBeInTheDocument();
      });
    });

    it('uploads file and refreshes file list', async () => {
      server.use(
        http.post('/api/v1/library/files', () => {
          return HttpResponse.json({
            id: 10,
            filename: 'uploaded.3mf',
            file_type: '3mf',
            file_size: 1024,
            thumbnail_path: null,
            duplicate_of: null,
            metadata: null,
          });
        })
      );

      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Upload'));

      await waitFor(() => {
        expect(screen.getByText('Upload Files')).toBeInTheDocument();
      });

      const file = new File(['content'], 'uploaded.3mf', { type: 'application/octet-stream' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(fileInput, file);

      const uploadButton = screen.getByRole('button', { name: /Upload \(1\)/i });
      await user.click(uploadButton);

      // Modal should auto-close after upload completes
      await waitFor(() => {
        expect(screen.queryByText('Upload Files')).not.toBeInTheDocument();
      });
    });
  });

  describe('authentication-based UI changes', () => {
    it('hides "Uploaded By" column and user filter when auth is disabled', async () => {
      // Mock auth disabled (default)
      server.use(
        http.get('*/api/v1/auth/status', () => {
          return HttpResponse.json({
            auth_enabled: false,
            requires_setup: false,
          });
        }),
        http.get('/api/v1/library/files', () => {
          return HttpResponse.json([
            {
              id: 1,
              filename: 'test.3mf',
              file_path: '/library/test.3mf',
              file_size: 1048576,
              file_type: '3mf',
              folder_id: null,
              thumbnail_path: null,
              print_name: 'Test File',
              print_time_seconds: 3600,
              print_count: 0,
              duplicate_count: 0,
              created_at: '2024-01-01T00:00:00Z',
              created_by_username: 'testuser',
            },
          ]);
        })
      );

      render(<FileManagerPage />);

      // Switch to list view to see the column headers
      await waitFor(() => {
        expect(screen.getByText('Test File')).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const listViewButton = screen.getByRole('button', { name: /list/i });
      await user.click(listViewButton);

      // "Uploaded By" column header should not be present
      await waitFor(() => {
        expect(screen.queryByText('Uploaded By')).not.toBeInTheDocument();
      });

      // User filter dropdown should not be present
      expect(screen.queryByPlaceholderText('Filter by user')).not.toBeInTheDocument();

      // #3105: the logged-out column set needs the same floors as the
      // authenticated one, minus the Uploaded By track.
      const header = screen.getByTestId('file-list-grid-header');
      const rows = screen.getAllByTestId('file-list-grid-row');
      for (const el of [header, ...rows]) {
        expect(el).toHaveClass('min-w-min');
        expect(el.className).toContain('grid-cols-[24px_minmax(240px,1fr)_100px_100px_100px_minmax(96px,200px)_220px]');
      }
    });

    it('shows "Uploaded By" column and user filter when auth is enabled', async () => {
      // Mock auth enabled
      server.use(
        http.get('*/api/v1/auth/status', () => {
          return HttpResponse.json({
            auth_enabled: true,
            requires_setup: false,
          });
        }),
        http.get('/api/v1/library/files', () => {
          return HttpResponse.json([
            {
              id: 1,
              filename: 'test.3mf',
              file_path: '/library/test.3mf',
              file_size: 1048576,
              file_type: '3mf',
              folder_id: null,
              thumbnail_path: null,
              print_name: 'Test File',
              print_time_seconds: 3600,
              print_count: 0,
              duplicate_count: 0,
              created_at: '2024-01-01T00:00:00Z',
              created_by_username: 'testuser',
            },
          ]);
        }),
        http.get('/api/v1/users/', () => {
          return HttpResponse.json([
            { id: 1, username: 'testuser' },
            { id: 2, username: 'admin' },
          ]);
        })
      );

      render(<FileManagerPage />);

      // Switch to list view to see the column headers
      await waitFor(() => {
        expect(screen.getByText('Test File')).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const listViewButton = screen.getByRole('button', { name: /list/i });
      await user.click(listViewButton);

      // "Uploaded By" column header should be present
      await waitFor(() => {
        expect(screen.getByText('Uploaded By')).toBeInTheDocument();
      });

      // User filter dropdown should be present
      expect(screen.getByPlaceholderText('Filter by user')).toBeInTheDocument();

      // Username should be displayed in the column
      expect(screen.getByText('testuser')).toBeInTheDocument();

      // #3105: the authenticated grid has enough fixed-width columns to
      // squeeze a bare 1fr filename track to zero. Header and rows must share
      // the same minimum width and non-collapsible filename and tags tracks
      // so the existing overflow wrapper scrolls instead.
      const header = screen.getByTestId('file-list-grid-header');
      const rows = screen.getAllByTestId('file-list-grid-row');
      for (const el of [header, ...rows]) {
        expect(el).toHaveClass('min-w-min');
        expect(el.className).toContain('grid-cols-[24px_minmax(240px,1fr)_120px_100px_100px_100px_minmax(96px,200px)_220px]');
      }
    });
  });

  describe('folder tree collapse preference (#996)', () => {
    // localStorage is globally mocked in setup.ts (returns undefined by default),
    // so we program each test's getItem return value explicitly.
    const getItemMock = localStorage.getItem as ReturnType<typeof vi.fn>;
    const setItemMock = localStorage.setItem as ReturnType<typeof vi.fn>;

    beforeEach(() => {
      getItemMock.mockReset();
      setItemMock.mockReset();
    });

    // The mock is module-global, so an implementation left behind here would
    // silently change every later describe (e.g. collapsing the folder tree).
    afterEach(() => {
      getItemMock.mockReset();
      setItemMock.mockReset();
    });

    it('defaults to expanded (nested folders visible) when library-collapse-folders is unset', async () => {
      getItemMock.mockReturnValue(null);
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Functional Parts')).toBeInTheDocument();
      });
      expect(screen.getByText('Brackets')).toBeInTheDocument();
    });

    it('honors library-collapse-folders=true on load (nested folders hidden)', async () => {
      getItemMock.mockImplementation((key: string) =>
        key === 'library-collapse-folders' ? 'true' : null
      );
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Functional Parts')).toBeInTheDocument();
      });
      expect(screen.queryByText('Brackets')).not.toBeInTheDocument();
    });

    it('collapses nested folders and persists preference when Collapse is clicked', async () => {
      getItemMock.mockReturnValue(null);
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Brackets')).toBeInTheDocument();
      });

      // The Collapse button sits next to Wrap in the sidebar header.
      // Its text content is "Collapse" (from fileManager.collapse).
      await user.click(screen.getByRole('button', { name: 'Collapse' }));

      await waitFor(() => {
        expect(screen.queryByText('Brackets')).not.toBeInTheDocument();
      });
      expect(setItemMock).toHaveBeenCalledWith('library-collapse-folders', 'true');
    });

    it('re-expands nested folders and persists preference when Collapse is toggled off', async () => {
      getItemMock.mockImplementation((key: string) =>
        key === 'library-collapse-folders' ? 'true' : null
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Functional Parts')).toBeInTheDocument();
      });
      expect(screen.queryByText('Brackets')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Collapse' }));

      await waitFor(() => {
        expect(screen.getByText('Brackets')).toBeInTheDocument();
      });
      expect(setItemMock).toHaveBeenCalledWith('library-collapse-folders', 'false');
    });
  });

  describe('Internal / External top-level views (#1621)', () => {
    const externalMockFolders = [
      ...mockFolders,
      {
        id: 99,
        name: 'NAS Library',
        parent_id: null,
        file_count: 200,
        project_id: null,
        archive_id: null,
        project_name: null,
        archive_name: null,
        is_external: true,
        external_readonly: false,
        external_path: '/mnt/nas',
        children: [],
      },
    ];

    it('shows the External sidebar entry only when at least one external folder is linked', async () => {
      // Default mockFolders have no is_external entries → no External row.
      const { unmount } = render(<FileManagerPage />);
      await waitFor(() => {
        expect(screen.getByText('All Files')).toBeInTheDocument();
      });
      expect(screen.queryByText('External')).not.toBeInTheDocument();
      unmount();

      // With an external folder linked, the row appears.
      server.use(
        http.get('/api/v1/library/folders', () => HttpResponse.json(externalMockFolders)),
      );
      render(<FileManagerPage />);
      await waitFor(() => {
        expect(screen.getByText('External')).toBeInTheDocument();
      });
    });

    it('sends internal_only=true by default ("All Files" = managed storage only)', async () => {
      const scopes: string[] = [];
      server.use(
        http.get('/api/v1/library/folders', () => HttpResponse.json(externalMockFolders)),
        http.get('/api/v1/library/files', ({ request }) => {
          const url = new URL(request.url);
          scopes.push(
            url.searchParams.get('internal_only') === 'true'
              ? 'internal'
              : url.searchParams.get('external_only') === 'true'
                ? 'external'
                : 'all',
          );
          return HttpResponse.json(mockFiles);
        }),
      );

      render(<FileManagerPage />);
      await waitFor(() => {
        expect(scopes).toContain('internal');
      });
    });

    it('switches to external_only=true when the External sidebar entry is clicked', async () => {
      const scopes: string[] = [];
      server.use(
        http.get('/api/v1/library/folders', () => HttpResponse.json(externalMockFolders)),
        http.get('/api/v1/library/files', ({ request }) => {
          const url = new URL(request.url);
          scopes.push(
            url.searchParams.get('internal_only') === 'true'
              ? 'internal'
              : url.searchParams.get('external_only') === 'true'
                ? 'external'
                : 'all',
          );
          return HttpResponse.json([]);
        }),
      );

      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('External')).toBeInTheDocument());

      await user.click(screen.getByText('External'));

      await waitFor(() => {
        expect(scopes).toContain('external');
      });
    });
  });

  describe('"All Files" view (#1499)', () => {
    it('requests every file (include_root=false) so subfolder contents are visible', async () => {
      const rootFile = {
        id: 10,
        filename: 'root-file.3mf',
        file_path: '/library/root-file.3mf',
        file_size: 1024,
        file_type: '3mf',
        folder_id: null,
        thumbnail_path: null,
        print_name: 'Root File',
        print_time_seconds: 0,
        print_count: 0,
        duplicate_count: 0,
        created_at: '2024-01-01T00:00:00Z',
      };
      const nestedFile = {
        ...rootFile,
        id: 11,
        filename: 'nested-file.3mf',
        file_path: '/library/Functional Parts/nested-file.3mf',
        folder_id: 1,
        print_name: 'Nested File',
      };

      const includeRootValues: string[] = [];
      server.use(
        http.get('/api/v1/library/files', ({ request }) => {
          const url = new URL(request.url);
          const includeRoot = url.searchParams.get('include_root');
          includeRootValues.push(includeRoot ?? '');
          // Mirror the backend: include_root=false returns everything; true
          // returns only files with folder_id IS NULL.
          if (includeRoot === 'false') {
            return HttpResponse.json([rootFile, nestedFile]);
          }
          return HttpResponse.json([rootFile]);
        }),
      );

      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Root File')).toBeInTheDocument();
        expect(screen.getByText('Nested File')).toBeInTheDocument();
      });
      // Sanity-check: the buggy call would have sent include_root=true here.
      expect(includeRootValues).toContain('false');
    });
  });

  describe('last-modified date display (#2680)', () => {
    it('is hidden by default and revealed by the toolbar toggle', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Benchy')).toBeInTheDocument();
      });

      // Hidden by default.
      expect(screen.queryByText(/2030/)).not.toBeInTheDocument();

      // Toggle on via the toolbar button.
      await user.click(screen.getByTitle('Show modified dates'));

      // benchy carries fs_modified_at in 2030, which must be preferred over its
      // created_at (2024) — proving the real on-disk mtime drives the display.
      await waitFor(() => {
        expect(screen.getByText(/2030/)).toBeInTheDocument();
      });

      // Toggling off hides it again.
      await user.click(screen.getByTitle('Hide modified dates'));
      await waitFor(() => {
        expect(screen.queryByText(/2030/)).not.toBeInTheDocument();
      });
    });

    it('the same toggle reveals latest activity on folder rows, including nested ones', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => {
        expect(screen.getByText('Functional Parts')).toBeInTheDocument();
      });

      expect(screen.queryByText(/2031/)).not.toBeInTheDocument();

      await user.click(screen.getByTitle('Show modified dates'));

      await waitFor(() => {
        expect(screen.getByText(/2031/)).toBeInTheDocument();
      });
      // Nested folders get it too — the prop must survive the recursion.
      expect(screen.getByText(/2032/)).toBeInTheDocument();

      // A folder with no activity timestamp renders nothing rather than an
      // "Invalid Date" string.
      const artRow = screen.getByText('Art Projects').closest('div.group')!;
      expect(artRow.textContent).not.toMatch(/Invalid/);

      await user.click(screen.getByTitle('Hide modified dates'));
      await waitFor(() => {
        expect(screen.queryByText(/2031/)).not.toBeInTheDocument();
      });
    });
  });

  describe('slice action', () => {
    beforeEach(() => {
      vi.mocked(openInSlicer).mockClear();
      server.use(
        http.post('/api/v1/library/files/:id/slicer-token', () => HttpResponse.json({ token: 'test-token' })),
        // The only sliceable fixture is an STL, and since #3029 the desktop
        // handoff is only offered to a slicer whose protocol handler will
        // actually load one -- Bambu Studio's takes 3MF only. These tests are
        // about the handoff mechanics and the permission gate, not about which
        // slicer, so they run against OrcaSlicer. The Bambu Studio side is
        // covered by its own tests below.
        http.get('/api/v1/settings/', () => HttpResponse.json({ preferred_slicer: 'orcaslicer' })),
      );
    });

    afterEach(() => {
      // Permission tests set a token; clear it so it can't leak into the
      // list-view tests that follow (mirrors FileManagerFolderDelete.test.tsx).
      setAuthToken(null);
    });

    const openMenu = async (user: ReturnType<typeof userEvent.setup>, filename: string) => {
      const card = screen.getByText(filename).closest('.group') as HTMLElement;
      // Target the kebab (ellipsis) toggle specifically rather than the card's
      // first button — a button added ahead of the kebab would otherwise
      // break the menu-opening assumption.
      const kebab = card.querySelector('.lucide-ellipsis-vertical')?.closest('button') as HTMLButtonElement;
      await user.click(kebab);
      return card;
    };

    it('opens the desktop slicer when the slicer API is disabled', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.stl');
      await user.click(within(card).getByText('Slice'));

      await waitFor(() => {
        expect(openInSlicer).toHaveBeenCalledWith(
          expect.stringContaining('/library/files/2/dl/test-token/'),
          'orcaslicer',
        );
      });
    });

    it('opens the in-app SliceModal when the slicer API is enabled', async () => {
      server.use(
        http.get('/api/v1/settings/', () => HttpResponse.json({ use_slicer_api: true })),
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.stl');
      await user.click(within(card).getByText('Slice'));

      expect(await screen.findByTestId('slice-modal')).toBeInTheDocument();
      expect(openInSlicer).not.toHaveBeenCalled();
    });

    // #2846: the menu used to be an absolutely-positioned child of the card,
    // and the card clipped its own overflow. A bare STL card is only about
    // 270px tall -- thumbnail plus name and size -- which is shorter than the
    // seven-entry menu, so the top entry was cut off. That entry is Slice,
    // because Print is suppressed for an unsliced file. A 3MF card carries two
    // more metadata rows and was tall enough, which is why the report said 3MF
    // worked. Nothing about STL was special; the card was just the shortest.
    it('keeps the first menu entry out of the card so it cannot be clipped (#2846)', async () => {
      server.use(
        http.get('/api/v1/settings/', () => HttpResponse.json({ use_slicer_api: true })),
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.stl');
      const menu = within(card).getByText('Slice').closest('.fixed');
      // Viewport-positioned, so no ancestor's overflow can cut it down.
      expect(menu).not.toBeNull();
      expect(within(menu as HTMLElement).getAllByRole('button')[0]).toHaveTextContent('Slice');
      // And the card itself no longer clips what its children draw.
      expect(card.className).not.toContain('overflow-hidden');
    });

    // #3029: Bambu Studio's protocol handler refuses anything that is not a
    // 3MF before it even fetches the URL -- "Download failed, unknown file
    // format." Offering the handoff anyway put an action on an STL card that
    // could only fail, with an error that blamed the file.
    it('hides the desktop handoff for an STL when the target is Bambu Studio', async () => {
      server.use(
        http.get('/api/v1/settings/', () => HttpResponse.json({ preferred_slicer: 'bambu_studio' })),
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.stl');
      expect(within(card).queryByText('Slice')).not.toBeInTheDocument();
    });

    it('honours the open_in_slicer override over the preferred slicer', async () => {
      // The desktop target is its own setting (#1329), so it -- not
      // preferred_slicer, which drives the sidecar -- decides whether an STL
      // can be handed over at all.
      server.use(
        http.get('/api/v1/settings/', () =>
          HttpResponse.json({ preferred_slicer: 'bambu_studio', open_in_slicer: 'orcaslicer' }),
        ),
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.stl');
      await user.click(within(card).getByText('Slice'));

      await waitFor(() => {
        expect(openInSlicer).toHaveBeenCalledWith(expect.any(String), 'orcaslicer');
      });
    });

    it('still offers an STL to the in-app slicer with Bambu Studio as the desktop target', async () => {
      // The restriction is on the URL handoff, not on the file: the sidecar
      // slices an STL regardless of which desktop slicer is configured.
      server.use(
        http.get('/api/v1/settings/', () =>
          HttpResponse.json({ use_slicer_api: true, preferred_slicer: 'bambu_studio' }),
        ),
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.stl');
      await user.click(within(card).getByText('Slice'));

      expect(await screen.findByTestId('slice-modal')).toBeInTheDocument();
    });

    it('hides the slice item for already-sliced files', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      const card = await openMenu(user, 'Benchy');
      expect(within(card).queryByText('Slice')).not.toBeInTheDocument();
    });

    // Permission gating is the security-relevant half of the slice action: the
    // in-app API path needs library:upload, and the desktop handoff mirrors the
    // ownership check the slicer-token endpoint runs — library:read_all or
    // library:read_own. The legacy library:read is deliberately not accepted;
    // it satisfies neither the token endpoint nor the folder listing that gets
    // a user to this page at all.
    const mockAuthUser = (permissions: string[]) => {
      setAuthToken('test-token', 'session');
      server.use(
        http.get('*/api/v1/auth/status', () =>
          HttpResponse.json({ auth_enabled: true, requires_setup: false }),
        ),
        http.get('*/api/v1/auth/me', () =>
          HttpResponse.json({
            id: 7,
            username: 'operator1',
            is_admin: false,
            permissions,
          }),
        ),
        http.get('/api/v1/users/', () => HttpResponse.json([])),
      );
    };

    it('disables the Slice menu item without library:upload when the slicer API is enabled', async () => {
      mockAuthUser([]);
      server.use(
        http.get('/api/v1/settings/', () => HttpResponse.json({ use_slicer_api: true })),
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.stl');
      const sliceItem = within(card).getByText('Slice').closest('button');
      expect(sliceItem).toBeDisabled();

      await user.click(sliceItem!);
      expect(openInSlicer).not.toHaveBeenCalled();
    });

    it('enables the Slice menu item with library:upload when the slicer API is enabled', async () => {
      mockAuthUser(['library:upload']);
      server.use(
        http.get('/api/v1/settings/', () => HttpResponse.json({ use_slicer_api: true })),
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.stl');
      const sliceItem = within(card).getByText('Slice').closest('button');
      expect(sliceItem).not.toBeDisabled();
    });

    it('disables the Slice menu item without any library read permission for the desktop handoff', async () => {
      mockAuthUser(['library:upload']);
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.stl');
      const sliceItem = within(card).getByText('Slice').closest('button');
      expect(sliceItem).toBeDisabled();

      await user.click(sliceItem!);
      expect(openInSlicer).not.toHaveBeenCalled();
    });

    it('enables the Slice menu item with library:read_own for the desktop handoff', async () => {
      mockAuthUser(['library:read_own']);
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.stl');
      const sliceItem = within(card).getByText('Slice').closest('button');
      expect(sliceItem).not.toBeDisabled();
    });

    it('does not accept the legacy library:read for the desktop handoff', async () => {
      // require_ownership_permission(LIBRARY_READ_ALL, LIBRARY_READ_OWN) does no
      // legacy expansion, so this group 403s on the slicer-token endpoint.
      // Enabling the item would offer an action the server refuses, and the
      // failure would look like "no slicer installed" once the fallback URL is
      // handed over.
      mockAuthUser(['library:read']);
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.stl');
      const sliceItem = within(card).getByText('Slice').closest('button');
      expect(sliceItem).toBeDisabled();

      await user.click(sliceItem!);
      expect(openInSlicer).not.toHaveBeenCalled();
    });

    it('slices from the list-view button when the slicer API is disabled', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      await user.click(screen.getByTitle('List view'));
      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const row = screen.getByText('bracket.stl').closest('div[class*="cursor-pointer"]') as HTMLElement;
      await user.click(within(row).getByTitle('Slice'));

      await waitFor(() => {
        expect(openInSlicer).toHaveBeenCalledWith(
          expect.stringContaining('/library/files/2/dl/test-token/'),
          'orcaslicer',
        );
      });
    });

    it('slices from the list-view button into the in-app modal when the slicer API is enabled', async () => {
      server.use(
        http.get('/api/v1/settings/', () => HttpResponse.json({ use_slicer_api: true })),
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      await user.click(screen.getByTitle('List view'));
      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const row = screen.getByText('bracket.stl').closest('div[class*="cursor-pointer"]') as HTMLElement;
      await user.click(within(row).getByTitle('Slice'));

      expect(await screen.findByTestId('slice-modal')).toBeInTheDocument();
      expect(openInSlicer).not.toHaveBeenCalled();
    });
  });

  // Mirrors the archive card's menu entry: the file's weight and duration
  // prefill the calculator, and the filament/printer profiles are only pinned
  // when a real name match was found.
  describe('open in calculator', () => {
    const calcFilaments = [
      // sale_price_per_kg is derived server-side: round(3731 * 1.50, 2).
      { id: 1, name: 'PLA basique', brand: '', material: 'PLA', cost_per_kg: 3731, sale_price_per_kg: 5596.5, margin_pct: 50, difficulty_pct: 150 },
    ];
    const calcPrinters = [
      { id: 1, name: 'H2S', purchase_price: 347000, lifetime_years: 2, daily_usage_hours: 5, power_watts: 400, repair_rate_pct: 30 },
    ];
    const calcDefaults = {
      id: 1,
      electricity_tariff: 120,
      labor_rate_per_hour: 3000,
      consumables_packaging_flat: 30,
      failure_rate_pct: 30,
      prototype_rate_pct: 30,
      ads_rate_pct: 5,
      filament_markup_pct: 5,
      global_markup_pct: 50,
      tax_pct: 13,
      default_difficulty_pct: 100,
      default_margin_over_cost_pct: 50,
      stuff_markup_pct: 20,
    };

    const mockCalculator = () => {
      server.use(
        http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(calcFilaments)),
        http.get('/api/v1/calculator/printers/', () => HttpResponse.json(calcPrinters)),
        http.get('/api/v1/calculator/defaults', () => HttpResponse.json(calcDefaults)),
      );
    };

    const openMenu = async (user: ReturnType<typeof userEvent.setup>, filename: string) => {
      const card = screen.getByText(filename).closest('.group') as HTMLElement;
      const kebab = card.querySelector('.lucide-ellipsis-vertical')?.closest('button') as HTMLButtonElement;
      await user.click(kebab);
      return card;
    };

    afterEach(() => {
      // The tree renders under a BrowserRouter, so navigate() mutates the jsdom
      // URL for every test that follows.
      window.history.replaceState({}, '', '/');
    });

    it('navigates to the calculator prefilled with the file weight and duration', async () => {
      mockCalculator();
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());

      const card = await openMenu(user, 'Benchy');
      await user.click(within(card).getByText('Open in calculator'));

      await waitFor(() => expect(window.location.pathname).toBe('/calculator'));
      const params = new URLSearchParams(window.location.search);
      expect(params.get('weight')).toBe('12.3');
      expect(params.get('time')).toBe('1.00');
      expect(params.get('quantity')).toBe('1');
      // A library file's duration is always a slicer estimate, so the
      // calculator's time-accuracy correction must apply.
      expect(params.get('timeSource')).toBe('est');
      expect(params.get('energyKwh')).toBeNull();
    });

    it('pins the filament profile matching the file, but no printer without a hint', async () => {
      mockCalculator();
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());
      // Let the three calculator queries settle before opening the menu;
      // without them calcConfig is null and no IDs are emitted at all.
      await waitFor(() => expect(screen.getByText('PLA, PETG')).toBeInTheDocument());

      const card = await openMenu(user, 'Benchy');
      await user.click(within(card).getByText('Open in calculator'));

      await waitFor(() => {
        // "PLA, PETG" matches the PLA profile's material.
        expect(new URLSearchParams(window.location.search).get('filamentId')).toBe('1');
      });
      // The mock file has no sliced_for_model, so there is no printer hint —
      // a fallback pick must not override the user's saved printer choice.
      expect(new URLSearchParams(window.location.search).get('printerId')).toBeNull();
    });

    it('pins the printer profile matching the file sliced_for_model', async () => {
      mockCalculator();
      server.use(
        http.get('/api/v1/library/files', () =>
          HttpResponse.json([{ ...mockFiles[0], sliced_for_model: 'H2S' }]),
        ),
      );
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument());
      await waitFor(() => expect(screen.getByText('H2S')).toBeInTheDocument());

      const card = await openMenu(user, 'Benchy');
      await user.click(within(card).getByText('Open in calculator'));

      await waitFor(() => {
        expect(new URLSearchParams(window.location.search).get('printerId')).toBe('1');
      });
    });

    it('disables the entry for a file with no weight or duration', async () => {
      mockCalculator();
      const user = userEvent.setup();
      render(<FileManagerPage />);

      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.stl');
      const item = within(card).getByText('Open in calculator').closest('button');
      expect(item).toBeDisabled();

      await user.click(item!);
      expect(window.location.pathname).toBe('/');
    });
  });

  describe('paging', () => {
    type Callback = (entries: Array<{ isIntersecting: boolean }>) => void;
    const observers: Callback[] = [];
    beforeEach(() => {
      observers.length = 0;
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          observe = vi.fn();
          unobserve = vi.fn();
          disconnect = vi.fn();
          constructor(cb: Callback) {
            observers.push(cb);
          }
        },
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    const manyFiles = Array.from({ length: 250 }, (_, i) => ({
      ...mockFiles[1],
      id: 100 + i,
      filename: `part-${String(i).padStart(3, '0')}.stl`,
      print_name: null,
    }));

    it('loads the first page only and shows the running count', async () => {
      const offsets: string[] = [];
      server.use(pagedFilesHandler(manyFiles, (p) => offsets.push(p.get('offset') ?? '')));
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('part-000.stl')).toBeInTheDocument());
      expect(screen.queryByText('part-100.stl')).not.toBeInTheDocument();
      expect(screen.getByText('100 of 250 files')).toBeInTheDocument();
      expect(offsets).toEqual(['0']);
    });

    it('fetches the next page when the sentinel comes into view', async () => {
      server.use(pagedFilesHandler(manyFiles));
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('part-000.stl')).toBeInTheDocument());
      await waitFor(() => expect(observers.length).toBeGreaterThan(0));
      act(() => observers[observers.length - 1]([{ isIntersecting: true }]));
      await waitFor(() => expect(screen.getByText('part-100.stl')).toBeInTheDocument());
      expect(screen.getByText('200 of 250 files')).toBeInTheDocument();
    });

    it('renders a row the server repeats across pages only once', async () => {
      // A row added between page fetches shifts the offset window, so page
      // two starts with the last row of page one.
      server.use(
        http.get('/api/v1/library/files', ({ request }) => {
          const offset = Number(new URL(request.url).searchParams.get('offset') ?? '0');
          const rows = offset === 0 ? manyFiles.slice(0, 100) : manyFiles.slice(99, 199);
          return HttpResponse.json(rows, { headers: { 'X-Total-Count': '250' } });
        }),
      );
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('part-099.stl')).toBeInTheDocument());
      await waitFor(() => expect(observers.length).toBeGreaterThan(0));
      act(() => observers[observers.length - 1]([{ isIntersecting: true }]));
      await waitFor(() => expect(screen.getByText('part-198.stl')).toBeInTheDocument());
      expect(screen.getAllByText('part-099.stl')).toHaveLength(1);
      expect(screen.getByText('199 of 250 files')).toBeInTheDocument();
    });

    it('changing the sort restarts from offset 0 with the new sort parameter', async () => {
      const seen: Array<{ sort: string | null; offset: string | null }> = [];
      server.use(pagedFilesHandler(manyFiles, (p) => seen.push({ sort: p.get('sort'), offset: p.get('offset') })));
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('part-000.stl')).toBeInTheDocument());
      const sortSelect = screen.getByDisplayValue('Name');
      await userEvent.selectOptions(sortSelect, 'size');
      await waitFor(() => expect(seen.at(-1)).toEqual({ sort: 'size', offset: '0' }));
    });

    it('sends the search to the server after the debounce', async () => {
      const searches: Array<string | null> = [];
      server.use(pagedFilesHandler(manyFiles, (p) => searches.push(p.get('search'))));
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('part-000.stl')).toBeInTheDocument());
      await userEvent.type(screen.getByPlaceholderText('Search files...'), 'part-24');
      await waitFor(() => expect(searches.at(-1)).toBe('part-24'));
      await waitFor(() => expect(screen.getByText('part-240.stl')).toBeInTheDocument());
      expect(screen.queryByText('part-000.stl')).not.toBeInTheDocument();
    });

    it('keeps the toolbar visible when the server returns no rows for a search', async () => {
      server.use(pagedFilesHandler(manyFiles));
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('part-000.stl')).toBeInTheDocument());
      await userEvent.type(screen.getByPlaceholderText('Search files...'), 'zzz-nothing');
      await waitFor(() => expect(screen.getByText('No matching files')).toBeInTheDocument());
      expect(screen.getByPlaceholderText('Search files...')).toBeInTheDocument();
    });

    it('reopens with the saved search, type and sort', async () => {
      localStorage.setItem(
        'library-view-settings',
        JSON.stringify({ v: 1, search: 'part-01', filterType: 'stl', filterUsername: '', topLevelView: 'internal', selectedFolderId: null, sortField: 'size', sortDirection: 'desc' }),
      );
      const seen: URLSearchParams[] = [];
      server.use(pagedFilesHandler(manyFiles, (p) => seen.push(p)));
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('part-010.stl')).toBeInTheDocument());
      const last = seen.at(-1)!;
      expect(last.get('search')).toBe('part-01');
      expect(last.get('file_type')).toBe('stl');
      expect(last.get('sort')).toBe('size');
      expect(last.get('direction')).toBe('desc');
      expect(screen.getByDisplayValue('part-01')).toBeInTheDocument();
    });

    describe('folder from the URL', () => {
      // The shared render util mounts a BrowserRouter, which reads the jsdom
      // location, so pushState sets the route the page opens on.
      beforeEach(() => window.history.pushState({}, '', '/library?folder=1'));
      afterEach(() => window.history.pushState({}, '', '/'));

      it('opens the folder from ?folder= and still lets a sidebar click leave it', async () => {
        const seen: Array<string | null> = [];
        server.use(pagedFilesHandler(manyFiles, (p) => seen.push(p.get('folder_id'))));
        render(<FileManagerPage />);
        await waitFor(() => expect(seen.length).toBeGreaterThan(0));
        expect(seen[0]).toBe('1');
        await userEvent.click(await screen.findByText('Art Projects'));
        await waitFor(() => expect(seen.at(-1)).toBe('3'));
        await waitFor(() =>
          expect(JSON.parse(localStorage.getItem('library-view-settings') ?? '{}').selectedFolderId).toBe(3),
        );
      });

      it('lets ?folder= win over a remembered folder on open', async () => {
        localStorage.setItem(
          'library-view-settings',
          JSON.stringify({ v: 1, search: '', filterType: 'all', filterUsername: '', topLevelView: 'internal', selectedFolderId: 3, sortField: 'name', sortDirection: 'asc' }),
        );
        const seen: Array<string | null> = [];
        server.use(pagedFilesHandler(manyFiles, (p) => seen.push(p.get('folder_id'))));
        render(<FileManagerPage />);
        await waitFor(() => expect(seen.length).toBeGreaterThan(0));
        expect(seen[0]).toBe('1');
        await waitFor(() =>
          expect(JSON.parse(localStorage.getItem('library-view-settings') ?? '{}').selectedFolderId).toBe(1),
        );
        expect(seen).not.toContain('3');
      });
    });

    it('falls back to all files when the saved folder no longer exists', async () => {
      localStorage.setItem(
        'library-view-settings',
        JSON.stringify({ v: 1, search: '', filterType: 'all', filterUsername: '', topLevelView: 'internal', selectedFolderId: 99, sortField: 'name', sortDirection: 'asc' }),
      );
      const seen: Array<string | null> = [];
      server.use(pagedFilesHandler(manyFiles, (p) => seen.push(p.get('folder_id'))));
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('part-000.stl')).toBeInTheDocument());
      expect(seen[0]).toBeNull();
      expect(seen).not.toContain('99');
      await waitFor(() =>
        expect(JSON.parse(localStorage.getItem('library-view-settings') ?? '{}').selectedFolderId).toBeNull(),
      );
    });

    it('clearing a no-match search never flashes the empty-library state or drops the search box', async () => {
      server.use(pagedFilesHandler(manyFiles));
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('part-000.stl')).toBeInTheDocument());
      await userEvent.type(screen.getByPlaceholderText('Search files...'), 'zzz-nothing');
      await waitFor(() => expect(screen.getByText('No matching files')).toBeInTheDocument());

      let sawEmptyLibrary = false;
      let lostSearchBox = false;
      // waitFor re-runs its callback on every DOM mutation, so a transient
      // "No files yet" or an unmounted toolbar between the two states is seen.
      const watch = () => {
        if (screen.queryByText('No files yet')) sawEmptyLibrary = true;
        if (!screen.queryByPlaceholderText('Search files...')) lostSearchBox = true;
      };
      await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
      await waitFor(() => {
        watch();
        expect(screen.getByText('part-000.stl')).toBeInTheDocument();
      });
      expect(sawEmptyLibrary).toBe(false);
      expect(lostSearchBox).toBe(false);
    });

    it('backspacing a no-match search keeps the search box mounted and focused', async () => {
      server.use(pagedFilesHandler(manyFiles));
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('part-000.stl')).toBeInTheDocument());
      const input = screen.getByPlaceholderText('Search files...');
      await userEvent.type(input, 'zzz');
      await waitFor(() => expect(screen.getByText('No matching files')).toBeInTheDocument());

      let sawEmptyLibrary = false;
      await userEvent.type(input, '{backspace}{backspace}{backspace}');
      await waitFor(() => {
        if (screen.queryByText('No files yet')) sawEmptyLibrary = true;
        expect(screen.getByText('part-000.stl')).toBeInTheDocument();
      });
      expect(sawEmptyLibrary).toBe(false);
      expect(input).toBeInTheDocument();
      expect(input).toHaveFocus();
    });

    it('offers a retry when a later page fails', async () => {
      let calls = 0;
      server.use(
        http.get('/api/v1/library/files', ({ request }) => {
          calls += 1;
          const p = new URL(request.url).searchParams;
          if (p.get('offset') !== '0') return HttpResponse.json({ detail: 'boom' }, { status: 500 });
          return HttpResponse.json(manyFiles.slice(0, 100), { headers: { 'X-Total-Count': '250' } });
        }),
      );
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('part-000.stl')).toBeInTheDocument());
      await waitFor(() => expect(observers.length).toBeGreaterThan(0));
      act(() => observers[observers.length - 1]([{ isIntersecting: true }]));
      await waitFor(() => expect(screen.getByText("Couldn't load more files")).toBeInTheDocument());
      const before = calls;
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(calls).toBeGreaterThan(before));
    });
  });
});
