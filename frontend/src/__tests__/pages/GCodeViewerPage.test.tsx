/**
 * The `/gcode-viewer` page: old links (`?archive=`, `?library_file=`, `&plate=`) open the part
 * viewer on the Toolpath tab and the linked plate; closing goes back instead of leaving an
 * empty page. The WebGL scene and view cube are mocked (jsdom has no WebGL).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { GCodeViewerPage } from '../../pages/GCodeViewerPage';
import type { PartSceneProps } from '../../components/viewer/PartScene';

let lastSceneProps: PartSceneProps | null = null;
vi.mock('../../components/viewer/PartScene', () => ({
  PartScene: (props: PartSceneProps) => {
    lastSceneProps = props;
    return <div data-testid="part-scene" data-tab={props.tab} data-toolpath={props.toolpath?.url ?? ''} />;
  },
}));
vi.mock('../../components/viewer/ViewCube', () => ({ ViewCube: () => <canvas data-testid="view-cube" /> }));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

const plate = (index: number) => ({
  index, name: null, objects: [], has_thumbnail: false, thumbnail_url: null, print_time_seconds: null, filament_used_grams: null,
  filaments: [{ slot_id: 1, type: 'PLA', color: '#ff0000', used_grams: 1, used_meters: 1 }],
});

function visit(search: string) {
  window.history.pushState({}, '', `/gcode-viewer${search}`);
  render(<GCodeViewerPage />);
}

describe('GCodeViewerPage', () => {
  const originalUrl = window.location.href;

  beforeEach(() => {
    lastSceneProps = null;
    navigateMock.mockClear();
    server.use(
      http.get('/api/v1/archives/:id', ({ params }) =>
        HttpResponse.json({ id: Number(params.id), filename: 'job.gcode.3mf', print_name: 'Bracket job', nozzle_diameter: 0.4, photos: [] }),
      ),
      http.get('/api/v1/archives/:id/capabilities', () =>
        HttpResponse.json({ has_model: true, has_gcode: true, has_source: false, build_volume: { x: 256, y: 256, z: 256 }, filament_colors: [] }),
      ),
      http.get('/api/v1/archives/:id/plates', () =>
        HttpResponse.json({ archive_id: 82, filename: 'job.gcode.3mf', is_multi_plate: true, plates: [plate(1), plate(2), plate(3)], has_gcode: true }),
      ),
      http.get('/api/v1/library/files/:id', ({ params }) =>
        HttpResponse.json({ id: Number(params.id), filename: 'two.gcode.3mf', file_type: 'gcode.3mf', print_name: null, nozzle_diameter: null }),
      ),
      http.get('/api/v1/library/files/:id/plates', () =>
        HttpResponse.json({ file_id: 7, filename: 'two.gcode.3mf', is_multi_plate: true, plates: [plate(1), plate(2)] }),
      ),
    );
  });

  afterEach(() => {
    window.history.pushState({}, '', originalUrl);
    vi.restoreAllMocks();
  });

  it('opens an archive in the part viewer on the Toolpath tab', async () => {
    visit('?archive=82');
    expect(await screen.findByText('Bracket job')).toBeInTheDocument();
    const scene = await screen.findByTestId('part-scene');
    expect(scene.getAttribute('data-toolpath')).toContain('/archives/82/gcode');
    await vi.waitFor(() => expect(scene).toHaveAttribute('data-tab', 'toolpath'));
    expect(lastSceneProps?.selectedPlateId).toBeNull();
  });

  it('opens a library file in the part viewer on the Toolpath tab', async () => {
    visit('?library_file=7');
    const scene = await screen.findByTestId('part-scene');
    expect(scene.getAttribute('data-toolpath')).toContain('/library/files/7/gcode');
    await vi.waitFor(() => expect(scene).toHaveAttribute('data-tab', 'toolpath'));
  });

  it('opens on the plate from the link', async () => {
    visit('?archive=82&plate=3');
    await screen.findByTestId('part-scene');
    expect(lastSceneProps?.selectedPlateId).toBe(3);
  });

  it('says so when no file was given rather than rendering an empty viewer', () => {
    visit('');
    expect(screen.queryByTestId('part-scene')).not.toBeInTheDocument();
    expect(screen.getByText(/No file was given/i)).toBeInTheDocument();
  });

  it('treats a non-numeric id as no file', () => {
    visit('?archive=abc');
    expect(screen.getByText(/No file was given/i)).toBeInTheDocument();
  });

  it('says so when the file cannot be loaded', async () => {
    server.use(http.get('/api/v1/archives/:id', () => HttpResponse.json({ detail: 'Not found' }, { status: 404 })));
    visit('?archive=999');
    expect(await screen.findByText(/Could not load/i)).toBeInTheDocument();
  });

  it('goes back on close', async () => {
    const user = userEvent.setup();
    visit('?archive=82');
    await screen.findByTestId('part-scene');
    await user.click(screen.getAllByRole('button', { name: /close/i })[0]);
    expect(navigateMock).toHaveBeenCalledWith(-1);
  });

  it('goes to the file manager on close when there is no history', async () => {
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(1);
    const user = userEvent.setup();
    visit('?library_file=7');
    await screen.findByTestId('part-scene');
    await user.click(screen.getAllByRole('button', { name: /close/i })[0]);
    expect(navigateMock).toHaveBeenCalledWith('/files');
  });

  it('goes to the archives on close when there is no history', async () => {
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(1);
    const user = userEvent.setup();
    visit('?archive=82');
    await screen.findByTestId('part-scene');
    await user.click(screen.getAllByRole('button', { name: /close/i })[0]);
    expect(navigateMock).toHaveBeenCalledWith('/archives');
  });
});
