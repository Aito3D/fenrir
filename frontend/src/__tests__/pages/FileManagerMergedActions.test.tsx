/**
 * The File Manager card and list row carry the fork's actions and upstream's
 * side by side (2026-09-27 upstream merge).
 *
 * FileCard's props, destructure and menu were all conflict hunks: the fork's
 * calculator / history / tags entries against upstream's document preview,
 * file details and external link (#2976, #3077). Taking either side's list
 * alone compiles fine and leaves the other side's menu entries missing or
 * wired to undefined, so this pins that every entry is present and that each
 * side's handler actually reaches its modal. The list row likewise keeps the
 * fork's filament line under upstream's name-plus-indicators line.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FileManagerPage } from '../../pages/FileManagerPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

vi.mock('../../components/FileHistoryModal', () => ({
  FileHistoryModal: ({ filename }: { filename: string }) => <div data-testid="history-modal">{filename}</div>,
}));
vi.mock('../../components/PdfPreviewModal', () => ({
  PdfPreviewModal: ({ filename }: { filename: string }) => <div data-testid="pdf-modal">{filename}</div>,
}));
vi.mock('../../components/LibraryFileDetailsModal', () => ({
  LibraryFileDetailsModal: ({ file }: { file: { filename: string } }) => (
    <div data-testid="details-modal">{file.filename}</div>
  ),
}));

const base = {
  file_path: '/library/x',
  file_size: 1048576,
  folder_id: null,
  thumbnail_path: null,
  print_name: null,
  print_time_seconds: 3600,
  print_count: 0,
  duplicate_count: 0,
  created_at: '2024-01-01T00:00:00Z',
  has_notes: false,
  photo_count: 0,
};

const files = [
  {
    ...base,
    id: 1,
    filename: 'bracket.3mf',
    file_type: '3mf',
    external_url: 'https://www.printables.com/model/1',
    filament_type: 'PLA',
    filament_used_grams: 12.3,
  },
  { ...base, id: 2, filename: 'manual.pdf', file_type: 'pdf', external_url: null },
];

function serve() {
  server.use(
    http.get('/api/v1/library/folders', () => HttpResponse.json([])),
    http.get('/api/v1/library/files', () => HttpResponse.json(files)),
    http.get('/api/v1/library/stats', () =>
      HttpResponse.json({
        total_files: files.length,
        total_folders: 0,
        total_size_bytes: 1,
        disk_free_bytes: 1,
        disk_total_bytes: 2,
      }),
    ),
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, filename: string) {
  const card = screen.getByText(filename).closest('.group') as HTMLElement;
  await user.click(card.querySelector('.lucide-ellipsis-vertical')?.closest('button') as HTMLButtonElement);
  return card;
}

describe('FileManagerPage — fork and upstream actions after the merge', () => {
  beforeEach(() => {
    serve();
  });

  afterEach(() => {
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockReset();
  });

  describe('card menu', () => {
    it('lists the fork entries next to the upstream ones', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.3mf');
      // Fork
      expect(within(card).getByText('Open in calculator')).toBeInTheDocument();
      expect(within(card).getByText('History')).toBeInTheDocument();
      expect(within(card).getByText('Tags')).toBeInTheDocument();
      // Upstream
      expect(within(card).getByText('File details')).toBeInTheDocument();
      expect(within(card).getByText('Open link')).toBeInTheDocument();
      // A 3MF is not a document, so no document preview.
      expect(within(card).queryByText('Preview')).not.toBeInTheDocument();
    });

    it('offers the document preview on a PDF alongside the fork entries', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('manual.pdf')).toBeInTheDocument());

      const card = await openMenu(user, 'manual.pdf');
      expect(within(card).getByText('Preview')).toBeInTheDocument();
      expect(within(card).getByText('History')).toBeInTheDocument();
      expect(within(card).getByText('Tags')).toBeInTheDocument();
    });

    it('wires the fork History entry to its modal', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.3mf');
      await user.click(within(card).getByText('History'));

      expect(await screen.findByTestId('history-modal')).toHaveTextContent('bracket.3mf');
    });

    it('wires the upstream Preview entry to the PDF modal', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('manual.pdf')).toBeInTheDocument());

      const card = await openMenu(user, 'manual.pdf');
      await user.click(within(card).getByText('Preview'));

      expect(await screen.findByTestId('pdf-modal')).toHaveTextContent('manual.pdf');
    });

    it('wires the upstream File details entry to its modal', async () => {
      const user = userEvent.setup();
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());

      const card = await openMenu(user, 'bracket.3mf');
      await user.click(within(card).getByText('File details'));

      expect(await screen.findByTestId('details-modal')).toHaveTextContent('bracket.3mf');
    });
  });

  describe('list row', () => {
    beforeEach(() => {
      (localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation((key: string) =>
        key === 'library-view-mode' ? 'list' : null,
      );
    });

    it('keeps the filament line under the name and its indicators', async () => {
      render(<FileManagerPage />);
      await waitFor(() => expect(screen.getByText('bracket.3mf')).toBeInTheDocument());

      const row = screen.getByText('bracket.3mf').closest('div[class*="grid-cols-"]') as HTMLElement;
      expect(within(row).getByLabelText('Open link')).toHaveAttribute('href', 'https://www.printables.com/model/1');
      expect(within(row).getByTitle('PLA')).toBeInTheDocument();
      expect(within(row).getByText('12.3g')).toBeInTheDocument();
    });
  });
});
