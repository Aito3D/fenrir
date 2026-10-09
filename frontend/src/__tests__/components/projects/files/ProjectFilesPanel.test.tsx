import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { ProjectFilesPanel } from '../../../../components/projects/files/ProjectFilesPanel';
import { itemNameFromFile, itemNameKey } from '../../../../components/projects/files/fileDrop';

const ref = (id: number, item: string, section: string, number: number, status = 'valide') => ({
  id, item_id: id * 10, item_name: item, section, number, status,
});
const rev = (over: Record<string, unknown>) => ({
  id: 1, number: 1, status: 'wip', note: null, derived_from: null, outdated_by: null, print_profile: null,
  slicer_name: null, slicer_version: null, pipeline_name: null, has_snapshot: false, used: false, created_by: 'paul',
  created_at: '2026-10-04T10:00:00Z', status_changed_at: null,
  files: [{ id: 50, filename: 'support.3mf', file_type: '3mf', file_size: 2048, file_hash: 'h', has_thumbnail: false, created_at: '2026-10-04T10:00:00Z' }],
  ...over,
});
const tree = {
  project_id: 7,
  code: 'P-0007',
  sections: [
    { section: 'scan', items: [] },
    { section: 'modelisation', items: [] },
    { section: 'impression', items: [{ id: 20, section: 'impression', name: 'Support', name_key: 'support', forked_from: null, revisions: [rev({ id: 2, number: 2, status: 'valide' }), rev({ id: 1, number: 1, status: 'obsolete', used: true })] }, { id: 30, section: 'impression', name: 'Support X1C', name_key: 'support x1c', forked_from: null, revisions: [rev({ id: 3, number: 1, derived_from: ref(1, 'Support', 'modelisation', 1, 'obsolete'), outdated_by: ref(2, 'Support', 'modelisation', 2), print_profile: { printer_model: 'Bambu Lab X1C', nozzle_diameter: '0.4', layer_height: '0.2', filament_types: ['PETG'], sliced: true }, has_snapshot: true, files: [{ id: 60, filename: 'support.gcode.3mf', file_type: 'gcode.3mf', file_size: 4096, file_hash: 'p', has_thumbnail: true, created_at: '2026-10-04T10:00:00Z' }] })] }, { id: 40, section: 'impression', name: 'Gabarit', name_key: 'gabarit', forked_from: null, revisions: [rev({ id: 4, number: 1, files: [
      { id: 70, filename: 'gabarit.3mf', file_type: '3mf', file_size: 10, file_hash: 'g1', has_thumbnail: false, created_at: '2026-10-04T10:00:00Z' },
      { id: 71, filename: 'gabarit.gcode', file_type: 'gcode', file_size: 10, file_hash: 'g2', has_thumbnail: false, created_at: '2026-10-04T10:00:00Z' },
    ] })] }] },
    { section: 'usinage', items: [] },
    { section: 'docs', items: [{ id: 50, section: 'docs', name: 'Plan', name_key: 'plan', forked_from: null, revisions: [rev({ id: 5, number: 1, files: [
      { id: 80, filename: 'plan.pdf', file_type: 'pdf', file_size: 10, file_hash: 'd1', has_thumbnail: false, created_at: '2026-10-04T10:00:00Z' },
    ] })] }] },
  ],
};
/** The same project before anything was left in a disabled section. */
const printingOnly = { ...tree, sections: tree.sections.map((s) => (s.section === 'docs' ? { ...s, items: [] } : s)) };
let treeBody: unknown = tree;

let patched: { url: string; body: unknown } | null;
let uploaded: string | null;
let calls: string[];
let failUpload = false;
let holdUpload: Promise<void> | null = null;

