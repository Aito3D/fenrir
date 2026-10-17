import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { holdToConfirm } from '../../../holdHelpers';
import { ProjectFilesPanel } from '../../../../components/projects/files/ProjectFilesPanel';
import { itemNameFromFile, itemNameKey } from '../../../../components/projects/files/fileDrop';
import type { ProjectRevisionOut } from '../../../../api/client';
import { file, item, projectTree, ref, rev as baseRev } from '../../../fixtures/projectTree';

// This suite's revisions carry no print_count (left out of the JSON) and default to one 3MF hashed 'h'.
const rev = (over: Partial<ProjectRevisionOut>) =>
  baseRev({ print_count: undefined, files: [file(50, 'support.3mf', { file_hash: 'h' })], ...over });
const tree = projectTree({
  impression: [
    item(20, 'impression', 'Support', [rev({ id: 2, number: 2, status: 'valide' }), rev({ id: 1, number: 1, status: 'obsolete', used: true })]),
    item(30, 'impression', 'Support X1C', [rev({
      id: 3, number: 1, derived_from: ref(1, 'Support', 'modelisation', 1, 'obsolete'), outdated_by: ref(2, 'Support', 'modelisation', 2),
      print_profile: { printer_model: 'Bambu Lab X1C', nozzle_diameter: '0.4', layer_height: '0.2', filament_types: ['PETG'], sliced: true },
      has_snapshot: true,
      files: [file(60, 'support.gcode.3mf', { file_type: 'gcode.3mf', file_size: 4096, file_hash: 'p', has_thumbnail: true })],
    })]),
    item(40, 'impression', 'Gabarit', [rev({ id: 4, number: 1, files: [
      file(70, 'gabarit.3mf', { file_size: 10, file_hash: 'g1' }),
      file(71, 'gabarit.gcode', { file_size: 10, file_hash: 'g2' }),
    ] })]),
  ],
  docs: [item(50, 'docs', 'Plan', [rev({ id: 5, number: 1, files: [file(80, 'plan.pdf', { file_size: 10, file_hash: 'd1' })] })])],
});
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

const ONLY_SOURCE = 'Only Bambu Studio project files (.3mf) can be added. Sliced files (.gcode.3mf, .gcode) are made by the server.';

