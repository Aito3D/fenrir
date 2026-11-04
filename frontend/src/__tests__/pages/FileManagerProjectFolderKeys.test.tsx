/**
 * File Manager folder link / move / share (T-573): each still invalidates both project folder
 * families it reached while they shared the ['project-folders'] key — the catalog's folder tree and
 * every project's linked File Manager folders (now ['project-linked-folders', id]).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient } from '@tanstack/react-query';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FileManagerPage } from '../../pages/FileManagerPage';
import { setAuthToken } from '../../api/client';

function folder(overrides: Record<string, unknown>) {
  return {
    parent_id: null,
    file_count: 0,
    project_id: null,
    archive_id: null,
    project_name: null,
    archive_name: null,
    is_external: false,
    external_path: null,
    external_readonly: false,
    latest_activity_at: null,
    created_by_id: 1,
    shared: false,
    can_write: true,
    can_rename: true,
    can_delete: true,
    children: [],
    ...overrides,
  };
}

const folders = [folder({ id: 1, name: 'Linked', project_id: 5, project_name: 'Bracket' }), folder({ id: 4, name: 'Other' })];

async function openFolderMenu(user: ReturnType<typeof userEvent.setup>, folderName: string) {
  const row = screen.getByText(folderName).closest('div.group')!;
  const buttons = within(row).getAllByRole('button');
  await user.click(buttons[buttons.length - 1]);
  return row;
}

describe('File Manager folder mutations and the project folder caches (T-573)', () => {
  let invalidate: ReturnType<typeof vi.spyOn>;
  const invalidatedKeys = () => invalidate.mock.calls.map(([f]) => JSON.stringify((f as { queryKey?: unknown })?.queryKey));

  beforeEach(() => {
    localStorage.clear();
    setAuthToken('test-token', 'session');
    server.use(
      http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json({ id: 1, username: 'admin', is_admin: true, permissions: ['library:read_all', 'library:update_all'] }),
      ),
      http.get('/api/v1/library/folders', () => HttpResponse.json(folders)),
      http.get('/api/v1/library/files', () => HttpResponse.json([])),
      http.get('/api/v1/library/stats', () =>
        HttpResponse.json({ total_files: 0, total_folders: 2, total_size_bytes: 0, disk_free_bytes: 1, disk_total_bytes: 2 }),
      ),
      http.put('/api/v1/library/folders/:id', ({ params }) =>
        HttpResponse.json(folder({ id: Number(params.id), name: 'x', created_at: '', updated_at: '' })),
      ),
    );
    invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
  });

  afterEach(() => {
    invalidate.mockRestore();
    setAuthToken(null);
  });

  it.each([
    ['unlink', 'Folder unlinked'],
    ['move', 'Folder moved'],
    ['share', 'Folder shared with everyone'],
  ])('%s invalidates the catalog folder tree and every linked-folders query', async (action, toast) => {
    render(<FileManagerPage />);
    await waitFor(() => expect(screen.getByText('Other')).toBeInTheDocument());
    const user = userEvent.setup();

    if (action === 'unlink') {
      const row = await openFolderMenu(user, 'Linked');
      await user.click(within(row).getByRole('button', { name: 'Change Link...' }));
      await user.click(screen.getByRole('button', { name: 'Unlink' }));
    } else if (action === 'move') {
      const row = await openFolderMenu(user, 'Other');
      await user.click(within(row).getByRole('button', { name: 'Move folder…' }));
      const dialog = screen.getByText('Move "Other" to').closest('.fixed')!;
      await user.click(within(dialog).getByRole('button', { name: /^Linked/ }));
      await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    } else {
      const row = await openFolderMenu(user, 'Other');
      await user.click(within(row).getByRole('button', { name: 'Share with everyone' }));
    }

    await waitFor(() => expect(screen.getByText(toast)).toBeInTheDocument());
    expect(invalidatedKeys()).toEqual(
      expect.arrayContaining([JSON.stringify(['project-folders']), JSON.stringify(['project-linked-folders'])]),
    );
  });
});
