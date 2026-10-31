/** ItemRow (the "Older files" row: an item of a disabled section) rendered on its own: the
 *  read-only header (toggle, chip, file count, busy note, hold-to-delete), the row swallowing
 *  file drags without taking them, and the derived-from line. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ProjectItemOut } from '../../../../api/client';
import type { FileActions } from '../../../../components/projects/files/useFileActions';
import { file, item, ref, rev } from '../../../fixtures/projectTree';

const perms = new Set<string>();
vi.mock('../../../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission: (p: string) => perms.has(p) }) }));
vi.mock('../../../../contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { ItemRow } from '../../../../components/projects/files/ItemRow';

const support = item(20, 'modelisation', 'Support', [
  rev({ id: 2, number: 2, status: 'valide', files: [file(50, 'support.3mf')] }),
  rev({ id: 1, number: 1, files: [] }),
]);
const derived = item(30, 'scan', 'Support X1C', [
  rev({
    id: 3,
    number: 1,
    derived_from: ref(1, 'Support', 'modelisation', 1, 'obsolete'),
    outdated_by: ref(2, 'Support', 'modelisation', 2),
    files: [file(60, 'support.gcode.3mf', { file_type: 'gcode.3mf' })],
  }),
]);

let actions: {
  projectId: number;
  isBusy: (id: number) => boolean;
  uploadRevision: ReturnType<typeof vi.fn>;
  renameItem: ReturnType<typeof vi.fn>;
  deleteItem: ReturnType<typeof vi.fn>;
  reslice: { runFor: () => undefined; dismiss: ReturnType<typeof vi.fn> };
};

function renderRow(value: ProjectItemOut, busy = false) {
  actions = {
    projectId: 7,
    isBusy: () => busy,
    uploadRevision: vi.fn(async () => {}),
    renameItem: vi.fn(async () => {}),
    deleteItem: vi.fn(async () => {}),
    reslice: { runFor: () => undefined, dismiss: vi.fn() },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ul>
          <ItemRow item={value} derivedOptions={[]} actions={actions as unknown as FileActions} />
        </ul>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const fileDrop = (name: string) => ({ dataTransfer: { types: ['Files'], files: [new File(['x'], name)], items: [] } });

beforeEach(() => {
  perms.clear();
  perms.add('projects:update');
  perms.add('projects:delete');
});

describe('ItemRow', () => {
  it('shows the newest revision chip and file count; the name toggles the revisions', () => {
    renderRow(support);
    const toggle = screen.getByRole('button', { name: 'Support' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('R2 · Approved')).toBeInTheDocument();
    expect(screen.getByText('1 file')).toBeInTheDocument();
    expect(screen.queryByTestId('revision-2')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('revision-2')).toBeInTheDocument();
    expect(screen.getByTestId('revision-1')).toBeInTheDocument();
  });

  it('is read-only even with projects:update: no upload or rename, and a file drag stops here untaken', () => {
    renderRow(support);
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New revision' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('new-revision-input-20')).not.toBeInTheDocument();
    const row = screen.getByRole('listitem');
    let reached = 0;
    const count = () => (reached += 1);
    document.addEventListener('dragover', count);
    document.addEventListener('drop', count);
    try {
      expect(fireEvent.dragOver(row, { dataTransfer: { types: ['Files'] } })).toBe(false);
      expect(row.className).toContain('border-bambu-dark-tertiary');
      expect(fireEvent.drop(row, fileDrop('dropped.3mf'))).toBe(false);
    } finally {
      document.removeEventListener('dragover', count);
      document.removeEventListener('drop', count);
    }
    expect(reached).toBe(0);
    expect(actions.uploadRevision).not.toHaveBeenCalled();
  });

  it('while busy: uploading note, a drop is not taken', () => {
    renderRow(support, true);
    expect(screen.getByRole('status')).toHaveTextContent('Uploading');
    const row = screen.getByRole('listitem');
    fireEvent.dragOver(row, { dataTransfer: { types: ['Files'] } });
    fireEvent.drop(row, fileDrop('dropped.3mf'));
    expect(actions.uploadRevision).not.toHaveBeenCalled();
  });

  it('without projects:update: no upload or rename, no drop', () => {
    perms.delete('projects:update');
    renderRow(support);
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('new-revision-input-20')).not.toBeInTheDocument();
    const row = screen.getByRole('listitem');
    fireEvent.dragOver(row, { dataTransfer: { types: ['Files'] } });
    expect(row.className).toContain('border-bambu-dark-tertiary');
  });

  it('holding Delete item deletes it', async () => {
    vi.useFakeTimers();
    try {
      renderRow(support);
      const del = screen.getByRole('button', { name: 'Delete item' });
      fireEvent.pointerDown(del, { pointerId: 1, button: 0 });
      await act(async () => {
        vi.advanceTimersByTime(1100);
      });
      expect(actions.deleteItem).toHaveBeenCalledWith(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('without projects:delete: no delete button', () => {
    perms.delete('projects:delete');
    renderRow(support);
    expect(screen.queryByRole('button', { name: 'Delete item' })).not.toBeInTheDocument();
  });

  it('a derived item shows its source; the name toggles it open', () => {
    renderRow(derived);
    expect(screen.getByText(/Derived from/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Support X1C' }));
    expect(screen.getByRole('button', { name: 'Support X1C' })).toHaveAttribute('aria-expanded', 'true');
  });
});
