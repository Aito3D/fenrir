/** Happy paths and request contracts of the files-panel actions (rename, fork, delete item and
 *  revision, remove a file, download, status, re-slice entry, the "Older files" group): what each
 *  action sends, and what the panel shows once the tree is refetched. The refusals live in
 *  ProjectFilesPanel.test.tsx. Real timers; msw handlers record every request. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createEvent, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, wrapper } from '../../../utils';
import { server } from '../../../mocks/server';
import { ProjectFilesPanel } from '../../../../components/projects/files/ProjectFilesPanel';
import { useFileActions } from '../../../../components/projects/files/useFileActions';
import { api, setAuthToken } from '../../../../api/client';

vi.mock('../../../../components/ModelViewerModal', () => ({
  ModelViewerModal: ({ title, libraryFileId, onClose }: { title: string; libraryFileId: number; onClose: () => void }) => (
    <div data-testid="model-viewer-modal">
      {`${title}#${libraryFileId}`}
      <button type="button" onClick={onClose}>close viewer</button>
    </div>
  ),
}));
vi.mock('../../../../components/projects/print/PrintRevisionFlow', () => ({
  PrintRevisionFlow: ({ file, revisionWarning, onClose }: { file: { filename: string }; revisionWarning?: string; onClose: () => void }) => (
    <div data-testid="print-flow">
      {file.filename}
      {revisionWarning && <span data-testid="print-warning">{revisionWarning}</span>}
      <button type="button" onClick={onClose}>close print</button>
    </div>
  ),
}));

type Json = Record<string, unknown>;
const file = (id: number, filename: string, file_type: string, file_size = 10) => ({
  id, filename, file_type, file_size, file_hash: `h${id}`, has_thumbnail: false, created_at: '2026-10-04T10:00:00Z',
});
const rev = (over: Json) => ({
  id: 1, number: 1, status: 'wip', note: null, derived_from: null, outdated_by: null, print_profile: null,
  slicer_name: null, slicer_version: null, pipeline_name: null, has_snapshot: false, used: false, created_by: 'paul',
  created_at: '2026-10-04T10:00:00Z', status_changed_at: null, print_count: 0,
  files: [file(50, 'support.3mf', '3mf', 2048)],
  ...over,
});
const item = (id: number, name: string, revisions: Json[], section = 'impression') => ({
  id, section, name, name_key: name.toLowerCase(), forked_from: null, revisions,
});
const ref = (id: number, name: string, number: number, status = 'valide') => ({
  id, item_id: id * 10, item_name: name, section: 'impression', number, status,
});
const support = () => item(20, 'Support', [rev({ id: 2, number: 2, status: 'valide' }), rev({ id: 1, number: 1, status: 'obsolete', used: true })]);
const gabarit = () =>
  item(40, 'Gabarit', [rev({ id: 4, number: 1, files: [file(70, 'gabarit.3mf', '3mf', 3 * 1024 * 1024), file(71, 'gabarit.gcode', 'gcode')] })]);
const outdatedSlice = () =>
  item(30, 'Support X1C', [rev({ id: 3, number: 1, derived_from: ref(1, 'Support', 1, 'obsolete'), outdated_by: ref(2, 'Support', 2), files: [file(60, 'support.gcode.3mf', 'gcode.3mf')] })]);
const plan = () => item(50, 'Plan', [rev({ id: 5, number: 1, files: [file(80, 'plan.pdf', 'pdf')] })], 'docs');

const makeTree = (impression: Json[], docs: Json[] = []) => ({
  project_id: 7,
  code: 'P-0007',
  sections: [
    { section: 'scan', items: [] },
    { section: 'modelisation', items: [] },
    { section: 'impression', items: impression },
    { section: 'usinage', items: [] },
    { section: 'docs', items: docs },
  ],
});

let treeBody: Json;
let requests: { method: string; path: string; body: unknown }[];
const record = async (request: Request) => {
  const url = new URL(request.url);
  const text = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
  requests.push({ method: request.method, path: `${url.pathname}${url.search}`, body: text ? JSON.parse(text) : null });
};
const mutations = () => requests.filter((r) => !(r.method === 'GET' && r.path === '/api/v1/projects/7/tree'));

beforeEach(() => {
  requests = [];
  treeBody = makeTree([support(), outdatedSlice(), gabarit()], [plan()]);
  server.use(
    http.get('/api/v1/projects/7/tree', async ({ request }) => {
      await record(request);
      return HttpResponse.json(treeBody);
    }),
  );
});

const rowOf = (name: RegExp) => screen.getByRole('button', { name }).closest('li')!;
const dangerButton = (name: string) =>
  screen.getAllByRole('button', { name }).find((b) => b.className.includes('bg-red-500'))!;
const treeFetches = () => requests.filter((r) => r.method === 'GET' && r.path === '/api/v1/projects/7/tree').length;

describe('ProjectFilesPanel actions', () => {
  it('renames an item with a PATCH carrying the trimmed name, then shows the server name', async () => {
    server.use(
      http.patch('/api/v1/projects/items/:id', async ({ request, params }) => {
        await record(request);
        treeBody = makeTree([{ ...support(), name: 'Support v2', name_key: 'support v2' }, outdatedSlice(), gabarit()], [plan()]);
        return HttpResponse.json(item(Number(params.id), 'Support v2', []));
      }),
    );
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    await userEvent.click(within(rowOf(/Support$/)).getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename' });
    expect(input).toHaveValue('Support');
    await userEvent.clear(input);
    await userEvent.type(input, '  Support v2  {Enter}');
    expect(await screen.findByRole('button', { name: /Support v2$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Support$/ })).not.toBeInTheDocument();
    expect(mutations()).toEqual([{ method: 'PATCH', path: '/api/v1/projects/items/20', body: { name: 'Support v2' } }]);
  });

  it('renames on blur too, and only once', async () => {
    server.use(
      http.patch('/api/v1/projects/items/:id', async ({ request, params }) => {
        await record(request);
        return HttpResponse.json(item(Number(params.id), 'Gabarit 2', []));
      }),
    );
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Gabarit');
    await userEvent.click(within(rowOf(/Gabarit$/)).getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Gabarit 2');
    fireEvent.blur(input);
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0]).toEqual({ method: 'PATCH', path: '/api/v1/projects/items/40', body: { name: 'Gabarit 2' } });
  });

  it('forks a revision into a new item with a POST carrying the revision id and the new name', async () => {
    server.use(
      http.post('/api/v1/projects/items/:id/fork', async ({ request }) => {
        await record(request);
        treeBody = makeTree([support(), outdatedSlice(), gabarit(), item(41, 'Gabarit PETG', [rev({ id: 6, number: 1 })])], [plan()]);
        return HttpResponse.json(item(41, 'Gabarit PETG', []), { status: 201 });
      }),
    );
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
    await userEvent.click(within(screen.getByTestId('revision-4')).getByRole('button', { name: 'Fork as new item' }));
    const name = screen.getByRole('textbox', { name: 'New item name' });
    expect(name).toHaveValue('Gabarit (R1)');
    await userEvent.clear(name);
    await userEvent.type(name, ' Gabarit PETG {Enter}');
    expect(await screen.findByRole('button', { name: /Gabarit PETG$/ })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'New item name' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Printing 4', 'Older files 1']);
    expect(mutations()).toEqual([
      { method: 'POST', path: '/api/v1/projects/items/40/fork', body: { revision_id: 4, name: 'Gabarit PETG' } },
    ]);
  });

  it('deletes an item only after the confirmation; cancelling sends nothing', async () => {
    server.use(
      http.delete('/api/v1/projects/items/:id', async ({ request }) => {
        await record(request);
        treeBody = makeTree([outdatedSlice(), gabarit()], [plan()]);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    await userEvent.click(within(rowOf(/Support$/)).getByRole('button', { name: 'Delete item' }));
    expect(screen.getByText('Delete Support and all its revisions? Files move to the project trash.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/and all its revisions/)).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);

    await userEvent.click(within(rowOf(/Support$/)).getByRole('button', { name: 'Delete item' }));
    await userEvent.click(dangerButton('Delete item'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Support$/ })).not.toBeInTheDocument());
    expect(screen.queryByText(/and all its revisions/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Support X1C$/ })).toBeInTheDocument();
    expect(mutations()).toEqual([{ method: 'DELETE', path: '/api/v1/projects/items/20', body: null }]);
  });

  it('deletes a revision only after the confirmation; cancelling sends nothing', async () => {
    server.use(
      http.delete('/api/v1/projects/revisions/:id', async ({ request }) => {
        await record(request);
        treeBody = makeTree([item(20, 'Support', [rev({ id: 1, number: 1, status: 'obsolete', used: true })]), outdatedSlice(), gabarit()], [plan()]);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Support$/ }));
    // A used revision offers no delete.
    expect(within(screen.getByTestId('revision-1')).queryByRole('button', { name: 'Delete revision' })).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByTestId('revision-2')).getByRole('button', { name: 'Delete revision' }));
    expect(screen.getByText('Delete Support R2? Its files move to the project trash.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Delete Support R2\?/)).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);

    await userEvent.click(within(screen.getByTestId('revision-2')).getByRole('button', { name: 'Delete revision' }));
    await userEvent.click(dangerButton('Delete revision'));
    await waitFor(() => expect(screen.queryByTestId('revision-2')).not.toBeInTheDocument());
    expect(screen.getByTestId('revision-1')).toBeInTheDocument();
    expect(within(rowOf(/Support$/)).getByText(/R1 · Obsolete/)).toBeInTheDocument();
    expect(mutations()).toEqual([{ method: 'DELETE', path: '/api/v1/projects/revisions/2', body: null }]);
  });

  it('removes one file after the confirmation; cancelling sends nothing, and the file goes after the refetch', async () => {
    server.use(
      http.delete('/api/v1/projects/revisions/:rid/files/:fid', async ({ request }) => {
        await record(request);
        treeBody = makeTree([support(), outdatedSlice(), item(40, 'Gabarit', [rev({ id: 4, number: 1, files: [file(70, 'gabarit.3mf', '3mf')] })])], [plan()]);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
    const block = () => screen.getByTestId('revision-4');
    await userEvent.click(within(block()).getByRole('button', { name: 'Remove gabarit.gcode' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/from Gabarit R1\?/)).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);

    await userEvent.click(within(block()).getByRole('button', { name: 'Remove gabarit.gcode' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(within(block()).queryByText('gabarit.gcode')).not.toBeInTheDocument());
    expect(within(block()).getByText('gabarit.3mf')).toBeInTheDocument();
    // The last file of a revision cannot be removed.
    expect(within(block()).queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    expect(mutations()).toEqual([{ method: 'DELETE', path: '/api/v1/projects/revisions/4/files/71', body: null }]);
  });

  it('changes a status with a PATCH carrying only the status, then shows it on the row', async () => {
    server.use(
      http.patch('/api/v1/projects/revisions/:id', async ({ request, params }) => {
        await record(request);
        treeBody = makeTree([support(), outdatedSlice(), item(40, 'Gabarit', [rev({ id: 4, number: 1, status: 'valide', files: gabarit().revisions[0].files })])], [plan()]);
        return HttpResponse.json(rev({ id: Number(params.id), status: 'valide' }));
      }),
    );
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
    expect(within(rowOf(/Gabarit$/)).getByText(/R1 · In progress/)).toBeInTheDocument();
    await userEvent.selectOptions(within(screen.getByTestId('revision-4')).getByLabelText('Status'), 'valide');
    expect(await within(rowOf(/Gabarit$/)).findByText(/R1 · Approved/)).toBeInTheDocument();
    expect(within(screen.getByTestId('revision-4')).getByLabelText('Status')).toHaveValue('valide');
    expect(mutations()).toEqual([{ method: 'PATCH', path: '/api/v1/projects/revisions/4', body: { status: 'valide' } }]);
  });

  describe('download', () => {
    let createObjectURL: ReturnType<typeof vi.fn>;
    let revokeObjectURL: ReturnType<typeof vi.fn>;
    let clicked: { href: string; download: string }[];
    const originals = {
      create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
      revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
    };

    beforeEach(() => {
      clicked = [];
      createObjectURL = vi.fn(() => 'blob:fenrir/1');
      revokeObjectURL = vi.fn();
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL });
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push({ href: this.getAttribute('href') ?? '', download: this.download });
      });
      server.use(
        http.get('/api/v1/projects/revisions/:id/download', async ({ request }) => {
          await record(request);
          const fileId = new URL(request.url).searchParams.get('file_id');
          const headers: Record<string, string> = fileId ? {} : { 'Content-Disposition': 'attachment; filename="P-0007_Gabarit_R1.zip"' };
          return new HttpResponse(new Blob(['data']), { headers });
        }),
      );
    });

    afterEach(() => {
      vi.mocked(HTMLAnchorElement.prototype.click).mockRestore();
      for (const [key, descriptor] of [['createObjectURL', originals.create], ['revokeObjectURL', originals.revoke]] as const) {
        if (descriptor) Object.defineProperty(URL, key, descriptor);
        else delete (URL as unknown as Record<string, unknown>)[key];
      }
    });

    it('downloads one file with ?file_id= and saves it under its own name', async () => {
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
      const fileRow = within(screen.getByTestId('revision-4')).getByText('gabarit.gcode').closest('li')!;
      await userEvent.click(within(fileRow).getByRole('button', { name: 'Download' }));
      await waitFor(() => expect(clicked).toEqual([{ href: 'blob:fenrir/1', download: 'gabarit.gcode' }]));
      expect(mutations()).toEqual([{ method: 'GET', path: '/api/v1/projects/revisions/4/download?file_id=71', body: null }]);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:fenrir/1');
      expect(treeFetches()).toBe(1); // a download does not refetch the tree
    });

    it('downloads the whole revision without a file id, named by the server', async () => {
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
      await userEvent.click(within(screen.getByTestId('revision-4')).getByRole('button', { name: 'Download all (zip)' }));
      await waitFor(() => expect(clicked).toEqual([{ href: 'blob:fenrir/1', download: 'P-0007_Gabarit_R1.zip' }]));
      expect(mutations()).toEqual([{ method: 'GET', path: '/api/v1/projects/revisions/4/download', body: null }]);
    });
  });

  it('opens and closes the 3D preview of a file', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
    const fileRow = within(screen.getByTestId('revision-4')).getByText('gabarit.3mf').closest('li')!;
    expect(within(fileRow).getByText('3.0 MB')).toBeInTheDocument();
    await userEvent.click(within(fileRow).getByRole('button', { name: 'Preview' }));
    expect(screen.getByTestId('model-viewer-modal')).toHaveTextContent('gabarit.3mf#70');
    await userEvent.click(screen.getByRole('button', { name: 'close viewer' }));
    expect(screen.queryByTestId('model-viewer-modal')).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);
  });

  it('opens the print flow for a file, with the outdated warning of its revision', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Support X1C$/ }));
    await userEvent.click(within(screen.getByTestId('revision-3')).getByRole('button', { name: 'Print support.gcode.3mf' }));
    expect(screen.getByTestId('print-flow')).toHaveTextContent('support.gcode.3mf');
    expect(screen.getByTestId('print-warning')).toHaveTextContent(/Support R1.*R2/);
    await userEvent.click(screen.getByRole('button', { name: 'close print' }));
    expect(screen.queryByTestId('print-flow')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Gabarit$/ }));
    await userEvent.click(within(screen.getByTestId('revision-4')).getByRole('button', { name: 'Print gabarit.3mf' }));
    expect(screen.getByTestId('print-flow')).toHaveTextContent('gabarit.3mf');
    expect(screen.queryByTestId('print-warning')).not.toBeInTheDocument();
  });

  it('opens the re-slice dialog for a 3MF and closes it without starting a job', async () => {
    server.use(
      http.get('/api/v1/slicer-pipelines/', () => HttpResponse.json({ pipelines: [] })),
      http.get('/api/v1/projects/7/orders', () => HttpResponse.json({ orders: [] })),
      http.post('/api/v1/projects/revisions/:id/reslice', async ({ request }) => {
        await record(request);
        return HttpResponse.json({}, { status: 202 });
      }),
    );
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Support$/ }));
    await userEvent.click(within(screen.getByTestId('revision-2')).getByRole('button', { name: /Re-slice/ }));
    expect(await screen.findByRole('dialog', { name: 'Re-slice support.3mf' })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mutations().filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('the visible buttons open their hidden file pickers', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    try {
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
      const opened = () => click.mock.contexts.map((input) => (input as HTMLInputElement).dataset.testid);
      await userEvent.click(within(rowOf(/Gabarit$/)).getByRole('button', { name: 'New revision' }));
      await userEvent.click(within(screen.getByTestId('revision-4')).getByRole('button', { name: 'Add files' }));
      await userEvent.click(screen.getByRole('button', { name: 'New item' }));
      await userEvent.click(screen.getByRole('button', { name: 'Choose files' }));
      expect(opened()).toEqual(['new-revision-input-40', 'add-files-input-4', 'new-item-files-impression']);
    } finally {
      click.mockRestore();
    }
    expect(mutations()).toEqual([]);
  });

  it('highlights the section and the item under a drag, and clears it when the drag leaves', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    const section = screen.getByRole('heading', { level: 3, name: /^Printing/ }).closest('section')!;
    const row = rowOf(/Support$/);
    fireEvent.dragOver(section);
    expect(section.className).toContain('border-bambu-green');
    fireEvent.dragLeave(section, { relatedTarget: null });
    expect(section.className).not.toContain('border-bambu-green');
    fireEvent.dragOver(row);
    expect(row.className).toContain('border-bambu-green');
    expect(section.className).not.toContain('border-bambu-green'); // the item stops the drag reaching its section
    fireEvent.dragLeave(row, { relatedTarget: null });
    expect(row.className).not.toContain('border-bambu-green');
  });

  it('collapses and reopens a section', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    const toggle = screen.getByRole('button', { name: /^Printing/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Support')).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.getByText('Support')).toBeInTheDocument();
  });

  describe('"Older files" group', () => {
    const openOlder = async () => {
      render(<ProjectFilesPanel projectId={7} />);
      await screen.findByText('Support');
      const older = screen.getByTestId('older-files');
      await userEvent.click(within(older).getByRole('button', { name: /Older files/ }));
      return older;
    };

    it('deletes a legacy item after the confirmation, and the group goes once it is empty', async () => {
      server.use(
        http.delete('/api/v1/projects/items/:id', async ({ request }) => {
          await record(request);
          treeBody = makeTree([support(), outdatedSlice(), gabarit()]);
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const older = await openOlder();
      expect(within(older).getByRole('button', { name: /Older files/ })).toHaveAttribute('aria-expanded', 'true');
      await userEvent.click(within(rowOf(/Plan$/)).getByRole('button', { name: 'Delete item' }));
      expect(screen.getByText('Delete Plan and all its revisions? Files move to the project trash.')).toBeInTheDocument();
      await userEvent.click(dangerButton('Delete item'));
      await waitFor(() => expect(screen.queryByTestId('older-files')).not.toBeInTheDocument());
      expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Printing 3']);
      expect(mutations()).toEqual([{ method: 'DELETE', path: '/api/v1/projects/items/50', body: null }]);
    });

    it('deletes and downloads a legacy revision, but offers no re-slice, print or preview of a PDF', async () => {
      server.use(
        http.delete('/api/v1/projects/revisions/:id', async ({ request }) => {
          await record(request);
          treeBody = makeTree([support(), outdatedSlice(), gabarit()], [item(50, 'Plan', [])]);
          return new HttpResponse(null, { status: 204 });
        }),
      );
      await openOlder();
      await userEvent.click(within(rowOf(/Plan$/)).getByRole('button', { name: /Plan$/ }));
      const block = screen.getByTestId('revision-5');
      expect(within(block).getByRole('button', { name: 'Download all (zip)' })).toBeInTheDocument();
      for (const absent of [/Re-slice/, /^Print/, 'Preview', /^Remove/]) {
        expect(within(block).queryByRole('button', { name: absent })).not.toBeInTheDocument();
      }
      await userEvent.click(within(block).getByRole('button', { name: 'Delete revision' }));
      expect(screen.getByText('Delete Plan R1? Its files move to the project trash.')).toBeInTheDocument();
      await userEvent.click(dangerButton('Delete revision'));
      await waitFor(() => expect(screen.queryByTestId('revision-5')).not.toBeInTheDocument());
      expect(within(rowOf(/Plan$/)).getByText('0 files')).toBeInTheDocument();
      expect(mutations()).toEqual([{ method: 'DELETE', path: '/api/v1/projects/revisions/5', body: null }]);
    });

    it('collapses again', async () => {
      const older = await openOlder();
      expect(within(older).getByText('Plan')).toBeInTheDocument();
      await userEvent.click(within(older).getByRole('button', { name: /Older files/ }));
      expect(within(older).queryByText('Plan')).not.toBeInTheDocument();
    });
  });
});

/** True when a native `type` event fired by `fire` bubbles up to the document. */
const reachesDocument = (type: 'dragover' | 'drop', fire: () => void) => {
  let reached = false;
  const listener = () => {
    reached = true;
  };
  document.addEventListener(type, listener);
  try {
    fire();
  } finally {
    document.removeEventListener(type, listener);
  }
  return reached;
};
/** A dragleave whose `relatedTarget` is `to` (jsdom has no DragEvent to carry it). */
const leaveTo = (el: Element, to: Element | null) => {
  const ev = createEvent.dragLeave(el);
  Object.defineProperty(ev, 'relatedTarget', { value: to });
  fireEvent(el, ev);
};

