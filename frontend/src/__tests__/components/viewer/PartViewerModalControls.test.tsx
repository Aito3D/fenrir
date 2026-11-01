/** The part viewer's controls beyond the shell: the keyboard shortcuts that drive the scene
 *  handle, the explode and section panels, the loading overlay and the error alert, the
 *  toolpath tab (layer slider, legend, playback), the compare menu, the rail's plates, bed and
 *  object rows, the snapshot and thumbnail actions, the slicer hand-off and the photo controls.
 *  The scene is mocked with a handle whose methods are spies; its callbacks are driven by hand. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { PartViewerModal } from '../../../components/viewer/PartViewerModal';
import type { PartSceneProps, ToolpathStats } from '../../../components/viewer/PartScene';
import { openInSlicer } from '../../../utils/slicer';
import { file, item, rev } from '../../fixtures/projectTree';

const handle = vi.hoisted(() => ({
  fit: vi.fn(),
  goTo: vi.fn(),
  orbit: vi.fn(),
  getView: vi.fn(() => null),
  getSceneView: vi.fn(() => null),
  setSceneView: vi.fn(),
  snapshot: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}));
/** The scene's latest props, recorded by the mock's ref callback (a commit-time side effect, not a render one). */
const seen = vi.hoisted(() => ({ props: null as unknown }));
vi.mock('../../../components/viewer/PartScene', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    PartScene: forwardRef<unknown, PartSceneProps>((props, ref) => {
      useImperativeHandle(ref, () => handle);
      return <div data-testid="part-scene" data-tab={props.tab} ref={() => { seen.props = props; }} />;
    }),
  };
});
vi.mock('../../../components/viewer/ViewCube', () => ({ ViewCube: () => <canvas data-testid="view-cube" /> }));
vi.mock('../../../utils/slicer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/slicer')>()),
  openInSlicer: vi.fn(),
}));

const plate = (index: number, objects: string[]) => ({
  index, name: null, objects, object_count: objects.length, has_thumbnail: index === 2, thumbnail_url: index === 2 ? '/api/v1/library/files/90/plates/2/thumbnail' : null,
  print_time_seconds: 27540, filament_used_grams: 160.3, filaments: [{ slot_id: 1, type: 'ABS-GF', color: '#1b1b1b', used_grams: 152.1, used_meters: 50.9, used_in_plate: true }], bed_type: 'Textured PEI',
});
let plates: unknown = { file_id: 90, filename: 'bracket.gcode.3mf', is_multi_plate: false, embedded_printer: 'Bambu Lab H2S', embedded_process: '0.15mm Quality @BBL H2S', plates: [plate(1, ['Cache_droit', 'Clip'])] };
const sliced = file(90, 'bracket.gcode.3mf', { file_type: 'gcode.3mf', print_time_seconds: 27540, filament_used_grams: 160.3, filament_type: 'ABS-GF', sliced_for_model: 'Bambu Lab H2S', total_layers: 311, layer_height: 0.15 });
const revision = rev({ id: 2, number: 2, status: 'wip', print_profile: { printer_model: 'Bambu Lab H2S', nozzle_diameter: '0.4', layer_height: '0.15', filament_types: ['ABS-GF'] }, files: [file(51, 'bracket.3mf', { file_type: '3mf', file_size: 8900000 })], sliced_file: sliced, created_by: 'aneo' });
const older = rev({ id: 1, number: 1, status: 'obsolete', files: [file(50, 'bracket-old.3mf', { file_type: '3mf' })] });
const noSource = rev({ id: 3, number: 3, status: 'wip', files: [file(52, 'bracket.gcode.3mf', { file_type: 'gcode.3mf' })] });
const theItem = item(20, 'impression', 'DT50 Cache', [revision, older, noSource]);
const subject = { kind: 'revision' as const, projectId: 7, item: theItem, revision };

const objects = [
  { index: 0, name: 'Cache_droit', triangles: 24180, size: [72, 48, 21] as [number, number, number], color: '#8a8f96' },
  { index: 1, name: 'Clip', triangles: 900, size: [12, 8, 4] as [number, number, number], color: '#8a8f96' },
];
const bounds = { min: [10, 10, 0] as [number, number, number], max: [82, 58, 21] as [number, number, number] };