beforeEach(() => {
  patched = null;
  uploaded = null;
  calls = [];
  failUpload = false;
  holdUpload = null;
  treeBody = tree;
  server.use(
    http.delete('/api/v1/projects/revisions/:rid/files/:fid', ({ params }) => {
      calls.push(`remove:${params.rid}:${params.fid}`);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/v1/projects/7/items', async ({ request }) => {
      const body = (await request.json()) as { name: string };
      calls.push(`create:${body.name}`);
      return HttpResponse.json({ id: 99, section: 'impression', name: body.name, name_key: body.name.toLowerCase(), forked_from: null, revisions: [] }, { status: 201 });
    }),
    http.get('/api/v1/projects/7/tree', () => HttpResponse.json(treeBody)),
    http.patch('/api/v1/projects/items/:id', async ({ request, params }) => {
      const body = (await request.json()) as { name: string };
      calls.push(`rename:${params.id}`);
      return HttpResponse.json({ id: Number(params.id), section: 'impression', name: body.name, name_key: body.name.toLowerCase(), forked_from: null, revisions: [] });
    }),
    http.patch('/api/v1/projects/revisions/:id', async ({ request, params }) => {
      patched = { url: String(params.id), body: await request.json() };
      return HttpResponse.json(rev({ id: Number(params.id) }));
    }),
    http.post('/api/v1/projects/items/:id/revisions', async ({ params }) => {
      calls.push(`upload:${params.id}`);
      if (holdUpload) await holdUpload;
      if (failUpload) return HttpResponse.json({ detail: 'boom' }, { status: 500 });
      uploaded = String(params.id);
      return HttpResponse.json({ revision: rev({ id: 9, number: 3 }), warnings: [{ filename: 'b.3mf', same_as: 'R1' }] }, { status: 201 });
    }),
  );
});

describe('itemNameFromFile', () => {
  it('strips .gcode.3mf and simple extensions', () => {
    expect(itemNameFromFile('support.gcode.3mf')).toBe('support');
    expect(itemNameFromFile('scan_brut.ply')).toBe('scan_brut');
    expect(itemNameFromFile('README')).toBe('README');
  });
});

describe('itemNameKey', () => {
  it('normalises like the backend name_key', () => {
    expect(itemNameKey('  Sup:port. ')).toBe('support');
    expect(itemNameKey('cafe\u0301')).toBe('caf\u00e9');
    expect(itemNameKey('..Plan..')).toBe('plan');
    expect(itemNameKey('con')).toBe('_con');
    expect(itemNameKey('Straße')).toBe('strasse');
    expect(itemNameKey('a<b>c|d?e*f"g/h\\i')).toBe('abcdefghi');
    expect(itemNameKey('???')).toBe('');
  });
});

