/** ItemRow (the "Older files" row) rendered on its own: the header's rename, upload and
 *  busy states, the row's drop zone, and the derived-from line with its OUTDATED chip. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ProjectItemOut } from '../../../../api/client';
import type { FileActions } from '../../../../components/projects/files/useFileActions';
import { file, item, ref, rev } from '../../../fixtures/projectTree';

const perms = new Set<string>();
vi.mock('../../../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission: (p: string) => perms.has(p) }) }));
vi.mock('../../../../contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { ItemRow } from '../../../../components/projects/files/ItemRow';

const support = item(20, 'impression', 'Support', [
  rev({ id: 2, number: 2, status: 'valide', files: [file(50, 'support.3mf')] }),
  rev({ id: 1, number: 1, files: [] }),
]);
const derived = item(30, 'impression', 'Support X1C', [
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
  it('renames on submit with the trimmed name, then shows the name button again', () => {
    renderRow(support);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename' });
    expect(input).toHaveValue('Support');
    fireEvent.change(input, { target: { value: '  Support v2 ' } });
    fireEvent.submit(input.closest('form')!);
    expect(actions.renameItem).toHaveBeenCalledWith(20, 'Support v2');
    expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Support' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('Escape cancels the rename, and an unchanged or blank name sends nothing', () => {
    renderRow(support);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    let input = screen.getByRole('textbox', { name: 'Rename' });
    fireEvent.change(input, { target: { value: 'Other' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Rename' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    input = screen.getByRole('textbox', { name: 'Rename' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(actions.renameItem).not.toHaveBeenCalled();
  });

  it('uploads a picked file and a dropped file as a new revision', () => {
    renderRow(support);
    const picker = screen.getByTestId('new-revision-input-20') as HTMLInputElement;
    const picked = new File(['y'], 'support-r3.3mf');
    fireEvent.change(picker, { target: { files: [picked] } });
    expect(actions.uploadRevision).toHaveBeenCalledWith(20, [picked]);
    fireEvent.change(picker, { target: { files: [] } });
    expect(actions.uploadRevision).toHaveBeenCalledTimes(1);
    const row = screen.getByRole('listitem');
    fireEvent.dragOver(row, { dataTransfer: { types: ['Files'] } });
    expect(row.className).toContain('border-bambu-green');
    fireEvent.drop(row, fileDrop('dropped.3mf'));
    expect(actions.uploadRevision).toHaveBeenCalledTimes(2);
    expect(row.className).toContain('border-bambu-dark-tertiary');
  });

  it('while busy: uploading note, upload button disabled, drop highlights but is not taken', () => {
    renderRow(support, true);
    expect(screen.getByRole('status')).toHaveTextContent('Uploading');
    expect(screen.getByRole('button', { name: 'New revision' })).toBeDisabled();
    const row = screen.getByRole('listitem');
    fireEvent.dragOver(row, { dataTransfer: { types: ['Files'] } });
    expect(row.className).toContain('border-bambu-green');
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

  it('a derived, outdated item shows its source and the OUTDATED chip only while closed', () => {
    renderRow(derived);
    expect(screen.getByText(/Derived from/)).toBeInTheDocument();
    expect(screen.getAllByText(/OUTDATED/i)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Support X1C' }));
    expect(screen.getByRole('button', { name: 'Support X1C' })).toHaveAttribute('aria-expanded', 'true');
  });
});
