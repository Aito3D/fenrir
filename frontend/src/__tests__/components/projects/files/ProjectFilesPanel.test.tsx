import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { ProjectFilesPanel } from '../../../../components/projects/files/ProjectFilesPanel';
import { itemNameFromFile, itemNameKey } from '../../../../components/projects/files/fileDrop';

const ref = (id: number, item: string, section: string, number: number, status = 'valide') => ({
  id, item_id: id * 10, item_name: item, section, number, status,
});
const rev = (over: Record<string, unknown>) => ({
  id: 1, number: 1, status: 'wip', note: null, derived_from: null, outdated_by: null, print_profile: null,
  slicer_name: null, slicer_version: null, has_snapshot: false, used: false, created_by: 'paul',
  created_at: '2026-10-04T10:00:00Z', status_changed_at: null,
  files: [{ id: 50, filename: 'support.step', file_type: 'step', file_size: 2048, file_hash: 'h', has_thumbnail: false, created_at: '2026-10-04T10:00:00Z' }],
  ...over,
});
const tree = {
  project_id: 7,
  code: 'P-0007',
  sections: [
    { section: 'scan', items: [] },
    { section: 'modelisation', items: [{ id: 20, section: 'modelisation', name: 'Support', name_key: 'support', forked_from: null, revisions: [rev({ id: 2, number: 2, status: 'valide' }), rev({ id: 1, number: 1, status: 'obsolete', used: true })] }] },
    { section: 'impression', items: [{ id: 30, section: 'impression', name: 'Support X1C', name_key: 'support x1c', forked_from: null, revisions: [rev({ id: 3, number: 1, derived_from: ref(1, 'Support', 'modelisation', 1, 'obsolete'), outdated_by: ref(2, 'Support', 'modelisation', 2), print_profile: { printer_model: 'Bambu Lab X1C', nozzle_diameter: '0.4', layer_height: '0.2', filament_types: ['PETG'], sliced: true }, has_snapshot: true, files: [{ id: 60, filename: 'support.gcode.3mf', file_type: 'gcode.3mf', file_size: 4096, file_hash: 'p', has_thumbnail: true, created_at: '2026-10-04T10:00:00Z' }] })] }] },
    { section: 'usinage', items: [{ id: 40, section: 'usinage', name: 'Gabarit', name_key: 'gabarit', forked_from: null, revisions: [rev({ id: 4, number: 1, files: [
      { id: 70, filename: 'gabarit.step', file_type: 'step', file_size: 10, file_hash: 'g1', has_thumbnail: false, created_at: '2026-10-04T10:00:00Z' },
      { id: 71, filename: 'gabarit.pdf', file_type: 'pdf', file_size: 10, file_hash: 'g2', has_thumbnail: false, created_at: '2026-10-04T10:00:00Z' },
    ] })] }] },
    { section: 'docs', items: [] },
  ],
};

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
  server.use(
    http.delete('/api/v1/projects/revisions/:rid/files/:fid', ({ params }) => {
      calls.push(`remove:${params.rid}:${params.fid}`);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/v1/projects/7/items', async ({ request }) => {
      const body = (await request.json()) as { name: string };
      calls.push(`create:${body.name}`);
      return HttpResponse.json({ id: 99, section: 'modelisation', name: body.name, name_key: body.name.toLowerCase(), forked_from: null, revisions: [] }, { status: 201 });
    }),
    http.get('/api/v1/projects/7/tree', () => HttpResponse.json(tree)),
    http.patch('/api/v1/projects/revisions/:id', async ({ request, params }) => {
      patched = { url: String(params.id), body: await request.json() };
      return HttpResponse.json(rev({ id: Number(params.id) }));
    }),
    http.post('/api/v1/projects/items/:id/revisions', async ({ params }) => {
      calls.push(`upload:${params.id}`);
      if (holdUpload) await holdUpload;
      if (failUpload) return HttpResponse.json({ detail: 'boom' }, { status: 500 });
      uploaded = String(params.id);
      return HttpResponse.json({ revision: rev({ id: 9, number: 3 }), warnings: [{ filename: 'b.step', same_as: 'R1' }] }, { status: 201 });
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
  it('lists sections in order with the newest revision chip', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    expect(await screen.findByText('Support')).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings.map((h) => h?.split(' ')[0])).toEqual(['Scan', 'Modeling', 'Printing', 'Machining', 'Documents']);
    expect(screen.getByText(/R2 · Approved/)).toBeInTheDocument();
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
    await userEvent.upload(input, new File(['x'], 'b.step'));
    await waitFor(() => expect(uploaded).toBe('20'));
    expect(await screen.findByText('b.step is identical to R1')).toBeInTheDocument();
  });

  it('shows the print profile of a sliced revision', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Support X1C$/ }));
    expect(screen.getByText(/Bambu Lab X1C/)).toBeInTheDocument();
    expect(screen.getByText('Sliced')).toBeInTheDocument();
  });

  const drop = (el: Element, name: string) =>
    fireEvent.drop(el, { dataTransfer: { files: [new File(['x'], name)], types: ['Files'] } });
  const sectionOf = (label: string) => screen.getByRole('heading', { level: 3, name: new RegExp(`^${label}`) }).closest('section')!;

  it('dropping on a section reuses an item with the same name, case-insensitively', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    drop(sectionOf('Modeling'), 'SUPPORT.stl');
    await waitFor(() => expect(calls).toEqual(['upload:20']));
  });

  it('dropping on a section matches items on the backend name key', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    drop(sectionOf('Modeling'), 'Sup:port.stl');
    await waitFor(() => expect(calls).toEqual(['upload:20']));
  });

  it('dropping a new name on a section creates the item then uploads', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    drop(sectionOf('Modeling'), 'bracket.stl');
    await waitFor(() => expect(calls).toEqual(['create:bracket', 'upload:99']));
  });

  it('dropping on an item row uploads once and does not create an item', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    const row = (await screen.findByRole('button', { name: /Support$/ })).closest('li')!;
    drop(row, 'other.stl');
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
    const section = sectionOf('Modeling');
    await userEvent.click(within(section).getByRole('button', { name: 'New item' }));
    await userEvent.type(within(section).getByLabelText('Item name'), 'bracket');
    await userEvent.upload(within(section).getByTestId('new-item-files-modelisation'), new File(['x'], 'bracket.stl'));
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
    await userEvent.click(within(screen.getByTestId('revision-4')).getByRole('button', { name: 'Remove gabarit.pdf' }));
    expect(screen.getByText('Remove gabarit.pdf from Gabarit R1? The file moves to the project trash.')).toBeInTheDocument();
    expect(calls).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls).toEqual(['remove:4:71']));
  });

  it('shows a busy state and blocks new uploads on an item while one runs', async () => {
    let release!: () => void;
    holdUpload = new Promise<void>((r) => { release = r; });
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    await userEvent.upload(screen.getByTestId('new-revision-input-20'), new File(['x'], 'b.step'));
    const row = screen.getByRole('button', { name: /Support$/ }).closest('li')!;
    expect(await within(row).findByText('Uploading…')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'New revision' })).toBeDisabled();
    drop(row, 'again.stl');
    drop(sectionOf('Modeling'), 'Support.stl');
    expect(calls).toEqual(['upload:20']);
    release();
    await waitFor(() => expect(within(row).queryByText('Uploading…')).not.toBeInTheDocument());
    expect(within(row).getByRole('button', { name: 'New revision' })).toBeEnabled();
  });

  it('shows the upload failure toast', async () => {
    failUpload = true;
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    await userEvent.upload(screen.getByTestId('new-revision-input-20'), new File(['x'], 'b.step'));
    expect(await screen.findByText(/Upload failed/)).toBeInTheDocument();
  });
});
