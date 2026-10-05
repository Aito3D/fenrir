import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { ProjectFilesPanel } from '../../../../components/projects/files/ProjectFilesPanel';
import { itemNameFromFile } from '../../../../components/projects/files/fileDrop';

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
    { section: 'modelisation', items: [{ id: 20, section: 'modelisation', name: 'Support', forked_from: null, revisions: [rev({ id: 2, number: 2, status: 'valide' }), rev({ id: 1, number: 1, status: 'obsolete', used: true })] }] },
    { section: 'impression', items: [{ id: 30, section: 'impression', name: 'Support X1C', forked_from: null, revisions: [rev({ id: 3, number: 1, derived_from: ref(1, 'Support', 'modelisation', 1, 'obsolete'), outdated_by: ref(2, 'Support', 'modelisation', 2), print_profile: { printer_model: 'Bambu Lab X1C', nozzle_diameter: '0.4', layer_height: '0.2', filament_types: ['PETG'], sliced: true }, has_snapshot: true, files: [{ id: 60, filename: 'support.gcode.3mf', file_type: 'gcode.3mf', file_size: 4096, file_hash: 'p', has_thumbnail: true, created_at: '2026-10-04T10:00:00Z' }] })] }] },
    { section: 'usinage', items: [] },
    { section: 'docs', items: [] },
  ],
};

let patched: { url: string; body: unknown } | null;
let uploaded: string | null;

beforeEach(() => {
  patched = null;
  uploaded = null;
  server.use(
    http.get('/api/v1/projects/7/tree', () => HttpResponse.json(tree)),
    http.patch('/api/v1/projects/revisions/:id', async ({ request, params }) => {
      patched = { url: String(params.id), body: await request.json() };
      return HttpResponse.json(rev({ id: Number(params.id) }));
    }),
    http.post('/api/v1/projects/items/:id/revisions', async ({ params }) => {
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
});