describe('ProjectFilesPanel', () => {
  const drop = (el: Element, name: string) =>
    fireEvent.drop(el, { dataTransfer: { files: [new File(['x'], name)], types: ['Files'] } });
  const sectionOf = (label: string) => screen.getByRole('heading', { level: 3, name: new RegExp(`^${label}`) }).closest('section')!;

  it('shows only the Printing section, with the newest revision chip', async () => {
    treeBody = printingOnly;
    render(<ProjectFilesPanel projectId={7} />);
    expect(await screen.findByText('Support')).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings.map((h) => h?.split(' ')[0])).toEqual(['Printing']);
    for (const disabled of ['Scan', 'Modeling', 'Machining', 'Documents', 'Older files']) {
      expect(screen.queryByText(disabled)).not.toBeInTheDocument();
    }
    expect(screen.getByText(/R2 · Approved/)).toBeInTheDocument();
  });

  it('lists an item left in a disabled section under a collapsed "Older files" group, read-only except delete', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Printing 3', 'Older files 1']);
    const older = screen.getByTestId('older-files');
    expect(within(older).queryByText('Plan')).not.toBeInTheDocument();
    await userEvent.click(within(older).getByRole('button', { name: /Older files/ }));
    expect(within(older).getByRole('heading', { level: 4, name: 'Documents' })).toBeInTheDocument();
    const row = within(older).getByRole('button', { name: /Plan$/ }).closest('li')!;
    expect(within(row).queryByRole('button', { name: 'New revision' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(within(row).queryByTestId('new-revision-input-50')).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Delete item' })).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: /Plan$/ }));
    const r5 = screen.getByTestId('revision-5');
    expect(within(r5).getByLabelText('Status')).toBeDisabled();
    expect(within(r5).queryByRole('button', { name: 'Fork' })).not.toBeInTheDocument();
    expect(within(r5).queryByRole('button', { name: 'Add files' })).not.toBeInTheDocument();
    expect(within(r5).getByRole('button', { name: 'Delete revision' })).toBeInTheDocument();
    drop(row, 'plan.3mf');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
  });

  it('upload inputs accept printing files only', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    expect(screen.getByTestId('new-revision-input-20')).toHaveAttribute('accept', '.3mf,.gcode,.bgcode');
    const section = sectionOf('Printing');
    await userEvent.click(within(section).getByRole('button', { name: 'New item' }));
    expect(within(section).getByTestId('new-item-files-impression')).toHaveAttribute('accept', '.3mf,.gcode,.bgcode');
  });

  it('picking a .stl in the upload input toasts and sends nothing', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    // fireEvent: userEvent.upload would silently drop the file on the `accept` filter.
    fireEvent.change(screen.getByTestId('new-revision-input-20'), { target: { files: [new File(['x'], 'mesh.stl')] } });
    expect(await screen.findByText('Only 3MF and G-code files can go into a project')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
  });

  it('dropping a mixed set on the section toasts and neither creates nor uploads', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    fireEvent.drop(sectionOf('Printing'), {
      dataTransfer: { files: [new File(['x'], 'bracket.3mf'), new File(['x'], 'bracket.step')], types: ['Files'] },
    });
    expect(await screen.findByText('Only 3MF and G-code files can go into a project')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
  });

  it('picking a non-printing file in the new-item form toasts and keeps the form empty', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    const section = sectionOf('Printing');
    await userEvent.click(within(section).getByRole('button', { name: 'New item' }));
    fireEvent.change(within(section).getByTestId('new-item-files-impression'), { target: { files: [new File(['x'], 'plan.pdf')] } });
    expect(await screen.findByText('Only 3MF and G-code files can go into a project')).toBeInTheDocument();
    expect(within(section).getByLabelText('Item name')).toHaveValue('');
    expect(within(section).getByRole('button', { name: 'Choose files' })).toBeInTheDocument();
    expect(within(section).queryByRole('combobox')).not.toBeInTheDocument(); // no section picker
  });

  it('flags an outdated print revision and its source', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    expect(await screen.findByText(/Outdated — based on Support R1, R2 approved since/)).toBeInTheDocument();
  });

  it('changes a status through the API', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Support$/ }));
    const r2 = screen.getByTestId('revision-2');
    await userEvent.selectOptions(within(r2).getByLabelText('Status'), 'obsolete');
    await waitFor(() => expect(patched).toEqual({ url: '2', body: { status: 'obsolete' } }));
  });

  it('freezes files of a used revision', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Support$/ }));
    const r1 = screen.getByTestId('revision-1');
    expect(within(r1).getByText('Files frozen: this revision was printed or delivered')).toBeInTheDocument();
    expect(within(r1).queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(within(r1).queryByRole('button', { name: 'Delete revision' })).not.toBeInTheDocument();
  });

  it('uploads a new revision from the item menu and shows duplicate warnings', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    const input = screen.getByTestId('new-revision-input-20') as HTMLInputElement;
    await userEvent.upload(input, new File(['x'], 'b.3mf'));
    await waitFor(() => expect(uploaded).toBe('20'));
    expect(await screen.findByText('b.3mf is identical to R1')).toBeInTheDocument();
  });

  it('shows the print profile of a sliced revision', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Support X1C$/ }));
    expect(screen.getByText(/Bambu Lab X1C/)).toBeInTheDocument();
    expect(screen.getByText('Sliced')).toBeInTheDocument();
  });

  it('dropping on a section reuses an item with the same name, case-insensitively', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    drop(sectionOf('Printing'), 'SUPPORT.3mf');
    await waitFor(() => expect(calls).toEqual(['upload:20']));
  });

  it('dropping on a section matches items on the backend name key', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    drop(sectionOf('Printing'), 'Sup:port.gcode');
    await waitFor(() => expect(calls).toEqual(['upload:20']));
  });

  it('dropping a new name on a section creates the item then uploads', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    drop(sectionOf('Printing'), 'bracket.3mf');
    await waitFor(() => expect(calls).toEqual(['create:bracket', 'upload:99']));
  });

  it('dropping on an item row uploads once and does not create an item', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    const row = (await screen.findByRole('button', { name: /Support$/ })).closest('li')!;
    drop(row, 'other.3mf');
    await waitFor(() => expect(calls).toEqual(['upload:20']));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual(['upload:20']);
  });

  it('saves a note and a derived-from change with only that field', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Support$/ }));
    const r2 = screen.getByTestId('revision-2');
    await userEvent.click(within(r2).getByRole('button', { name: 'What changed…' }));
    const box = within(r2).getByLabelText('Note');
    await userEvent.type(box, 'hello');
    await userEvent.tab();
    await waitFor(() => expect(patched).toEqual({ url: '2', body: { note: 'hello' } }));
    await userEvent.selectOptions(within(r2).getByLabelText('Derived from'), '1');
    await waitFor(() => expect(patched).toEqual({ url: '2', body: { derived_from_id: 1 } }));
    await userEvent.selectOptions(within(r2).getByLabelText('Derived from'), 'Nothing');
    await waitFor(() => expect(patched).toEqual({ url: '2', body: { derived_from_id: null } }));
  });

  it('retrying a new item after a failed first upload only retries the upload', async () => {
    failUpload = true;
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    const section = sectionOf('Printing');
    await userEvent.click(within(section).getByRole('button', { name: 'New item' }));
    await userEvent.type(within(section).getByLabelText('Item name'), 'bracket');
    await userEvent.upload(within(section).getByTestId('new-item-files-impression'), new File(['x'], 'bracket.3mf'));
    const submit = () => within(section).getAllByRole('button', { name: 'New item' }).at(-1)!;
    await userEvent.click(submit());
    await waitFor(() => expect(calls).toEqual(['create:bracket', 'upload:99']));
    expect(await screen.findByText(/Upload failed/)).toBeInTheDocument();
    expect(within(section).getByLabelText('Item name')).toBeDisabled();
    failUpload = false;
    await userEvent.click(submit());
    await waitFor(() => expect(calls).toEqual(['create:bracket', 'upload:99', 'upload:99']));
    await waitFor(() => expect(within(section).queryByLabelText('Item name')).not.toBeInTheDocument());
  });

  it('shows OUTDATED on the collapsed row, and only in the revision block once expanded', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    const outdated = /Outdated — based on Support R1/;
    expect(await screen.findAllByText(outdated)).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /Support X1C$/ }));
    expect(screen.getAllByText(outdated)).toHaveLength(1);
    expect(within(screen.getByTestId('revision-3')).getByText(outdated)).toBeInTheDocument();
  });

  it('asks before removing a file from a revision', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
    await userEvent.click(within(screen.getByTestId('revision-4')).getByRole('button', { name: 'Remove gabarit.gcode' }));
    expect(screen.getByText('Remove gabarit.gcode from Gabarit R1? The file moves to the project trash.')).toBeInTheDocument();
    expect(calls).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls).toEqual(['remove:4:71']));
  });

  it('shows a busy state and blocks new uploads on an item while one runs', async () => {
    let release!: () => void;
    holdUpload = new Promise<void>((r) => { release = r; });
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    await userEvent.upload(screen.getByTestId('new-revision-input-20'), new File(['x'], 'b.3mf'));
    const row = screen.getByRole('button', { name: /Support$/ }).closest('li')!;
    expect(await within(row).findByText('Uploading…')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'New revision' })).toBeDisabled();
    drop(row, 'again.3mf');
    drop(sectionOf('Printing'), 'Support.gcode');
    expect(calls).toEqual(['upload:20']);
    release();
    await waitFor(() => expect(within(row).queryByText('Uploading…')).not.toBeInTheDocument());
    expect(within(row).getByRole('button', { name: 'New revision' })).toBeEnabled();
  });

  it('a busy item still highlights under a drag, but takes no drop until the upload ends', async () => {
    let release!: () => void;
    holdUpload = new Promise<void>((r) => { release = r; });
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    await userEvent.upload(screen.getByTestId('new-revision-input-20'), new File(['x'], 'b.3mf'));
    const row = screen.getByRole('button', { name: /Support$/ }).closest('li')!;
    expect(await within(row).findByText('Uploading…')).toBeInTheDocument();
    fireEvent.dragOver(row);
    expect(row.className).toContain('border-bambu-green');
    drop(row, 'again.3mf');
    expect(row.className).not.toContain('border-bambu-green');
    expect(calls).toEqual(['upload:20']);
    release();
    await waitFor(() => expect(within(row).queryByText('Uploading…')).not.toBeInTheDocument());
    drop(row, 'again.3mf');
    await waitFor(() => expect(calls).toEqual(['upload:20', 'upload:20']));
  });

  it('shows the upload failure toast', async () => {
    failUpload = true;
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    await userEvent.upload(screen.getByTestId('new-revision-input-20'), new File(['x'], 'b.3mf'));
    expect(await screen.findByText(/Upload failed/)).toBeInTheDocument();
  });
  describe('Re-slice', () => {
    const pipeline = { id: 3, name: 'H2D PETG', description: null, printer_preset: { source: 'local', id: '1' }, process_preset: { source: 'local', id: '2' }, filament_presets: [], bed_type: null, target_kind: 'printer_class', target_printer_id: null, target_model_class: 'H2D', fanout_strategy: 'max_parallel', created_by: null, created_at: '', updated_at: '' };
    let started: unknown;
    let job: Record<string, unknown>;
    beforeEach(() => {
      started = null;
      job = { job_id: 9, status: 'running', kind: 'project_revision', source_id: 2, source_name: 'support.3mf', created_at: '', started_at: '', completed_at: null, progress: null };
      server.use(
        http.get('/api/v1/slicer-pipelines/', () => HttpResponse.json({ pipelines: [pipeline] })),
        http.post('/api/v1/slicer-pipelines/3/check-eligibility', () => HttpResponse.json({ ok: true, target_kind: 'printer_class', target_printer_id: null, target_printer_name: null, target_model_class: 'H2D', issues: [], printer_reports: [] })),
        http.get('/api/v1/projects/7/orders', () => HttpResponse.json({ orders: [] })),
        http.post('/api/v1/projects/revisions/:id/reslice', async ({ request, params }) => {
          started = { id: params.id, body: await request.json() };
          return HttpResponse.json({ job_id: 9, status: 'pending', status_url: '/api/v1/slice-jobs/9' }, { status: 202 });
        }),
        http.get('/api/v1/slice-jobs/9', () => HttpResponse.json(job)),
      );
    });

    const startReslice = async () => {
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Support$/ }));
      await userEvent.click(within(screen.getByTestId('revision-2')).getByRole('button', { name: /Re-slice/ }));
      await userEvent.click(await screen.findByRole('radio', { name: /H2D PETG/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Slice' }));
      await waitFor(() => expect(started).toEqual({ id: '2', body: { file_id: 50, pipeline_id: 3 } }));
      return screen.getByRole('button', { name: /Support$/ }).closest('li')!;
    };

    it('re-slices a 3MF from its revision and shows progress on the item', async () => {
      const row = await startReslice();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(await within(row).findByText('Slicing…')).toBeInTheDocument();
      expect(within(screen.getByTestId('revision-2')).getByRole('button', { name: /Re-slice/ })).toBeDisabled();
    });

    it('shows a failed run on the item until dismissed', async () => {
      job = { ...job, status: 'failed', error_status: 502, error_detail: 'Sidecar unreachable' };
      const row = await startReslice();
      expect(await within(row).findByText('Slicing failed: Sidecar unreachable', {}, { timeout: 4000 })).toBeInTheDocument();
      expect(within(screen.getByTestId('revision-2')).getByRole('button', { name: /Re-slice/ })).toBeEnabled();
      await userEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));
      expect(within(row).queryByText(/Slicing failed/)).not.toBeInTheDocument();
    });

    it('opens the print flow once a "Slice + queue" run finishes', async () => {
      let libraryFetched: string | null = null;
      // Slow tree on completion: the panel's run must still reach the print flow.
      server.use(
        http.get('/api/v1/projects/7/tree', async () => {
          if (job.status === 'completed') await delay(80);
          return HttpResponse.json(treeBody);
        }),
        http.get('/api/v1/printers/', () =>
          HttpResponse.json([{ id: 1, name: 'X1 Carbon', model: 'X1C', ip_address: '192.168.1.100', enabled: true, is_active: true }])),
        http.get('/api/v1/printers/:id/status', () => HttpResponse.json({ connected: true, state: 'IDLE', ams: [], vt_tray: [] })),
        http.get('/api/v1/library/files/:id', ({ params }) => {
          libraryFetched = String(params.id);
          return HttpResponse.json({
            id: Number(params.id), filename: 'support.gcode.3mf', print_name: null, file_type: '3mf', folder_id: null, project_id: 7,
            file_hash: null, file_size_bytes: 1024, thumbnail_path: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
          });
        }),
        http.get('/api/v1/library/files/:id/plates', () => HttpResponse.json({ is_multi_plate: false, plates: [] })),
        http.get('/api/v1/library/files/:id/filament-requirements', () => HttpResponse.json({ file_id: 60, filename: 'support.gcode.3mf', filaments: [] })),
      );
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Support$/ }));
      await userEvent.click(within(screen.getByTestId('revision-2')).getByRole('button', { name: /Re-slice/ }));
      await userEvent.click(await screen.findByRole('radio', { name: /H2D PETG/ }));
      // No open order: "Slice + queue" starts right away with no task.
      await userEvent.click(screen.getByRole('button', { name: 'Slice + queue' }));
      await waitFor(() => expect(started).toEqual({ id: '2', body: { file_id: 50, pipeline_id: 3 } }));
      job = { ...job, status: 'completed', result: { project_id: 7, item_id: 20, revision_id: 2, revision_number: 2, file_id: 60, filename: 'support.gcode.3mf' } };
      expect(await screen.findByText('Support R2 created', {}, { timeout: 4000 })).toBeInTheDocument();
      // PrintRevisionFlow → PrintModal for the new file, the order picker skipped.
      expect(await screen.findByRole('button', { name: /^print$/i }, { timeout: 4000 })).toBeInTheDocument();
      await waitFor(() => expect(libraryFetched).toBe('60'));
      expect(screen.queryByRole('dialog', { name: 'Which order is this print for?' })).not.toBeInTheDocument();
    });

    it('offers no Re-slice on G-code files', async () => {
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
      expect(within(screen.getByTestId('revision-4')).getAllByRole('button', { name: /Re-slice/ })).toHaveLength(1);
    });

    it('shows the pipeline a revision was sliced with', async () => {
      treeBody = { ...tree, sections: tree.sections.map((s) => (s.section !== 'impression' ? s : {
        ...s, items: s.items.map((i) => (i.id !== 30 ? i : { ...i, revisions: i.revisions.map((r) => ({ ...r, pipeline_name: 'H2D PETG' })) })),
      })) };
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Support X1C$/ }));
      expect(within(screen.getByTestId('revision-3')).getByText('via H2D PETG')).toBeInTheDocument();
    });
  });
  describe('server refusals', () => {
    const fail = (method: 'post' | 'patch' | 'delete' | 'get', path: string, status: number, detail: string) =>
      server.use(http[method](path, () => HttpResponse.json({ detail }, { status })));
    const rowOf = (name: RegExp) => screen.getByRole('button', { name }).closest('li')!;

    it('toasts a 413 upload refusal with the server detail and frees the item again', async () => {
      fail('post', '/api/v1/projects/items/:id/revisions', 413, 'Upload exceeds the maximum size of 1024 bytes');
      render(<ProjectFilesPanel projectId={7} />);
      await screen.findByText('Support');
      await userEvent.upload(screen.getByTestId('new-revision-input-20'), new File(['x'], 'big.3mf'));
      expect(await screen.findByText('Upload failed: Upload exceeds the maximum size of 1024 bytes')).toBeInTheDocument();
      const row = rowOf(/Support$/);
      await waitFor(() => expect(within(row).queryByText('Uploading…')).not.toBeInTheDocument());
      expect(within(row).getByRole('button', { name: 'New revision' })).toBeEnabled();
      expect(within(row).getByText(/R2 · Approved/)).toBeInTheDocument();
    });

    it('toasts a 4xx upload refusal, and falls back to the status code without a detail', async () => {
      fail('post', '/api/v1/projects/items/:id/revisions', 400, 'Unsupported file');
      render(<ProjectFilesPanel projectId={7} />);
      await screen.findByText('Support');
      await userEvent.upload(screen.getByTestId('new-revision-input-20'), new File(['x'], 'a.3mf'));
      expect(await screen.findByText('Upload failed: Unsupported file')).toBeInTheDocument();

      server.use(http.post('/api/v1/projects/items/:id/revisions', () => new HttpResponse(null, { status: 422 })));
      await userEvent.upload(screen.getByTestId('new-revision-input-20'), new File(['x'], 'b.3mf'));
      expect(await screen.findByText('Upload failed: HTTP 422')).toBeInTheDocument();
    });

    it('toasts a failed add-files and keeps the revision as it was', async () => {
      fail('post', '/api/v1/projects/revisions/:id/files', 409, 'Revision is frozen');
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
      await userEvent.upload(screen.getByTestId('add-files-input-4'), new File(['x'], 'extra.3mf'));
      expect(await screen.findByText('Upload failed: Revision is frozen')).toBeInTheDocument();
      expect(within(screen.getByTestId('revision-4')).getAllByRole('listitem')).toHaveLength(2);
    });

    it('keeps the old name when a rename hits a 409 name conflict', async () => {
      fail('patch', '/api/v1/projects/items/:id', 409, 'An item with this name already exists');
      render(<ProjectFilesPanel projectId={7} />);
      await screen.findByText('Support');
      await userEvent.click(within(rowOf(/Support$/)).getByRole('button', { name: 'Rename' }));
      const input = screen.getByRole('textbox', { name: 'Rename' });
      await userEvent.clear(input);
      await userEvent.type(input, 'Gabarit{Enter}');
      expect(await screen.findByText('Could not save: An item with this name already exists')).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Support$/ })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /Gabarit$/ })).toHaveLength(1);
    });

    it('keeps the item when deleting it is refused, after the confirmation', async () => {
      fail('delete', '/api/v1/projects/items/:id', 409, 'Item has used revisions');
      render(<ProjectFilesPanel projectId={7} />);
      await screen.findByText('Support');
      await userEvent.click(within(rowOf(/Support$/)).getByRole('button', { name: 'Delete item' }));
      expect(screen.getByText('Delete Support and all its revisions? Files move to the project trash.')).toBeInTheDocument();
      await userEvent.click(screen.getByText('Delete item', { selector: 'button.bg-red-500, button.bg-red-500 *' }));
      expect(await screen.findByText('Could not save: Item has used revisions')).toBeInTheDocument();
      expect(screen.queryByText(/and all its revisions/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Support$/ })).toBeInTheDocument();
    });

    it('keeps the revision when deleting it is refused', async () => {
      fail('delete', '/api/v1/projects/revisions/:id', 409, 'Revision is in use');
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
      const block = screen.getByTestId('revision-4');
      await userEvent.click(within(block).getByRole('button', { name: 'Delete revision' }));
      expect(screen.getByText('Delete Gabarit R1? Its files move to the project trash.')).toBeInTheDocument();
      await userEvent.click(screen.getAllByRole('button', { name: 'Delete revision' }).find((b) => b.className.includes('bg-red-500'))!);
      expect(await screen.findByText('Could not save: Revision is in use')).toBeInTheDocument();
      expect(screen.getByTestId('revision-4')).toBeInTheDocument();
    });

    it('keeps the file when removing it is refused', async () => {
      fail('delete', '/api/v1/projects/revisions/:rid/files/:fid', 409, 'Revision is frozen');
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
      await userEvent.click(within(screen.getByTestId('revision-4')).getByRole('button', { name: 'Remove gabarit.gcode' }));
      await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
      expect(await screen.findByText('Could not save: Revision is frozen')).toBeInTheDocument();
      expect(within(screen.getByTestId('revision-4')).getByText('gabarit.gcode')).toBeInTheDocument();
    });

    it('toasts a refused fork and creates no new item', async () => {
      fail('post', '/api/v1/projects/items/:id/fork', 409, 'An item with this name already exists');
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
      await userEvent.click(within(screen.getByTestId('revision-4')).getByRole('button', { name: 'Fork as new item' }));
      const name = screen.getByRole('textbox', { name: 'New item name' });
      expect(name).toHaveValue('Gabarit (R1)');
      await userEvent.click(screen.getAllByRole('button', { name: 'Fork as new item' }).find((b) => b.getAttribute('type') === 'submit')!);
      expect(await screen.findByText('Could not save: An item with this name already exists')).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'New item name' })).not.toBeInTheDocument();
      expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Printing 3', 'Older files 1']);
    });

    it('does not fork with a blank name', async () => {
      let forked = false;
      server.use(http.post('/api/v1/projects/items/:id/fork', () => { forked = true; return HttpResponse.json({}, { status: 201 }); }));
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
      await userEvent.click(within(screen.getByTestId('revision-4')).getByRole('button', { name: 'Fork as new item' }));
      await userEvent.clear(screen.getByRole('textbox', { name: 'New item name' }));
      await userEvent.keyboard('{Enter}');
      expect(screen.getByRole('textbox', { name: 'New item name' })).toBeInTheDocument();
      expect(forked).toBe(false);
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('textbox', { name: 'New item name' })).not.toBeInTheDocument();
    });

    it('snaps the status select back to the server value when the change is refused', async () => {
      fail('patch', '/api/v1/projects/revisions/:id', 409, 'Cannot approve an outdated revision');
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
      const select = within(screen.getByTestId('revision-4')).getByLabelText('Status');
      expect(select).toHaveValue('wip');
      await userEvent.selectOptions(select, 'valide');
      expect(await screen.findByText('Could not save: Cannot approve an outdated revision')).toBeInTheDocument();
      expect(select).toHaveValue('wip');
    });

    it('toasts a failed download', async () => {
      fail('get', '/api/v1/projects/revisions/:id/download', 404, 'No file available on disk');
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
      await userEvent.click(within(screen.getByTestId('revision-4')).getByRole('button', { name: 'Download all (zip)' }));
      expect(await screen.findByText('Could not save: No file available on disk')).toBeInTheDocument();
    });

    it('does not rename to an unchanged or blank name, and Escape cancels', async () => {
      render(<ProjectFilesPanel projectId={7} />);
      await screen.findByText('Support');
      const row = () => rowOf(/Support$/);
      await userEvent.click(within(row()).getByRole('button', { name: 'Rename' }));
      await userEvent.keyboard('{Enter}');
      expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument();
      await userEvent.click(within(row()).getByRole('button', { name: 'Rename' }));
      await userEvent.clear(screen.getByRole('textbox', { name: 'Rename' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Rename' }), '   {Enter}');
      expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument();
      await userEvent.click(within(row()).getByRole('button', { name: 'Rename' }));
      await userEvent.clear(screen.getByRole('textbox', { name: 'Rename' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Rename' }), 'Other{Escape}');
      expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Support$/ })).toBeInTheDocument();
      expect(calls).toEqual([]);
    });

    it('sends exactly one rename request for a real rename', async () => {
      render(<ProjectFilesPanel projectId={7} />);
      await screen.findByText('Support');
      await userEvent.click(within(rowOf(/Support$/)).getByRole('button', { name: 'Rename' }));
      await userEvent.clear(screen.getByRole('textbox', { name: 'Rename' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Rename' }), 'Nouveau{Enter}');
      await waitFor(() => expect(calls).toEqual(['rename:20']));
      expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument();
    });
  });
});