describe('files panel drop zone handlers', () => {
  const sectionEl = () => screen.getByRole('heading', { level: 3, name: /^Printing/ }).closest('section')!;
  const textDrag = { dataTransfer: { types: ['text/plain'] } };

  it('a section claims and highlights any drag, lets it bubble, and keeps the highlight while it moves inside', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    const section = sectionEl();
    let notPrevented = true;
    expect(reachesDocument('dragover', () => (notPrevented = fireEvent.dragOver(section, textDrag)))).toBe(true);
    expect(notPrevented).toBe(false);
    expect(section.className).toContain('border-bambu-green');
    leaveTo(section, rowOf(/Support$/));
    expect(section.className).toContain('border-bambu-green');
    leaveTo(section, null);
    expect(section.className).not.toContain('border-bambu-green');
  });

  it('an item row claims and highlights any drag but stops it, and keeps the highlight while it moves inside', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    const row = rowOf(/Support$/);
    let notPrevented = true;
    expect(reachesDocument('dragover', () => (notPrevented = fireEvent.dragOver(row, textDrag)))).toBe(false);
    expect(notPrevented).toBe(false);
    expect(row.className).toContain('border-bambu-green');
    leaveTo(row, row.firstElementChild);
    expect(row.className).toContain('border-bambu-green');
    leaveTo(row, null);
    expect(row.className).not.toContain('border-bambu-green');
  });

  it('a drop on a section is claimed and bubbles on; on an item row it is claimed and stopped', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    const empty = { dataTransfer: { files: [], types: ['Files'] } };
    const section = sectionEl();
    fireEvent.dragOver(section);
    let notPrevented = true;
    expect(reachesDocument('drop', () => (notPrevented = fireEvent.drop(section, empty)))).toBe(true);
    expect(notPrevented).toBe(false);
    expect(section.className).not.toContain('border-bambu-green');
    const row = rowOf(/Support$/);
    fireEvent.dragOver(row);
    notPrevented = true;
    expect(reachesDocument('drop', () => (notPrevented = fireEvent.drop(row, empty)))).toBe(false);
    expect(notPrevented).toBe(false);
    expect(row.className).not.toContain('border-bambu-green');
    await new Promise((r) => setTimeout(r, 50));
    expect(mutations()).toEqual([]);
  });

  it('a legacy item claims and stops a drag but neither highlights nor takes the drop', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    const older = screen.getByTestId('older-files');
    await userEvent.click(within(older).getByRole('button', { name: /Older files/ }));
    const row = within(older).getByRole('button', { name: /Plan$/ }).closest('li')!;
    expect(reachesDocument('dragover', () => expect(fireEvent.dragOver(row)).toBe(false))).toBe(false);
    expect(row.className).not.toContain('border-bambu-green');
    const drop = { dataTransfer: { files: [new File(['x'], 'plan.3mf')], types: ['Files'] } };
    expect(reachesDocument('drop', () => expect(fireEvent.drop(row, drop)).toBe(false))).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(mutations()).toEqual([]);
  });

  describe('without projects:update', () => {
    afterEach(() => setAuthToken(null));

    it('a section still claims a drag but neither highlights nor takes the drop', async () => {
      let meServed = false;
      setAuthToken('test-token', 'session');
      server.use(
        http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
        http.get('*/api/v1/auth/me', () => {
          meServed = true;
          return HttpResponse.json({ id: 1, username: 'op', is_admin: false, permissions: ['projects:read'] });
        }),
      );
      render(<ProjectFilesPanel projectId={7} />);
      await waitFor(() => expect(meServed).toBe(true));
      await screen.findByText('Support');
      await waitFor(() => expect(screen.queryByRole('button', { name: /New item/ })).not.toBeInTheDocument());
      const section = sectionEl();
      expect(reachesDocument('dragover', () => expect(fireEvent.dragOver(section)).toBe(false))).toBe(true);
      expect(section.className).not.toContain('border-bambu-green');
      const row = rowOf(/Support$/);
      expect(reachesDocument('dragover', () => expect(fireEvent.dragOver(row)).toBe(false))).toBe(false);
      expect(row.className).not.toContain('border-bambu-green');
      const drop = { dataTransfer: { files: [new File(['x'], 'bracket.3mf')], types: ['Files'] } };
      expect(fireEvent.drop(section, drop)).toBe(false);
      expect(fireEvent.drop(row, drop)).toBe(false);
      await new Promise((r) => setTimeout(r, 50));
      expect(mutations()).toEqual([]);
    });
  });
});

