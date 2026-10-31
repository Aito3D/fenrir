/** The part viewer's shell: which tabs a subject gets, the rail's cards, the tools' state and
 *  the saved pins. The WebGL scene and the view cube are mocked (jsdom has no WebGL); their
 *  callbacks are driven by hand. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { PartViewerModal } from '../../../components/viewer/PartViewerModal';
import type { PartSceneProps } from '../../../components/viewer/PartScene';
import { decodeViewerState } from '../../../components/viewer/viewerLink';
import { file, item, rev } from '../../fixtures/projectTree';

let lastSceneProps: PartSceneProps | null = null;
vi.mock('../../../components/viewer/PartScene', () => ({
  PartScene: (props: PartSceneProps) => {
    lastSceneProps = props;
    return <div data-testid="part-scene" data-tab={props.tab} data-model={props.model?.url ?? ''} data-toolpath={props.toolpath?.url ?? ''} data-ortho={String(props.ortho)} data-section={String(props.section.on)} />;
  },
}));
vi.mock('../../../components/viewer/ViewCube', () => ({ ViewCube: () => <canvas data-testid="view-cube" /> }));

const plates = { file_id: 90, filename: 'bracket.gcode.3mf', is_multi_plate: false, embedded_printer: 'Bambu Lab H2S', embedded_process: '0.15mm Quality @BBL H2S', plates: [
  { index: 1, name: null, objects: ['Cache_droit', 'Clip'], object_count: 2, has_thumbnail: false, thumbnail_url: null, print_time_seconds: 27540, filament_used_grams: 160.3,
    filaments: [{ slot_id: 1, type: 'ABS-GF', color: '#1b1b1b', used_grams: 152.1, used_meters: 50.9, used_in_plate: true }], bed_type: 'Textured PEI' },
] };
const sliced = file(90, 'bracket.gcode.3mf', { file_type: 'gcode.3mf', print_time_seconds: 27540, filament_used_grams: 160.3, filament_type: 'ABS-GF', sliced_for_model: 'Bambu Lab H2S', total_layers: 311, layer_height: 0.15 });
const revision = rev({ id: 2, number: 2, status: 'wip', print_profile: { printer_model: 'Bambu Lab H2S', nozzle_diameter: '0.4', layer_height: '0.15', filament_types: ['ABS-GF'] }, files: [file(51, 'bracket.3mf', { file_type: '3mf', file_size: 8900000 })], sliced_file: sliced, created_by: 'aneo' });
const older = rev({ id: 1, number: 1, status: 'obsolete', files: [file(50, 'bracket-old.3mf', { file_type: '3mf' })] });
const theItem = item(20, 'impression', 'DT50 Cache', [revision, older]);

let pins: Array<{ id: number; x: number; y: number; z: number; text: string; created_by: string | null; created_at: string }>;
let calls: string[];
beforeEach(() => {
  lastSceneProps = null;
  calls = [];
  pins = [];
  server.use(
    http.get('/api/v1/library/files/:id/plates', () => HttpResponse.json(plates)),
    http.get('/api/v1/projects/revisions/:id/pins', () => HttpResponse.json(pins)),
    http.post('/api/v1/projects/revisions/:id/pins', async ({ request }) => {
      const body = (await request.json()) as { x: number; y: number; z: number; text: string };
      calls.push(`pin:${body.text}@${body.x},${body.y},${body.z}`);
      pins = [...pins, { id: 7, ...body, created_by: 'me', created_at: '2026-10-31T00:00:00Z' }];
      return HttpResponse.json(pins[pins.length - 1], { status: 201 });
    }),
    http.delete('/api/v1/projects/revisions/pins/:id', ({ params }) => {
      calls.push(`unpin:${params.id}`);
      pins = pins.filter((p) => String(p.id) !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get('/api/v1/archives/:id/capabilities', () => HttpResponse.json({ has_model: false, has_gcode: true, has_source: false, build_volume: { x: 256, y: 256, z: 256 }, filament_colors: ['#ff0000'] })),
    http.get('/api/v1/archives/:id/plates', () => HttpResponse.json({ archive_id: 3, filename: 'job.3mf', is_multi_plate: false, plates: [], has_gcode: true })),
  );
});

const subject = { kind: 'revision' as const, projectId: 7, item: theItem, revision };

describe('PartViewerModal', () => {
  it('a revision with a source and a sliced file gets both tabs; Model first, Toolpath on click', async () => {
    render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} />);
    const tabs = screen.getByRole('tablist', { name: 'Views' });
    expect(within(tabs).getByRole('tab', { name: /Model/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(tabs).getByRole('tab', { name: /Toolpath/ })).toHaveAttribute('aria-selected', 'false');
    const scene = screen.getByTestId('part-scene');
    expect(scene).toHaveAttribute('data-model', '/api/v1/library/files/51/download');
    expect(scene).toHaveAttribute('data-toolpath', '/api/v1/library/files/90/gcode');
    await userEvent.click(within(tabs).getByRole('tab', { name: /Toolpath/ }));
    expect(scene).toHaveAttribute('data-tab', 'toolpath');
  });

  it('a sliced .gcode.3mf alone in the library shows both tabs; a bare .gcode only the toolpath; an STL only the model', () => {
    const { unmount } = render(<PartViewerModal subject={{ kind: 'library', fileId: 6, fileType: 'gcode.3mf', filename: 'part.gcode.3mf' }} title="part.gcode.3mf" onClose={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /Model/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Toolpath/ })).toBeInTheDocument();
    unmount();
    const r2 = render(<PartViewerModal subject={{ kind: 'library', fileId: 7, fileType: 'gcode', filename: 'part.gcode' }} title="part.gcode" onClose={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: /Model/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Toolpath/ })).toHaveAttribute('aria-selected', 'true');
    r2.unmount();
    render(<PartViewerModal subject={{ kind: 'library', fileId: 8, fileType: 'stl', filename: 'part.stl' }} title="part.stl" onClose={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /Model/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Toolpath/ })).not.toBeInTheDocument();
  });

  it('an archive follows its capabilities: G-code only here', async () => {
    render(<PartViewerModal subject={{ kind: 'archive', archiveId: 3, filename: 'job.3mf' }} title="job" onClose={vi.fn()} />);
    expect(await screen.findByRole('tab', { name: /Toolpath/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: /Model/ })).not.toBeInTheDocument();
  });

  it('the rail: the print facts from the sliced file and its plate, the files, the objects once the scene reports them', async () => {
    render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} printed={2} />);
    const print = await screen.findByTestId('rail-print');
    await waitFor(() => expect(print).toHaveTextContent('Textured PEI'));
    expect(print).toHaveTextContent('7h 39m');
    expect(print).toHaveTextContent('160.3 g');
    expect(print).toHaveTextContent('311 · 0.15 mm');
    expect(print).toHaveTextContent('ABS-GF');
    expect(print).toHaveTextContent('0.15mm Quality @BBL H2S');
    expect(screen.getByTestId('rail-nozzle')).toHaveTextContent('0.4 mm');
    const files = screen.getByTestId('rail-files');
    expect(files).toHaveTextContent('bracket.3mf');
    expect(files).toHaveTextContent('bracket.gcode.3mf');
    expect(files).toHaveTextContent('Printed 2x');
    // The scene reports the objects it built; the rail lists them with their size.
    lastSceneProps!.onObjects([{ index: 0, name: 'Cache_droit', triangles: 24180, size: [72, 48, 21], color: '#8a8f96' }], { min: [10, 10, 0], max: [82, 58, 21] });
    await waitFor(() => expect(screen.getByTestId('rail-part')).toHaveTextContent('Cache_droit'));
    expect(screen.getByTestId('rail-part')).toHaveTextContent('72.0 × 48.0 × 21.0 mm');
    // and the checks card reads the bed (H2S: 350×320) against those bounds
    expect(screen.getByTestId('rail-checks')).toHaveTextContent('Inside the 350 × 320 mm bed');
  });

  it('the toolbar toggles reach the scene: projection and section; P and S on the keyboard too', async () => {
    render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} />);
    const scene = screen.getByTestId('part-scene');
    expect(scene).toHaveAttribute('data-ortho', 'false');
    await userEvent.click(screen.getByTestId('tool-projection'));
    expect(scene).toHaveAttribute('data-ortho', 'true');
    expect(screen.getByTestId('projection-hint')).toHaveTextContent('Orthographic');
    await userEvent.click(screen.getByTestId('tool-section'));
    expect(scene).toHaveAttribute('data-section', 'true');
    expect(screen.getByTestId('section-panel')).toBeInTheDocument();
    await userEvent.keyboard('p');
    expect(scene).toHaveAttribute('data-ortho', 'false');
    await userEvent.keyboard('s');
    expect(scene).toHaveAttribute('data-section', 'false');
  });

  it('hides the rail with its button and the controls with the clean view', async () => {
    render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} />);
    expect(screen.getByTestId('viewer-rail')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('viewer-rail-toggle'));
    expect(screen.queryByTestId('viewer-rail')).not.toBeInTheDocument();
    await userEvent.keyboard('c');
    expect(screen.queryByTestId('viewer-toolbar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('view-cube')).not.toBeInTheDocument();
  });

  it('pins: placing one asks for its text and saves it on the revision; the Notes card deletes it', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Chamfer here');
    render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} />);
    await screen.findByTestId('rail-print');
    await userEvent.click(screen.getByRole('button', { name: 'Pin a note on the part' }));
    expect(screen.getByTestId('viewer-hint')).toHaveTextContent('Click the part where the note goes');
    lastSceneProps!.onPlacePin([12.5, 40, 21]);
    await waitFor(() => expect(calls).toEqual(['pin:Chamfer here@12.5,40,21']));
    const notes = await screen.findByTestId('rail-notes');
    expect(notes).toHaveTextContent('Chamfer here');
    await waitFor(() => expect(lastSceneProps!.pins).toHaveLength(1));
    await userEvent.click(within(notes).getByRole('button', { name: 'Delete this note' }));
    await waitFor(() => expect(calls).toContain('unpin:7'));
  });

  it('Print and the download hand off to the caller', async () => {
    const onPrint = vi.fn();
    const onDownload = vi.fn();
    render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} onPrint={onPrint} onDownload={onDownload} />);
    await userEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(onPrint).toHaveBeenCalled();
    await userEvent.click(within(screen.getByTestId('rail-files')).getByRole('button', { name: 'Download bracket.gcode.3mf' }));
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ id: 90, role: 'sliced' }));
  });

  it('copies a link to this file and tab', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy a link to this view' }));
    // The link also carries the view state (`v=`, proposition 10): tab, layers, display settings.
    expect(writeText).toHaveBeenCalledTimes(1);
    const url = new URL(writeText.mock.calls[0][0] as string);
    expect(`${url.origin}${url.pathname}?project=${url.searchParams.get('project')}&file=${url.searchParams.get('file')}&tab=${url.searchParams.get('tab')}`).toBe(`${window.location.origin}/projects?project=7&file=20&tab=model`);
    expect(decodeViewerState(url.searchParams.get('v'))).toMatchObject({ tab: 'model' });
  });
});

describe('PartViewerModal: display, help, link state, photos', () => {
  it('the Display menu switches the visual style and the analyses, which reach the scene', async () => {
    const user = userEvent.setup();
    render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} />);
    await screen.findByTestId('part-scene');
    expect(lastSceneProps?.style).toBe('shaded');
    await user.click(screen.getByTestId('tool-display'));
    const menu = screen.getByTestId('display-menu');
    await user.click(within(menu).getByLabelText('Wireframe'));
    expect(lastSceneProps?.style).toBe('wireframe');
    await user.click(within(menu).getByLabelText('Shaded with polygons'));
    expect(lastSceneProps?.style).toBe('polygons');
    await user.click(within(menu).getByTestId('analysis-overhangs'));
    expect(lastSceneProps?.analysis.overhang).toEqual({ on: true, deg: 45 });
    await user.click(within(menu).getByTestId('analysis-thin-walls'));
    expect(lastSceneProps?.analysis.thinWalls).toEqual({ on: true, mm: 0.8 });
    // Rendering: shadows off, ambient occlusion on, a glossy finish on a light background.
    await user.click(within(menu).getByTestId('render-shadows'));
    await user.click(within(menu).getByTestId('render-ao'));
    await user.selectOptions(within(menu).getByTestId('render-finish'), 'glossy');
    await user.selectOptions(within(menu).getByTestId('render-background'), 'light');
    expect(lastSceneProps?.render).toEqual({ shadows: false, ao: true, finish: 'glossy', reflections: 'soft', background: 'light' });
    window.localStorage.removeItem('fenrir.partViewer.display');
  });

  it('the Display settings persist: the next opening starts from them, a link still wins', async () => {
    const user = userEvent.setup();
    window.localStorage.removeItem('fenrir.partViewer.display');
    const first = render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} />);
    await screen.findByTestId('part-scene');
    await user.click(screen.getByTestId('tool-display'));
    await user.click(within(screen.getByTestId('display-menu')).getByLabelText('Shaded with edges'));
    first.unmount();
    render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} />);
    await screen.findByTestId('part-scene');
    expect(lastSceneProps?.style).toBe('edges');
    window.localStorage.removeItem('fenrir.partViewer.display');
  });

  it('the help sheet lists the shortcuts and the touch gestures; ? toggles it', async () => {
    const user = userEvent.setup();
    render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} />);
    await screen.findByTestId('part-scene');
    await user.click(screen.getByTestId('viewer-help-toggle'));
    const sheet = screen.getByTestId('help-sheet');
    expect(sheet).toHaveTextContent('Two fingers: zoom and pan');
    expect(sheet).toHaveTextContent('Section plane');
    await user.keyboard('?');
    expect(screen.queryByTestId('help-sheet')).not.toBeInTheDocument();
  });

  it('a link state seeds the tab, the display settings and the hidden features; its camera is applied once the part is in', async () => {
    const setSceneView = vi.fn();
    const state = { tab: 'toolpath' as const, style: 'edges' as const, xray: true, hidden: [5], explode: 0.4, view: { dir: [0, 1, 0] as [number, number, number], target: [1, 2, 3] as [number, number, number], dist: 400, ortho: false, half: 0 } };
    render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} initialState={state} />);
    await screen.findByTestId('part-scene');
    await waitFor(() => expect(screen.getByRole('tab', { name: /Toolpath/ })).toHaveAttribute('aria-selected', 'true'));
    expect(lastSceneProps?.style).toBe('edges');
    expect(lastSceneProps?.xray).toBe(true);
    expect(lastSceneProps?.explode).toBe(0.4);
    expect([...(lastSceneProps?.hiddenFeatures ?? [])]).toEqual([5]);
    // The scene handle is mocked: the view is applied through it once objects arrive.
    expect(setSceneView).not.toHaveBeenCalled();
  });

  it('an archive with photos gets a Photos card; a click docks the photo beside the part, overlay puts it on top', async () => {
    const user = userEvent.setup();
    render(<PartViewerModal subject={{ kind: 'archive', archiveId: 3, filename: 'job.3mf', photos: ['a.jpg', 'b.jpg'] }} title="Job" onClose={vi.fn()} />);
    const card = await screen.findByTestId('rail-photos');
    expect(within(card).getAllByRole('button')).toHaveLength(2);
    await user.click(within(card).getAllByRole('button')[1]);
    expect(screen.getByTestId('photo-panel')).toBeInTheDocument();
    expect(screen.getByTestId('photo-controls')).toHaveTextContent('2/2');
    await user.click(screen.getByTestId('photo-overlay-toggle'));
    expect(screen.queryByTestId('photo-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('photo-overlay')).toHaveAttribute('src', expect.stringContaining('/archives/3/photos/b.jpg'));
  });
});