const stats = (layerCount: number, over: Partial<ToolpathStats> = {}): ToolpathStats => {
  const typeShares = new Array(16).fill(0);
  typeShares[12] = 0.5; // outer wall
  typeShares[2] = 0.3; // sparse infill
  typeShares[5] = 0.2; // support
  return {
    layerCount,
    typeShares,
    speedRange: { min: 8, max: 250 },
    flowRange: { min: 0.5, max: 12 },
    zPerLayer: Array.from({ length: layerCount }, (_, i) => (i + 1) * 0.2),
    remainingPerLayer: new Array(layerCount).fill(null),
    segmentsPerLayer: Array.from({ length: layerCount }, (_, i) => i + 1),
    ...over,
  };
};

let calls: string[];
beforeEach(() => {
  seen.props = null;
  calls = [];
  for (const fn of Object.values(handle)) fn.mockClear();
  vi.mocked(openInSlicer).mockClear();
  plates = { file_id: 90, filename: 'bracket.gcode.3mf', is_multi_plate: false, embedded_printer: 'Bambu Lab H2S', embedded_process: '0.15mm Quality @BBL H2S', plates: [plate(1, ['Cache_droit', 'Clip'])] };
  server.use(
    http.get('/api/v1/library/files/:id/plates', () => HttpResponse.json(plates)),
    http.get('/api/v1/projects/revisions/:id/pins', () => HttpResponse.json([])),
    http.post('/api/v1/library/files/:id/preview-thumbnail', ({ params }) => {
      calls.push(`thumbnail:${params.id}`);
      return HttpResponse.json({ updated: true });
    }),
    http.post('/api/v1/library/files/:id/slicer-token', ({ params }) => {
      calls.push(`token:${params.id}`);
      return HttpResponse.json({ token: 'tok' });
    }),
    http.post('/api/v1/archives/:id/slicer-token', ({ params }) => {
      calls.push(`archive-token:${params.id}`);
      return HttpResponse.json({ token: 'atok' });
    }),
    http.get('/api/v1/archives/:id/capabilities', () => HttpResponse.json({ has_model: false, has_gcode: true, has_source: false, build_volume: { x: 256, y: 256, z: 256 }, filament_colors: ['#ff0000'] })),
    http.get('/api/v1/archives/:id/plates', () => HttpResponse.json({ archive_id: 3, filename: 'job.3mf', is_multi_plate: false, plates: [], has_gcode: true })),
  );
});
afterEach(() => {
  window.localStorage.removeItem('fenrir.partViewer.display');
});

const scene = () => seen.props as PartSceneProps;
const open = async () => {
  render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} />);
  await screen.findByTestId('part-scene');
};

