/**
 * File Manager → "Move to project…": suggestions first, then a project search;
 * the item choice (automatic / an existing Impression item / a new one) decides
 * which item fields the import POST carries; the result toast reports moved,
 * copied and skipped files; the File Manager and project caches are refreshed.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient } from '@tanstack/react-query';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { MoveToProjectModal } from '../../../../components/projects/filing/MoveToProjectModal';
import type { MoveToProjectResult } from '../../../../api/client';

beforeAll(() => configure({ asyncUtilTimeout: 5000 }));
afterAll(() => configure({ asyncUtilTimeout: 1000 }));

const tree = {
  project_id: 7,
  code: 'P-0007',
  sections: [
    { section: 'modelisation', items: [{ id: 20, section: 'modelisation', name: 'Model part', name_key: 'model part', forked_from: null, revisions: [] }] },
    { section: 'impression', items: [{ id: 30, section: 'impression', name: 'Support X1C', name_key: 'support x1c', forked_from: null, revisions: [] }] },
  ],
};

const filed = (file_id: number) => ({
  file_id, filename: `f${file_id}.3mf`, section: 'impression', item_id: 30, item_name: 'Support X1C',
  revision_id: 3, revision_number: 2, source_file_id: null,
});

let importBody: Record<string, unknown> | null = null;
let importUrl = '';
let importResult: MoveToProjectResult = { moved: [filed(1)], copied: [], skipped: [] };

function serve() {
  server.use(
    http.get('/api/v1/library/files/:id/project-suggestions', () =>
      HttpResponse.json([
        { project_id: 7, code: 'P-0007', name: 'Bracket job', item_id: 30, item_name: 'Support X1C', score: 1, reason: 'item_name' },
        { project_id: 9, code: 'P-0009', name: 'Other job', item_id: null, item_name: null, score: 0.5, reason: 'project_name' },
      ]),
    ),
    http.get('/api/v1/projects/search', ({ request }) => {
      const q = new URL(request.url).searchParams.get('q');
      return HttpResponse.json({
        items: q ? [{ id: 12, code: 'P-0012', name: 'Lamp shade', description: null, status: 'active', color: null, cover_image_filename: null, tags: [], archive_count: 0, created_at: '', updated_at: '' }] : [],
        total: q ? 1 : 0,
      });
    }),
    http.get('/api/v1/projects/:id/tree', ({ params }) => HttpResponse.json({ ...tree, project_id: Number(params.id) })),
    http.post('/api/v1/projects/:id/import-library-files', async ({ request, params }) => {
      importUrl = `/projects/${params.id}`;
      importBody = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(importResult);
    }),
  );
}

function renderModal(fileIds = [1, 2], fileName?: string) {
  const onClose = vi.fn();
  const onMoved = vi.fn();
  render(<MoveToProjectModal fileIds={fileIds} fileName={fileName} onClose={onClose} onMoved={onMoved} />);
  return { onClose, onMoved };
}

describe('MoveToProjectModal', () => {
  beforeEach(() => {
    importBody = null;
    importUrl = '';
    importResult = { moved: [filed(1)], copied: [], skipped: [] };
    serve();
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the suggestions; picking one preselects the project and its item', async () => {
    const user = userEvent.setup();
    renderModal();
    expect(await screen.findByRole('dialog', { name: 'Move to a project' })).toBeInTheDocument();
    const suggestion = await screen.findByRole('button', { name: /Bracket job/ });
    expect(screen.getByText('Suggested')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Other job/ })).toBeInTheDocument();

    await user.click(suggestion);
    expect(suggestion).toHaveAttribute('aria-pressed', 'true');
    const item = await screen.findByRole('radio', { name: 'Support X1C' });
    expect(item).toBeChecked();
    // Only Impression items are offered.
    expect(screen.queryByRole('radio', { name: 'Model part' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(importBody).not.toBeNull());
    expect(importUrl).toBe('/projects/7');
    expect(importBody).toEqual({ file_ids: [1, 2], item_id: 30 });
  });

  it('search → pick → automatic item posts the file ids without item fields', async () => {
    const user = userEvent.setup();
    const { onMoved, onClose } = renderModal();
    await user.type(await screen.findByPlaceholderText('Search a project…'), 'lamp');
    await user.click(await screen.findByRole('button', { name: /Lamp shade/ }));
    expect(await screen.findByRole('radio', { name: 'Automatic (from each file name)' })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(importBody).not.toBeNull());
    expect(importUrl).toBe('/projects/12');
    expect(importBody).toEqual({ file_ids: [1, 2] });
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('an existing item sends item_id only', async () => {
    const user = userEvent.setup();
    renderModal([5]);
    await user.click(await screen.findByRole('button', { name: /Other job/ }));
    await user.click(await screen.findByRole('radio', { name: 'Support X1C' }));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(importBody).toEqual({ file_ids: [5], item_id: 30 }));
    expect(importUrl).toBe('/projects/9');
  });

  it('a new item sends new_item_name only, and needs a name first', async () => {
    const user = userEvent.setup();
    renderModal([5]);
    await user.click(await screen.findByRole('button', { name: /Other job/ }));
    await user.click(await screen.findByRole('radio', { name: 'New item…' }));
    const move = screen.getByRole('button', { name: 'Move' });
    expect(move).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'New item…' }), '  Lid  ');
    expect(move).not.toBeDisabled();
    await user.click(move);
    await waitFor(() => expect(importBody).toEqual({ file_ids: [5], new_item_name: 'Lid' }));
  });

  it('Move is disabled until a project is picked', async () => {
    renderModal();
    await screen.findByRole('button', { name: /Bracket job/ });
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled();
  });

  it('toasts the moved count with the project code', async () => {
    importResult = { moved: [filed(1), filed(2)], copied: [], skipped: [] };
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: /Bracket job/ }));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('2 files moved to P-0007')).toBeInTheDocument();
    expect(screen.queryByText(/External files are copied/)).not.toBeInTheDocument();
    expect(screen.queryByText(/skipped/)).not.toBeInTheDocument();
  });

  it('counts copies as moved and adds the copied note and the skipped count', async () => {
    importResult = {
      moved: [filed(1)],
      copied: [filed(3)],
      skipped: [{ file_id: 2, code: 'not_printable', reason: 'nope' }],
    };
    const user = userEvent.setup();
    renderModal([1, 2, 3]);
    await user.click(await screen.findByRole('button', { name: /Bracket job/ }));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText(/2 files moved to P-0007/)).toBeInTheDocument();
    expect(screen.getByText(/External files are copied; the originals stay where they are/)).toBeInTheDocument();
    expect(screen.getByText(/1 file skipped: not a 3MF\/G-code file$/)).toBeInTheDocument();
  });

  it('reports only skips when nothing moved', async () => {
    importResult = { moved: [], copied: [], skipped: [{ file_id: 2, code: 'not_printable', reason: 'nope' }, { file_id: 4, code: 'trashed', reason: 'x' }] };
    const user = userEvent.setup();
    renderModal([2, 4]);
    await user.click(await screen.findByRole('button', { name: /Bracket job/ }));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(
      await screen.findByText('2 files skipped: not a 3MF/G-code file (1), in the trash (1)'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/moved to/)).not.toBeInTheDocument();
  });

  it('says why files were skipped, one count per reason; copy errors and conflicts read as retry', async () => {
    importResult = {
      moved: [],
      copied: [],
      skipped: [
        { file_id: 1, code: 'not_printable', reason: 'x' },
        { file_id: 2, code: 'not_printable', reason: 'x' },
        { file_id: 3, code: 'source_missing', reason: 'x' },
        { file_id: 4, code: 'already_in_project', reason: 'x' },
        { file_id: 5, code: 'not_found', reason: 'x' },
        { file_id: 6, code: 'not_owner', reason: 'x' },
        { file_id: 7, code: 'copy_failed', reason: 'x' },
        { file_id: 8, code: 'conflict', reason: 'x' },
        { file_id: 9, code: 'brand_new_code', reason: 'server says why' },
      ],
    };
    const user = userEvent.setup();
    renderModal([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await user.click(await screen.findByRole('button', { name: /Bracket job/ }));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(
      await screen.findByText(
        '9 files skipped: not a 3MF/G-code file (2), file missing on disk (1), already in a project (1), ' +
          'file not found (1), not yours (1), could not be copied, try again (2), server says why (1)',
      ),
    ).toBeInTheDocument();
  });

  it('shows the file name under the title for one file', async () => {
    renderModal([5], 'bracket_v2.3mf');
    expect(await screen.findByTestId('move-to-project-subject')).toHaveTextContent('bracket_v2.3mf');
  });

  it('shows the file count under the title for several files', async () => {
    renderModal([1, 2, 3]);
    expect(await screen.findByTestId('move-to-project-subject')).toHaveTextContent('3 files');
  });

  it('the new item name input has a placeholder', async () => {
    const user = userEvent.setup();
    renderModal([5]);
    await user.click(await screen.findByRole('button', { name: /Other job/ }));
    await user.click(await screen.findByRole('radio', { name: 'New item…' }));
    expect(screen.getByRole('textbox', { name: 'New item…' })).toHaveAttribute('placeholder', 'Item name');
  });

  it('invalidates the File Manager and project caches', async () => {
    const spy = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    const user = userEvent.setup();
    const { onMoved } = renderModal();
    await user.click(await screen.findByRole('button', { name: /Bracket job/ }));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    const keys = spy.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));
    for (const k of [['library-files'], ['library-folders'], ['library-stats'], ['project-tree', 7], ['project-files', 7], ['project-file-progress', 7]]) {
      expect(keys).toContain(JSON.stringify(k));
    }
  });

  it('shows the error and stays open when the move fails', async () => {
    server.use(
      http.post('/api/v1/projects/:id/import-library-files', () =>
        HttpResponse.json({ detail: 'Project not found' }, { status: 404 }),
      ),
    );
    const user = userEvent.setup();
    const { onClose, onMoved } = renderModal();
    await user.click(await screen.findByRole('button', { name: /Bracket job/ }));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText(/Project not found/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onMoved).not.toHaveBeenCalled();
  });

  it('Escape closes it', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
