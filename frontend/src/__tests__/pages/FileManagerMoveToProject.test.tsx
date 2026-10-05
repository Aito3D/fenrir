/**
 * File Manager entry points for "Move to project…" (projects PDM phase 5):
 * the visible card button (printable files only), the card menu entry, the
 * list-view action strip and the bulk toolbar — all gated on the File Manager
 * move permission plus projects:update. Also the toast after an upload the
 * backend filed into a project by its code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FileManagerPage } from '../../pages/FileManagerPage';
import type { LibraryFileUploadResponse, MoveToProjectResult } from '../../api/client';

// null = real AuthProvider (auth disabled: everything allowed).
let granted: Set<string> | null = null;
vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      if (!granted) return real;
      const g = granted;
      return {
        ...real,
        hasPermission: (p: string) => g.has(p),
        hasAnyPermission: (...ps: string[]) => ps.some((p) => g.has(p)),
        canModify: (resource: string, action: string) =>
          g.has(`${resource}:${action}_all`) || g.has(`${resource}:${action}_own`),
      };
    },
  };
});

// The modal has its own suite; here only which files it gets and what the
// page does after a move matter.
vi.mock('../../components/projects/filing/MoveToProjectModal', () => ({
  MoveToProjectModal: ({
    fileIds,
    onClose,
    onMoved,
  }: {
    fileIds: number[];
    onClose: () => void;
    onMoved?: (r: MoveToProjectResult) => void;
  }) => (
    <div data-testid="move-to-project-modal">
      <span data-testid="move-ids">{fileIds.join(',')}</span>
      <button
        type="button"
        onClick={() => {
          onMoved?.({ moved: [], copied: [], skipped: [] });
          onClose();
        }}
      >
        stub-move
      </button>
    </div>
  ),
}));

let uploadResponse: LibraryFileUploadResponse;
vi.mock('../../components/FileUploadModal', () => ({
  FileUploadModal: ({
    onFileUploaded,
    onUploadComplete,
    onClose,
  }: {
    onFileUploaded?: (r: LibraryFileUploadResponse) => string | void;
    onUploadComplete: () => void;
    onClose: () => void;
  }) => (
    <div data-testid="upload-modal">
      <button
        type="button"
        onClick={() => {
          onFileUploaded?.(uploadResponse);
          onUploadComplete();
          onClose();
        }}
      >
        stub-upload
      </button>
    </div>
  ),
}));

const base = {
  file_path: '/library/x',
  file_size: 1048576,
  folder_id: null,
  thumbnail_path: null,
  print_name: null,
  print_time_seconds: null,
  print_count: 0,
  duplicate_count: 0,
  created_at: '2024-01-01T00:00:00Z',
  created_by_id: 1,
  has_notes: false,
  photo_count: 0,
  external_url: null,
};
const files = [
  { ...base, id: 1, filename: 'bracket.3mf', file_type: '3mf' },
  { ...base, id: 2, filename: 'bracket.stl', file_type: 'stl' },
  { ...base, id: 3, filename: 'lid.gcode', file_type: 'gcode' },
];

function serve() {
  server.use(
    http.get('/api/v1/library/folders', () => HttpResponse.json([])),
    http.get('/api/v1/library/files', () => HttpResponse.json(files)),
    http.get('/api/v1/library/stats', () =>
      HttpResponse.json({ total_files: files.length, total_folders: 0, total_size_bytes: 1, disk_free_bytes: 1, disk_total_bytes: 2 }),
    ),
  );
}

const LABEL = 'Move to project…';
const card = (filename: string) => screen.getByText(filename).closest('.group') as HTMLElement;

async function openMenu(user: ReturnType<typeof userEvent.setup>, filename: string) {
  const c = card(filename);
  await user.click(c.querySelector('.lucide-ellipsis-vertical')?.closest('button') as HTMLButtonElement);
  return c;
}

describe('FileManagerPage — Move to project', () => {
  beforeEach(() => {
    granted = null;
    serve();
  });
  afterEach(() => {
    granted = null;
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockReset();
  });

  describe('grid card', () => {
    it('shows the card button on a .3mf and a .gcode but not on a .stl', async () => {
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());
      expect(within(card('bracket.3mf')).getByRole('button', { name: LABEL })).toHaveAttribute('title', LABEL);
      expect(within(card('lid.gcode')).getByRole('button', { name: LABEL })).toBeInTheDocument();
      expect(within(card('bracket.stl')).queryByRole('button', { name: LABEL })).not.toBeInTheDocument();
    });

    it('the card button opens the modal for that file only, without selecting the card', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());
      await user.click(within(card('bracket.3mf')).getByRole('button', { name: LABEL }));
      expect(await screen.findByTestId('move-ids')).toHaveTextContent(/^1$/);
      expect(screen.queryByText(/1 selected/i)).not.toBeInTheDocument();
    });

    it('the card menu offers the entry on a printable file and opens the modal', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());
      const c = await openMenu(user, 'bracket.3mf');
      await user.click(within(c).getByText(LABEL));
      expect(await screen.findByTestId('move-ids')).toHaveTextContent(/^1$/);
    });

    it('the card menu has no entry on a .stl', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.stl')).toBeInTheDocument());
      const c = await openMenu(user, 'bracket.stl');
      expect(within(c).getByText('Download')).toBeInTheDocument();
      expect(within(c).queryByText(LABEL)).not.toBeInTheDocument();
    });
  });

  describe('permissions', () => {
    it('hides every entry point without projects:update', async () => {
      granted = new Set(['library:read', 'library:update_all']);
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());
      expect(within(card('bracket.3mf')).queryByRole('button', { name: LABEL })).not.toBeInTheDocument();
      const c = await openMenu(user, 'bracket.3mf');
      expect(within(c).queryByText(LABEL)).not.toBeInTheDocument();
      await user.keyboard('{Escape}');
      await user.click(screen.getByText('bracket.3mf'));
      expect(await screen.findByRole('button', { name: /^Move$/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: LABEL })).not.toBeInTheDocument();
    });

    it('hides every entry point without the File Manager move permission', async () => {
      granted = new Set(['library:read', 'projects:read', 'projects:update']);
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: LABEL })).not.toBeInTheDocument();
    });

    it('shows them with library:update_all plus projects:update', async () => {
      granted = new Set(['library:read', 'library:update_all', 'projects:update']);
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());
      expect(within(card('bracket.3mf')).getByRole('button', { name: LABEL })).toBeInTheDocument();
    });
  });

  describe('bulk toolbar', () => {
    it('passes every selected id (printable or not) and clears the selection after a move', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());
      await user.click(screen.getByText('bracket.3mf'));
      await user.click(screen.getByText('bracket.stl'));
      await user.click(screen.getByText('lid.gcode'));
      expect(await screen.findByText(/3 selected/i)).toBeInTheDocument();

      // The bulk button sits next to Move; the cards' own buttons are in the cards.
      const move = screen.getByRole('button', { name: /^Move$/ });
      const bulk = within(move.parentElement as HTMLElement).getByRole('button', { name: LABEL });
      await user.click(bulk);
      expect(await screen.findByTestId('move-ids')).toHaveTextContent('1,2,3');

      await user.click(screen.getByText('stub-move'));
      await waitFor(() => expect(screen.queryByTestId('move-to-project-modal')).not.toBeInTheDocument());
      expect(screen.queryByText(/3 selected/i)).not.toBeInTheDocument();
    });
  });

  describe('list view', () => {
    beforeEach(() => {
      (localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation((key: string) =>
        key === 'library-view-mode' ? 'list' : null,
      );
    });

    it('the action strip offers the button on printable rows only', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());
      const row = (name: string) => screen.getByText(name).closest('div[class*="grid-cols-"]') as HTMLElement;
      expect(within(row('bracket.stl')).queryByRole('button', { name: LABEL })).not.toBeInTheDocument();
      await user.click(within(row('lid.gcode')).getByRole('button', { name: LABEL }));
      expect(await screen.findByTestId('move-ids')).toHaveTextContent(/^3$/);
    });
  });

  describe('upload filed by project code', () => {
    it('toasts where the upload was filed', async () => {
      uploadResponse = {
        id: 40, filename: 'P-0042_support.3mf', file_type: '3mf', file_size: 1, thumbnail_path: null,
        duplicate_of: null, metadata: null,
        filed_to_project: { project_id: 42, code: 'P-0042', item_name: 'support', revision_number: 3 },
      };
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Upload/ }));
      await user.click(await screen.findByText('stub-upload'));
      expect(await screen.findByText('Filed into P-0042 › support R3')).toBeInTheDocument();
    });

    it('stays quiet for an ordinary upload', async () => {
      uploadResponse = {
        id: 41, filename: 'plain.3mf', file_type: '3mf', file_size: 1, thumbnail_path: null,
        duplicate_of: null, metadata: null, filed_to_project: null,
      };
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Upload/ }));
      await user.click(await screen.findByText('stub-upload'));
      await waitFor(() => expect(screen.queryByTestId('upload-modal')).not.toBeInTheDocument());
      expect(screen.queryByText(/Filed into/)).not.toBeInTheDocument();
    });
  });
});