describe('PartViewerModal: keyboard', () => {
  it('number keys and space drive the camera through the scene handle; keys typed in a field are left alone', async () => {
    await open();
    await userEvent.keyboard('1234 ');
    expect(handle.goTo.mock.calls).toEqual([[[1, 0.85, 1]], [[0, 1, 0]], [[0, 0, 1]], [[1, 0, 0]]]);
    expect(handle.fit).toHaveBeenCalledTimes(1);
    // The same keys inside a form control (the Display menu's finish select) do nothing.
    await userEvent.click(screen.getByTestId('tool-display'));
    screen.getByTestId('render-finish').focus();
    await userEvent.keyboard('1 ');
    expect(handle.goTo).toHaveBeenCalledTimes(4);
    expect(handle.fit).toHaveBeenCalledTimes(1);
    // Escape closes the Display menu (and the help sheet) without closing the viewer.
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('display-menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('part-scene')).toBeInTheDocument();
  });

  it('letter shortcuts toggle the grid, x-ray, dimensions, measure, turntable, rail, style, explode and the analyses', async () => {
    await open();
    expect(scene().grid).toBe(true);
    await userEvent.keyboard('g');
    expect(scene().grid).toBe(false);
    await userEvent.keyboard('x');
    expect(scene().xray).toBe(true);
    await userEvent.keyboard('d');
    expect(scene().dims).toBe(true);
    await userEvent.keyboard('m');
    expect(scene().tool).toBe('measure');
    expect(screen.getByTestId('viewer-hint')).toHaveTextContent('Click two points on the part');
    await userEvent.keyboard('m');
    expect(scene().tool).toBe('none');
    expect(screen.queryByTestId('viewer-hint')).not.toBeInTheDocument();
    await userEvent.keyboard('r');
    expect(scene().turntable).toBe(true);
    await userEvent.keyboard('i');
    expect(screen.queryByTestId('viewer-rail')).not.toBeInTheDocument();
    // V cycles the five styles and wraps.
    for (const expected of ['edges', 'hiddenEdges', 'wireframe', 'polygons', 'shaded']) {
      await userEvent.keyboard('v');
      expect(scene().style).toBe(expected);
    }
    await userEvent.keyboard('e');
    expect(scene().explode).toBe(0.6);
    await userEvent.keyboard('e');
    expect(scene().explode).toBe(0);
    await userEvent.keyboard('o');
    expect(scene().analysis.overhang.on).toBe(true);
    await userEvent.keyboard('t');
    expect(scene().analysis.thinWalls.on).toBe(true);
  });
});

describe('PartViewerModal: panels and overlays', () => {
  it('the explode button needs two objects; its panel sets the amount, the section panel picks the plane and its depth', async () => {
    await open();
    expect(screen.queryByTestId('tool-explode')).not.toBeInTheDocument();
    act(() => scene().onObjects(objects, bounds));
    await userEvent.click(screen.getByTestId('tool-explode'));
    expect(scene().explode).toBe(0.6);
    const explode = screen.getByTestId('explode-panel');
    expect(explode).toHaveTextContent('60%');
    fireEvent.change(within(explode).getByRole('slider'), { target: { value: '30' } });
    expect(scene().explode).toBe(0.3);
    expect(screen.getByTestId('explode-panel')).toHaveTextContent('30%');
    await userEvent.click(screen.getByTestId('tool-explode'));
    expect(scene().explode).toBe(0);
    expect(screen.queryByTestId('explode-panel')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('tool-section'));
    const section = screen.getByTestId('section-panel');
    expect(scene().section).toMatchObject({ on: true, axis: 'z' });
    await userEvent.click(within(section).getByRole('button', { name: 'x', pressed: false }));
    expect(scene().section.axis).toBe('x');
    fireEvent.change(within(section).getByRole('slider'), { target: { value: '40' } });
    expect(scene().section.pct).toBe(40);
    expect(section).toHaveTextContent('40%');
  });

  it('the loading overlay follows the scene status (download, prepare, parse) and an error becomes an alert', async () => {
    await open();
    expect(screen.getByTestId('viewer-loading')).toHaveTextContent('Loading…');
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    act(() => scene().onStatus({ loading: true, error: null, stage: 'download', progress: 0.4 }));
    expect(screen.getByTestId('viewer-loading')).toHaveTextContent('Loading 40 %');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    expect((screen.getByRole('progressbar').firstElementChild as HTMLElement).style.transform).toBe('scaleX(0.4)');
    act(() => scene().onStatus({ loading: true, error: null, stage: 'prepare', progress: null }));
    expect(screen.getByTestId('viewer-loading')).toHaveTextContent('Preparing the part…');
    act(() => scene().onStatus({ loading: true, error: null, stage: 'parse', progress: 0.5 }));
    expect(screen.getByTestId('viewer-loading')).toHaveTextContent('Reading the toolpath 50 %');
    act(() => scene().onStatus({ loading: false, error: null }));
    expect(screen.queryByTestId('viewer-loading')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => scene().onStatus({ loading: false, error: 'noMeshes' }));
    expect(screen.getByRole('alert')).toHaveTextContent('No meshes found in 3MF file');
    for (const error of ['webgl', 'load', 'unsupported'] as const) {
      act(() => scene().onStatus({ loading: false, error }));
      expect(screen.getByRole('alert').textContent).not.toBe('');
    }
  });

  it('the readout: a measurement, then the hovered object with its size and triangle count', async () => {
    await open();
    act(() => scene().onObjects(objects, bounds));
    act(() => scene().onMeasure(12.345));
    expect(screen.getByTestId('viewer-hint')).toHaveTextContent('12.3 mm');
    act(() => scene().onMeasure(null));
    act(() => scene().onHover(1));
    expect(screen.getByTestId('viewer-hint')).toHaveTextContent('Clip · 12 × 8 × 4 mm · 900 triangles');
    act(() => scene().onHover(null));
    expect(screen.queryByTestId('viewer-hint')).not.toBeInTheDocument();
  });
});

describe('PartViewerModal: toolpath tab', () => {
  it('the layer slider, the legend of the features present, hiding one, colouring by filament, the layer line and playback', async () => {
    await open();
    await waitFor(() => expect(screen.getByTestId('rail-print')).toHaveTextContent('Textured PEI'));
    await userEvent.click(screen.getByRole('tab', { name: /Toolpath/ }));
    expect(screen.queryByTestId('layer-range')).not.toBeInTheDocument();
    act(() => scene().onToolpathStats(stats(10)));
    expect(screen.getByTestId('layer-range')).toHaveTextContent('10');
    expect(scene().layerRange).toEqual([0, 9]);
    const legend = screen.getByTestId('toolpath-legend');
    expect(legend).toHaveTextContent('Outer wall');
    expect(legend).toHaveTextContent('Sparse infill');
    expect(legend).toHaveTextContent('Support');
    expect(legend).not.toHaveTextContent('Bridge');
    // The layer line: the last layer's z and, with the print time known, the elapsed share.
    expect(legend).toHaveTextContent('Layer 10 · z 2.00 mm · about 7h 39m of 7h 39m');
    expect(legend).toHaveTextContent('if started now');
    await userEvent.click(within(legend).getByLabelText('Outer wall'));
    expect([...scene().hiddenFeatures]).toEqual([12]);
    await userEvent.click(within(legend).getByLabelText('Outer wall'));
    expect([...scene().hiddenFeatures]).toEqual([]);
    await userEvent.selectOptions(within(legend).getByRole('combobox', { name: 'Colour' }), 'filament');
    expect(scene().colorMode).toBe('filament');
    expect(legend).toHaveTextContent('A1 · ABS-GF');
    expect(legend).not.toHaveTextContent('Outer wall');
    // Speed and flow: the ramp's eleven steps from the file's extremes, hottest first, with units.
    await userEvent.selectOptions(within(legend).getByRole('combobox', { name: 'Colour' }), 'speed');
    expect(scene().colorMode).toBe('speed');
    expect(within(legend).getAllByText(/mm\/s$/)).toHaveLength(11);
    expect(within(legend).getAllByText(/mm\/s$/)[0]).toHaveTextContent('250 mm/s');
    expect(within(legend).getAllByText(/mm\/s$/)[10]).toHaveTextContent('8 mm/s');
    expect(legend).not.toHaveTextContent('A1 · ABS-GF');
    await userEvent.selectOptions(within(legend).getByRole('combobox', { name: 'Colour' }), 'flow');
    expect(scene().colorMode).toBe('flow');
    expect(within(legend).getAllByText(/mm³\/s$/)[0]).toHaveTextContent('12.0 mm³/s');
    expect(within(legend).getAllByText(/mm³\/s$/)[10]).toHaveTextContent('0.5 mm³/s');
    await userEvent.selectOptions(within(legend).getByRole('combobox', { name: 'Colour' }), 'feature');
    // The checks card reads the support share off the stats.
    expect(screen.getByTestId('rail-checks')).toHaveTextContent('Supports: 20 % of the extrusion');
    // A nudge on the top handle reaches the scene.
    screen.getByRole('slider', { name: 'Top layer' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(scene().layerRange).toEqual([0, 8]);
    // Play: the top handle restarts at the bottom and climbs a layer per tick until the last, then stops.
    await userEvent.click(screen.getByRole('button', { name: 'Play the layers' }));
    expect(screen.getByRole('button', { name: 'Play the layers' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(scene().layerRange).toEqual([0, 9]), { timeout: 3000 });
    expect(screen.getByRole('button', { name: 'Play the layers' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByTestId('layer-speed'));
    expect(screen.getByTestId('layer-speed')).toHaveTextContent('2×');
    // Without a print time the layer line keeps the z only.
    act(() => scene().onToolpathStats(stats(4, { remainingPerLayer: [300, 200, 100, 0] })));
    expect(screen.getByTestId('toolpath-legend')).toHaveTextContent('Layer 4 · z 0.80 mm · about 7h 39m of 7h 39m');
  });

  it('a toolpath-only library file has no print time: the layer line keeps z alone and the ridge comes from the segments', async () => {
    render(<PartViewerModal subject={{ kind: 'library', fileId: 7, fileType: 'gcode', filename: 'part.gcode' }} title="part.gcode" onClose={vi.fn()} />);
    await screen.findByTestId('part-scene');
    act(() => scene().onToolpathStats(stats(3, { remainingPerLayer: [20, 10, 0] })));
    const legend = screen.getByTestId('toolpath-legend');
    // The marks give a 20 s total: "0m" of "0m" at the last layer.
    expect(legend).toHaveTextContent('Layer 3 · z 0.60 mm · about 0m of 0m');
    expect(screen.getByTestId('layer-ridge')).toBeInTheDocument();
  });
});

describe('PartViewerModal: compare, rail, snapshot', () => {
  it('the compare chip lists the other revisions that have a source file; picking one ghosts it over the part', async () => {
    await open();
    const chip = screen.getByRole('button', { name: 'Compare: none' });
    await userEvent.click(chip);
    // R3 has no source .3mf, so only R1 is offered beside "none" (which is the current choice).
    expect(screen.queryByRole('button', { name: 'Compare: R3' })).not.toBeInTheDocument();
    const none = screen.getAllByRole('button', { name: 'Compare: none' }).filter((b) => b !== chip);
    expect(none).toHaveLength(1);
    expect(none[0]).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Compare: R1' }));
    expect(scene().compareUrl).toBe('/api/v1/library/files/50/download');
    const chipNow = screen.getByRole('button', { name: 'Compare: R1' });
    await userEvent.click(chipNow);
    const r1 = screen.getAllByRole('button', { name: 'Compare: R1' }).filter((b) => b !== chipNow);
    expect(r1).toHaveLength(1);
    expect(r1[0]).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Compare: none' }));
    expect(scene().compareUrl).toBeNull();
  });

  it('the rail: plates select what the scene builds, the bed select overrides the printer, an object row isolates and hovers, See the toolpath switches tabs', async () => {
    plates = { ...(plates as object), is_multi_plate: true, plates: [plate(1, ['Cache_droit']), plate(2, ['Clip'])] };
    await open();
    const platesCard = await screen.findByTestId('rail-plates');
    expect(within(platesCard).getByRole('button', { name: /Plate 2/ }).querySelector('img')).toHaveAttribute('src', expect.stringContaining('/plates/2/thumbnail'));
    expect(scene().objectNames).toEqual(['Cache_droit', 'Clip']);
    await userEvent.click(within(platesCard).getByRole('button', { name: /Plate 2/ }));
    expect(scene().selectedPlateId).toBe(2);
    expect(scene().objectNames).toEqual(['Clip']);
    await userEvent.click(within(platesCard).getByRole('button', { name: /All Plates/ }));
    expect(scene().selectedPlateId).toBeNull();

    act(() => scene().onObjects(objects, bounds));
    const part = screen.getByTestId('rail-part');
    expect(screen.getByTestId('rail-checks')).toHaveTextContent('Inside the 350 × 320 mm bed');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Bed' }), 'Bambu Lab A1 mini');
    expect(scene().buildVolume).toEqual({ x: 180, y: 180, z: 180 });
    expect(screen.getByTestId('rail-checks')).toHaveTextContent('Inside the 180 × 180 mm bed');

    const row = within(part).getByRole('button', { name: /Clip/ });
    fireEvent.mouseEnter(row);
    expect(scene().hoverIndex).toBe(1);
    expect(screen.getByTestId('viewer-hint')).toHaveTextContent('Clip');
    fireEvent.mouseLeave(row);
    expect(scene().hoverIndex).toBeNull();
    await userEvent.click(row);
    expect(scene().isolatedIndex).toBe(1);
    expect(row).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(row);
    expect(scene().isolatedIndex).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'See the toolpath' }));
    expect(screen.getByTestId('part-scene')).toHaveAttribute('data-tab', 'toolpath');
  });

  it('a snapshot saves a PNG named after the part; "use as thumbnail" uploads a 256px crop and toasts', async () => {
    const createObjectURL = vi.fn(() => 'blob:snap');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      await open();
      await userEvent.click(screen.getByRole('button', { name: 'Save a picture of this view' }));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect(handle.snapshot).toHaveBeenCalledWith();
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const anchor = click.mock.instances[0] as HTMLAnchorElement;
      expect(anchor.download).toBe('DT50 Cache.png');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:snap');
      await userEvent.click(screen.getByRole('button', { name: 'Use this view as the thumbnail' }));
      await waitFor(() => expect(calls).toEqual(['thumbnail:51']));
      expect(handle.snapshot).toHaveBeenLastCalledWith(256);
      expect(await screen.findByText('Thumbnail saved')).toBeInTheDocument();
      // No frame yet: nothing is saved and nothing is uploaded.
      handle.snapshot.mockResolvedValueOnce(null);
      await userEvent.click(screen.getByRole('button', { name: 'Save a picture of this view' }));
      await act(async () => {});
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      click.mockRestore();
    }
  });
});

describe('PartViewerModal: slicer hand-off and photos', () => {
  it('a library file opens in the preferred slicer with a fresh token; the chevron offers the other one; a token failure toasts', async () => {
    render(<PartViewerModal subject={{ kind: 'library', fileId: 6, fileType: '3mf', filename: 'part.3mf' }} title="part.3mf" onClose={vi.fn()} />);
    await screen.findByTestId('part-scene');
    await userEvent.click(screen.getByRole('button', { name: 'Open in Bambu Studio' }));
    await waitFor(() => expect(calls).toEqual(['token:6']));
    expect(vi.mocked(openInSlicer)).toHaveBeenCalledWith(expect.stringContaining('/library/files/6/dl/tok/part.3mf'), 'bambu_studio');
    await userEvent.click(screen.getByRole('button', { name: 'More slicer options' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Open in OrcaSlicer' }));
    await waitFor(() => expect(vi.mocked(openInSlicer)).toHaveBeenLastCalledWith(expect.stringContaining('/library/files/6/dl/tok/'), 'orcaslicer'));
    server.use(http.post('/api/v1/library/files/:id/slicer-token', () => HttpResponse.json({ detail: 'nope' }, { status: 500 })));
    await userEvent.click(screen.getByRole('button', { name: 'Open in Bambu Studio' }));
    expect(await screen.findByText('Could not open in slicer')).toBeInTheDocument();
  });

  it('an archive tokens its own download; a revision hands off to the caller instead', async () => {
    const r1 = render(<PartViewerModal subject={{ kind: 'archive', archiveId: 3, filename: 'job.3mf' }} title="job" onClose={vi.fn()} />);
    await screen.findByTestId('part-scene');
    await userEvent.click(await screen.findByRole('button', { name: 'Open in Bambu Studio' }));
    await waitFor(() => expect(calls).toEqual(['archive-token:3']));
    expect(vi.mocked(openInSlicer)).toHaveBeenCalledWith(expect.stringContaining('/archives/3/dl/atok/job.3mf'), 'bambu_studio');
    r1.unmount();
    const onOpenInSlicer = vi.fn();
    render(<PartViewerModal subject={subject} title="DT50 Cache" onClose={vi.fn()} onOpenInSlicer={onOpenInSlicer} />);
    await screen.findByTestId('part-scene');
    await userEvent.click(screen.getByRole('button', { name: 'Open in slicer' }));
    expect(onOpenInSlicer).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'More slicer options' })).not.toBeInTheDocument();
  });

  it('the photo controls step through the photos (wrapping), set the overlay opacity and close', async () => {
    const user = userEvent.setup();
    render(<PartViewerModal subject={{ kind: 'archive', archiveId: 3, filename: 'job.3mf', photos: ['a.jpg', 'b.jpg'] }} title="Job" onClose={vi.fn()} />);
    const card = await screen.findByTestId('rail-photos');
    await user.click(within(card).getAllByRole('button')[0]);
    expect(screen.getByTestId('photo-controls')).toHaveTextContent('1/2');
    await user.click(screen.getByRole('button', { name: 'Previous photo' }));
    expect(screen.getByTestId('photo-controls')).toHaveTextContent('2/2');
    await user.click(screen.getByRole('button', { name: 'Next photo' }));
    expect(screen.getByTestId('photo-controls')).toHaveTextContent('1/2');
    await user.click(screen.getByTestId('photo-overlay-toggle'));
    fireEvent.change(screen.getByRole('slider', { name: 'Photo opacity' }), { target: { value: '80' } });
    expect(screen.getByTestId('photo-overlay').style.opacity).toBe('0.8');
    // Clicking the shown photo's card again hides it.
    await user.click(within(card).getAllByRole('button')[0]);
    expect(screen.queryByTestId('photo-controls')).not.toBeInTheDocument();
    await user.click(within(card).getAllByRole('button')[1]);
    await user.click(screen.getByRole('button', { name: 'Close the photo' }));
    expect(screen.queryByTestId('photo-controls')).not.toBeInTheDocument();
  });
});