describe('ProjectFilesPanel', () => {
  const drop = (el: Element, name: string) =>
    fireEvent.drop(el, { dataTransfer: { files: [new File(['x'], name)], types: ['Files'] } });
  const sectionOf = (label: string) => screen.getByRole('heading', { level: 3, name: new RegExp(`^${label}`) }).closest('section')!;
  const cardOf = (id: number) => screen.getByTestId(`item-card-${id}`);
  /** Opens an item's details tray from its card name. */
  const openTray = async (id: number) => {
    const card = await screen.findByTestId(`item-card-${id}`);
    // The name button (the ⋯ menu button also carries aria-expanded, plus aria-haspopup).
    await userEvent.click(within(card).getAllByRole('button', { expanded: false }).find((el) => !el.hasAttribute('aria-haspopup'))!);
    return screen.getByTestId(`item-tray-${id}`);
  };

  it('shows only the Printing section, with the newest revision chip', async () => {
    treeBody = printingOnly;
    render(<ProjectFilesPanel projectId={7} />);
    expect(await screen.findByText('Support')).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings.map((h) => h?.split(' ')[0])).toEqual(['Printing']);
    for (const disabled of ['Scan', 'Modeling', 'Machining', 'Documents', 'Older files']) {
      expect(screen.queryByText(disabled)).not.toBeInTheDocument();
    }
    expect(within(cardOf(20)).getByRole('button', { name: 'R2' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(cardOf(20)).getByText('Approved')).toBeInTheDocument();
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
    // Positive control through the same handler: a stray upload of Plan would have been sent
    // first, so it is recorded by the time this one is.
    drop(screen.getByRole('button', { name: /Support$/ }).closest('li')!, 'other.3mf');
    await waitFor(() => expect(calls).toContain('upload:20'));
    expect(calls).toEqual(['upload:20']);
  });

  it('upload inputs accept one source .3mf only', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    expect(screen.getByTestId('new-revision-input-20')).toHaveAttribute('accept', '.3mf');
    expect(screen.getByTestId('new-revision-input-20')).not.toHaveAttribute('multiple');
    const section = sectionOf('Printing');
    await userEvent.click(within(section).getByRole('button', { name: 'New item' }));
    expect(within(section).getByTestId('new-item-files-impression')).toHaveAttribute('accept', '.3mf');
    expect(within(section).getByTestId('new-item-files-impression')).not.toHaveAttribute('multiple');
  });

  it('picking a .stl in the upload input toasts and sends nothing', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    // fireEvent: userEvent.upload would silently drop the file on the `accept` filter.
    fireEvent.change(screen.getByTestId('new-revision-input-20'), { target: { files: [new File(['x'], 'mesh.stl')] } });
    expect(await screen.findByText(ONLY_SOURCE)).toBeInTheDocument();
    // Positive control on another item (a stray upload would leave item 20 busy): any upload
    // of the .stl was sent before it, so it is recorded by the time this one is.
    fireEvent.change(screen.getByTestId('new-revision-input-30'), { target: { files: [new File(['x'], 'b.3mf')] } });
    await waitFor(() => expect(calls).toContain('upload:30'));
    expect(calls).toEqual(['upload:30']);
  });

  it('dropping a mixed set on the section toasts and neither creates nor uploads', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    fireEvent.drop(sectionOf('Printing'), {
      dataTransfer: { files: [new File(['x'], 'bracket.3mf'), new File(['x'], 'bracket.step')], types: ['Files'] },
    });
    expect(await screen.findByText(ONLY_SOURCE)).toBeInTheDocument();
    // Positive control down the same create-then-upload path: a stray create of "bracket" was
    // sent first, so it would be recorded ahead of this one.
    drop(sectionOf('Printing'), 'clamp.3mf');
    await waitFor(() => expect(calls).toContain('upload:99'));
    expect(calls).toEqual(['create:clamp', 'upload:99']);
  });

  it('picking a non-printing file in the new-item form toasts and keeps the form empty', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    const section = sectionOf('Printing');
    await userEvent.click(within(section).getByRole('button', { name: 'New item' }));
    fireEvent.change(within(section).getByTestId('new-item-files-impression'), { target: { files: [new File(['x'], 'plan.pdf')] } });
    expect(await screen.findByText(ONLY_SOURCE)).toBeInTheDocument();
    expect(within(section).getByLabelText('Item name')).toHaveValue('');
    expect(within(section).getByRole('button', { name: 'Choose files' })).toBeInTheDocument();
    expect(within(section).queryByRole('combobox')).not.toBeInTheDocument(); // no section picker
  });

  it('flags an outdated print revision and its source', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    const badge = within(await screen.findByTestId('item-card-30')).getByText('Outdated');
    expect(badge).toHaveAttribute('title', 'Outdated — based on Support R1, R2 approved since');
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
    await openTray(20);
    await userEvent.click(within(cardOf(20)).getByRole('button', { name: 'R1' }));
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
    const card = await screen.findByTestId('item-card-30');
    expect(within(card).getByText('Bambu Lab X1C · 0.4 mm · 0.2 mm · PETG')).toBeInTheDocument();
    expect(within(card).getByText('Sliced')).toBeInTheDocument();
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
    drop(sectionOf('Printing'), 'Sup:port.3mf');
    await waitFor(() => expect(calls).toEqual(['upload:20']));
  });

  it('dropping a new name on a section creates the item then uploads', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    drop(sectionOf('Printing'), 'bracket.3mf');
    await waitFor(() => expect(calls).toEqual(['create:bracket', 'upload:99']));
  });

  it('the dashed drop card creates an item from a dropped or picked .3mf, and the section does not take it too', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Support');
    const dropCard = screen.getByRole('button', { name: /Drop a \.3mf or click/ }).closest('li')!;
    drop(dropCard, 'bracket.3mf');
    await waitFor(() => expect(calls).toEqual(['create:bracket', 'upload:99']));
    fireEvent.change(screen.getByTestId('new-item-drop-input-impression'), { target: { files: [new File(['x'], 'Support.3mf')] } });
    await waitFor(() => expect(calls).toEqual(['create:bracket', 'upload:99', 'upload:20']));
  });

  it('cards sit in the File Manager grid, and the tray opens as a full-width cell right after its card', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await openTray(20);
    const grid = cardOf(20).parentElement!;
    // One full-width card per row on a phone (44px action buttons), at most 5 per row.
    expect(grid.className.split(' ').filter((c) => c.includes('grid-cols-'))).toEqual(['grid-cols-1', 'sm:grid-cols-2', 'lg:grid-cols-3', 'xl:grid-cols-4', '2xl:grid-cols-5']);
    expect(grid.className).toContain('grid-flow-row-dense');
    expect(cardOf(20).nextElementSibling).toBe(screen.getByTestId('item-tray-20'));
    await openTray(30); // one tray at a time
    expect(screen.queryByTestId('item-tray-20')).not.toBeInTheDocument();
    expect(screen.getByTestId('item-tray-30')).toBeInTheDocument();
  });

  it('polls the tree every 3 s while a revision slices, and stops once none does', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let gets = 0;
      const slicing = projectTree({ impression: [item(20, 'impression', 'Support', [rev({ id: 2, number: 1, slice_status: 'slicing', slice_job_id: 5 })])] });
      server.use(
        http.get('/api/v1/projects/7/tree', () => { gets += 1; return HttpResponse.json(gets < 2 ? slicing : printingOnly); }),
        http.get('/api/v1/slice-jobs/5', () => HttpResponse.json({ detail: 'gone' }, { status: 404 })),
      );
      render(<ProjectFilesPanel projectId={7} />);
      await screen.findByText('Slicing…');
      expect(gets).toBe(1);
      await act(() => vi.advanceTimersByTimeAsync(3100));
      await waitFor(() => expect(gets).toBe(2));
      await act(() => vi.advanceTimersByTimeAsync(6200));
      expect(gets).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dropping on an item row uploads once and does not create an item', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    const row = (await screen.findByRole('button', { name: /Support$/ })).closest('li')!;
    drop(row, 'other.3mf');
    await waitFor(() => expect(calls).toEqual(['upload:20']));
    // Positive control on another row: a second upload of the first drop (say, the section
    // taking it too) was sent before this one, so it is recorded by the time this one is.
    drop(screen.getByRole('button', { name: /Support X1C$/ }).closest('li')!, 'other.3mf');
    await waitFor(() => expect(calls).toContain('upload:30'));
    expect(calls).toEqual(['upload:20', 'upload:30']);
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

  it('shows the OUTDATED badge on the card, and the full chip only in the revision block once opened', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    const outdated = /Outdated — based on Support R1/;
    expect(within(await screen.findByTestId('item-card-30')).getByText('Outdated')).toBeInTheDocument();
    expect(screen.queryByText(outdated)).not.toBeInTheDocument();
    await openTray(30);
    expect(screen.getAllByText(outdated)).toHaveLength(1);
    expect(within(screen.getByTestId('revision-3')).getByText(outdated)).toBeInTheDocument();
  });

  it('removes a file from a revision only on a full hold', async () => {
    render(<ProjectFilesPanel projectId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
    await userEvent.click(within(screen.getByTestId('revision-4')).getByRole('button', { name: 'Remove gabarit.gcode' }));
    expect(calls).toEqual([]);
    await holdToConfirm(within(screen.getByTestId('revision-4')).getByRole('button', { name: 'Remove gabarit.gcode' }));
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
    expect(row.className).toContain('ring-bambu-green');
    drop(row, 'again.3mf');
    expect(row.className).not.toContain('ring-bambu-green');
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
  describe('Re-slice hidden', () => {
    it('offers no Re-slice button and no Add files button', async () => {
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Support$/ }));
      await userEvent.click(screen.getByRole('button', { name: /Gabarit$/ }));
      expect(screen.queryByRole('button', { name: /Re-slice/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add files' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('add-files-input-4')).not.toBeInTheDocument();
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
      expect(within(row).getByRole('button', { name: 'R2' })).toHaveAttribute('aria-pressed', 'true');
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

    it('shows the translated copy for the server 400s, with the file name', async () => {
      const cases: [string, string][] = [
        ['server: already sliced', 'b.3mf is already sliced. Upload the original .3mf project instead.'],
        ['server: no printer setup', 'b.3mf has no printer setup. Open it in Bambu Studio, choose the printer, and save it as a project.'],
        ['server: one .3mf only', 'A revision holds one .3mf. Upload each part as its own item.'],
        ['server: Only Bambu Studio project files', ONLY_SOURCE],
        ['Server says something else', 'Upload failed: Server says something else'],
      ];
      render(<ProjectFilesPanel projectId={7} />);
      await screen.findByText('Support');
      for (const [detail, shown] of cases) {
        fail('post', '/api/v1/projects/items/:id/revisions', 400, detail);
        await userEvent.upload(screen.getByTestId('new-revision-input-20'), new File(['x'], 'b.3mf'));
        expect(await screen.findByText(shown)).toBeInTheDocument();
      }
    });

    it('a 400 "already sliced" toasts the translated copy with the name (not the server text)', async () => {
      fail('post', '/api/v1/projects/items/:id/revisions', 400, 'server: already sliced');
      render(<ProjectFilesPanel projectId={7} />);
      await screen.findByText('Support');
      await userEvent.upload(screen.getByTestId('new-revision-input-20'), new File(['x'], 'x.3mf'));
      expect(await screen.findByText('x.3mf is already sliced. Upload the original .3mf project instead.')).toBeInTheDocument();
      expect(screen.queryByText(/Upload failed/)).not.toBeInTheDocument();
    });

    it('refuses a dropped .gcode.3mf before sending anything', async () => {
      render(<ProjectFilesPanel projectId={7} />);
      await screen.findByText('Support');
      drop(sectionOf('Printing'), 'a.gcode.3mf');
      expect(await screen.findByText(ONLY_SOURCE)).toBeInTheDocument();
      drop(sectionOf('Printing'), 'clamp.3mf'); // positive control: nothing from the refused drop was sent first
      await waitFor(() => expect(calls).toContain('upload:99'));
      expect(calls).toEqual(['create:clamp', 'upload:99']);
    });

    it('refuses two dropped .3mf files with the one-file copy and sends nothing', async () => {
      render(<ProjectFilesPanel projectId={7} />);
      await screen.findByText('Support');
      fireEvent.drop(sectionOf('Printing'), {
        dataTransfer: { files: [new File(['x'], 'a.3mf'), new File(['x'], 'b.3mf')], types: ['Files'] },
      });
      expect(await screen.findByText('A revision holds one .3mf. Upload each part as its own item.')).toBeInTheDocument();
      drop(sectionOf('Printing'), 'clamp.3mf');
      await waitFor(() => expect(calls).toContain('upload:99'));
      expect(calls).toEqual(['create:clamp', 'upload:99']);
    });

    it('keeps the old name when a rename hits a 409 name conflict', async () => {
      fail('patch', '/api/v1/projects/items/:id', 409, 'An item with this name already exists');
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(within(await openTray(20)).getByRole('button', { name: 'Rename' }));
      const input = screen.getByRole('textbox', { name: 'Rename' });
      await userEvent.clear(input);
      await userEvent.type(input, 'Gabarit{Enter}');
      expect(await screen.findByText('Could not save: An item with this name already exists')).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Support$/ })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /Gabarit$/ })).toHaveLength(1);
    });

    it('keeps the item when deleting it is refused', async () => {
      fail('delete', '/api/v1/projects/items/:id', 409, 'Item has used revisions');
      render(<ProjectFilesPanel projectId={7} />);
      await holdToConfirm(within(await openTray(20)).getByRole('button', { name: 'Delete item' }));
      expect(await screen.findByText('Could not save: Item has used revisions')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Support$/ })).toBeInTheDocument();
    });

    it('keeps the revision when deleting it is refused', async () => {
      fail('delete', '/api/v1/projects/revisions/:id', 409, 'Revision is in use');
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
      const block = screen.getByTestId('revision-4');
      await holdToConfirm(within(block).getByRole('button', { name: 'Delete revision' }));
      expect(await screen.findByText('Could not save: Revision is in use')).toBeInTheDocument();
      expect(screen.getByTestId('revision-4')).toBeInTheDocument();
    });

    it('keeps the file when removing it is refused', async () => {
      fail('delete', '/api/v1/projects/revisions/:rid/files/:fid', 409, 'Revision is frozen');
      render(<ProjectFilesPanel projectId={7} />);
      await userEvent.click(await screen.findByRole('button', { name: /Gabarit$/ }));
      await holdToConfirm(within(screen.getByTestId('revision-4')).getByRole('button', { name: 'Remove gabarit.gcode' }));
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
      const tray = await openTray(20);
      const row = () => tray;
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
      await userEvent.click(within(await openTray(20)).getByRole('button', { name: 'Rename' }));
      await userEvent.clear(screen.getByRole('textbox', { name: 'Rename' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Rename' }), 'Nouveau{Enter}');
      await waitFor(() => expect(calls).toEqual(['rename:20']));
      expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument();
    });
  });
});
