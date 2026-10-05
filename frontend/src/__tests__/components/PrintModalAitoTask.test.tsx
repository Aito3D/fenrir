/**
 * Fenrir: PrintModal's project-print props. `aitoTaskId` rides on every queue
 * body; `revisionWarning` shows a non-blocking banner. Without them the body is
 * exactly what upstream sends.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { PrintModal } from '../../components/PrintModal';

beforeAll(() => configure({ asyncUtilTimeout: 8000 }));
afterAll(() => configure({ asyncUtilTimeout: 1000 }));

// Keys of the library-file queue body as upstream builds it (undefined values
// are dropped by JSON). A new key here means the no-props body changed.
const BASE_KEYS = [
  'auto_off_after', 'bed_levelling', 'confirm_outcome', 'flow_cali', 'gcode_injection', 'insert_at_top',
  'insert_position', 'layer_inspect', 'library_file_id', 'manual_start', 'nozzle_offset_cali', 'plate_id',
  'preheat_chamber_target_override', 'preheat_override', 'printer_id', 'project_id', 'require_previous_success',
  'target_location', 'target_model', 'timelapse', 'vibration_cali',
];

let bodies: Record<string, unknown>[];

beforeEach(() => {
  bodies = [];
  server.use(
    http.get('/api/v1/printers/', () =>
      HttpResponse.json([{ id: 1, name: 'X1 Carbon', model: 'X1C', ip_address: '192.168.1.100', enabled: true, is_active: true }]),
    ),
    http.get('/api/v1/printers/:id/status', () => HttpResponse.json({ connected: true, state: 'IDLE', ams: [], vt_tray: [] })),
    http.get('/api/v1/library/files/:id', () =>
      HttpResponse.json({
        id: 5, filename: 'support.gcode.3mf', print_name: null, file_type: '3mf', folder_id: null, project_id: null,
        file_hash: null, file_size_bytes: 1024, thumbnail_path: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
      }),
    ),
    http.get('/api/v1/library/files/:id/plates', () => HttpResponse.json({ is_multi_plate: false, plates: [] })),
    http.get('/api/v1/library/files/:id/filament-requirements', () =>
      HttpResponse.json({ file_id: 5, filename: 'support.gcode.3mf', filaments: [] }),
    ),
    http.post('/api/v1/queue/', async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ id: bodies.length, status: 'pending' });
    }),
  );
});

async function submit(extra: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  render(
    <PrintModal mode="create" libraryFileId={5} archiveName="support.gcode.3mf" projectId={7}
      initialSelectedPrinterIds={[1]} onClose={vi.fn()} {...extra} />,
  );
  const button = await screen.findByRole('button', { name: /^print$/i });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await waitFor(() => expect(bodies.length).toBe(1));
  return bodies[0];
}

describe('PrintModal project-print props', () => {
  it('sends the upstream body unchanged without the new props', async () => {
    const body = await submit();
    expect(Object.keys(body).sort()).toEqual(BASE_KEYS);
    expect(body).not.toHaveProperty('aito_task_id');
    expect(screen.queryByTestId('print-revision-warning')).not.toBeInTheDocument();
  }, 15000);

  it('adds aito_task_id to the queue body', async () => {
    const body = await submit({ aitoTaskId: 12 });
    expect(body.aito_task_id).toBe(12);
    expect(Object.keys(body).filter((k) => k !== 'aito_task_id').sort()).toEqual(BASE_KEYS);
  }, 15000);

  it('sends aito_task_id null for an internal print', async () => {
    const body = await submit({ aitoTaskId: null });
    expect(body.aito_task_id).toBeNull();
  }, 15000);

  it('shows the revision warning and still submits', async () => {
    const body = await submit({ revisionWarning: 'Based on Support R1 — R2 approved since' });
    expect(screen.getByTestId('print-revision-warning')).toHaveTextContent('Based on Support R1 — R2 approved since');
    expect(body.library_file_id).toBe(5);
  }, 15000);
});

describe('PrintModal isolateEscape', () => {
  // A host dialog's window listener, registered before the modal mounts.
  async function pressEscape(extra: Record<string, unknown>) {
    const host = vi.fn();
    window.addEventListener('keydown', host);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <PrintModal mode="create" libraryFileId={5} archiveName="support.gcode.3mf" projectId={7}
        initialSelectedPrinterIds={[1]} onClose={onClose} {...extra} />,
    );
    await screen.findByRole('button', { name: /^print$/i });
    await user.keyboard('{Escape}');
    window.removeEventListener('keydown', host);
    return { host, onClose };
  }

  it('closes the modal without the key reaching a host dialog', async () => {
    const { host, onClose } = await pressEscape({ isolateEscape: true });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host).not.toHaveBeenCalled();
  });

  it('keeps upstream behaviour without the prop', async () => {
    const { host, onClose } = await pressEscape({});
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host).toHaveBeenCalled();
  });
});