/** The hook alone: the refusal and failure branches the panel tests do not reach. */
describe('useFileActions', () => {
  afterEach(() => vi.restoreAllMocks());
  const printable = () => new File(['x'], 'part.3mf');
  const pdf = () => new File(['x'], 'plan.pdf');

  it('addFiles refuses a non-printing file with a toast and sends nothing', async () => {
    const add = vi.spyOn(api, 'addProjectRevisionFiles');
    const { result } = renderHook(() => useFileActions(7), { wrapper });
    await act(() => result.current.addFiles(40, 4, [printable(), pdf()]));
    expect(await screen.findByText('Only 3MF and G-code files can go into a project')).toBeInTheDocument();
    expect(add).not.toHaveBeenCalled();
    expect(result.current.isBusy(40)).toBe(false);
  });

  it('acceptsFiles is true for printing files only, without a toast', () => {
    const { result } = renderHook(() => useFileActions(7), { wrapper });
    expect(result.current.acceptsFiles([printable()])).toBe(true);
    expect(screen.queryByText('Only 3MF and G-code files can go into a project')).not.toBeInTheDocument();
  });

  it('a failed action thrown as a non-Error toasts the bare failure prefix and resolves undefined', async () => {
    vi.spyOn(api, 'updateProjectRevision').mockRejectedValue('nope');
    const { result } = renderHook(() => useFileActions(7), { wrapper });
    let out: unknown = 'unset';
    await act(async () => {
      out = await result.current.setNote(4, 'hello');
    });
    expect(out).toBeUndefined();
    expect(await screen.findByText('Could not save:')).toBeInTheDocument();
  });

  it('setDerived sends the derived revision id', async () => {
    const update = vi.spyOn(api, 'updateProjectRevision').mockResolvedValue({} as never);
    const { result } = renderHook(() => useFileActions(7), { wrapper });
    await act(() => result.current.setDerived(4, 2));
    expect(update).toHaveBeenCalledWith(4, { derived_from_id: 2 });
  });

  it('a failed download toasts the error message, or the bare prefix for a non-Error', async () => {
    const download = vi.spyOn(api, 'downloadProjectRevision').mockRejectedValueOnce(new Error('gone'));
    const { result } = renderHook(() => useFileActions(7), { wrapper });
    await act(() => result.current.download(4, 71, 'gabarit.gcode'));
    expect(await screen.findByText('Could not save: gone')).toBeInTheDocument();
    download.mockRejectedValueOnce(42);
    await act(() => result.current.download(4));
    expect(await screen.findByText('Could not save:')).toBeInTheDocument();
    expect(download).toHaveBeenLastCalledWith(4, undefined, undefined);
  });
});
