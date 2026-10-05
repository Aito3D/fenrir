/**
 * Printing a project revision file: the Print button on printable files, the
 * order picker (open orders + "None"), and the queue POST that carries the
 * chosen task as `aito_task_id`.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { ProjectFilesPanel } from '../../../../components/projects/files/ProjectFilesPanel';
import type { ProjectOrderTask } from '../../../../api/client';

// null = real AuthProvider (auth disabled: every permission granted).
let granted: Set<string> | null = null;
vi.mock('../../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      return granted ? { ...real, hasPermission: (p: string) => granted!.has(p) } : real;
    },
  };
});

beforeAll(() => configure({ asyncUtilTimeout: 8000 }));
afterAll(() => configure({ asyncUtilTimeout: 1000 }));

const ref = (id: number, item: string, section: string, number: number, status = 'valide') => ({
  id, item_id: id * 10, item_name: item, section, number, status,
});
const file = (id: number, filename: string, file_type: string) => ({
  id, filename, file_type, file_size: 2048, file_hash: `h${id}`, has_thumbnail: false, created_at: '2026-10-04T10:00:00Z',
});
const rev = (over: Record<string, unknown>) => ({
  id: 1, number: 1, status: 'wip', note: null, derived_from: null, outdated_by: null, print_profile: null,
  slicer_name: null, slicer_version: null, has_snapshot: false, used: false, print_count: 0, created_by: 'paul',
  created_at: '2026-10-04T10:00:00Z', status_changed_at: null, files: [file(50, 'support.step', 'step')],
  ...over,
});

function makeTree(outdated: boolean) {
  return {
    project_id: 7,
    code: 'P-0007',
    sections: [
      { section: 'scan', items: [] },
      { section: 'modelisation', items: [{ id: 20, section: 'modelisation', name: 'Support', name_key: 'support', forked_from: null, revisions: [rev({ id: 2, number: 2, status: 'valide' })] }] },
      { section: 'impression', items: [{ id: 30, section: 'impression', name: 'Support X1C', name_key: 'support x1c', forked_from: null, revisions: [rev({
        id: 3, number: 1, used: true, print_count: 2,
        derived_from: ref(1, 'Support', 'modelisation', 1, 'obsolete'),
        outdated_by: outdated ? ref(2, 'Support', 'modelisation', 2) : null,
        files: [file(60, 'support.gcode.3mf', 'gcode.3mf'), file(61, 'support.gcode', 'gcode'), file(62, 'notes.pdf', 'pdf')],
      })] }] },
      { section: 'usinage', items: [] },
      { section: 'docs', items: [] },
    ],
  };
}

function order(over: Partial<ProjectOrderTask>): ProjectOrderTask {
  return {
    task_id: 12, task_title: 'Support', order_id: 41, order_description: 'Support GoPro', client_name: 'ACME SARL',
    board_column: 'print', created_at: '2026-09-12T09:14:00', deliveries: [], ...over,
  };
}

let orders: ProjectOrderTask[];
let outdated: boolean;
let bodies: Record<string, unknown>[];
let treeGets: number;
let ordersGets: number;

let ordersFail: boolean;

beforeEach(() => {
  granted = null;
  ordersFail = false;
  orders = [];
  outdated = false;
  bodies = [];
  treeGets = 0;
  ordersGets = 0;
  server.use(
    http.get('/api/v1/projects/7/tree', () => {
      treeGets += 1;
      return HttpResponse.json(makeTree(outdated));
    }),
    http.get('/api/v1/projects/7/orders', () => {
      ordersGets += 1;
      if (ordersFail) return HttpResponse.json({ detail: 'boom' }, { status: 500 });
      return HttpResponse.json({ orders });
    }),
    http.get('/api/v1/printers/', () =>
      HttpResponse.json([{ id: 1, name: 'X1 Carbon', model: 'X1C', ip_address: '192.168.1.100', enabled: true, is_active: true }]),
    ),
    http.get('/api/v1/printers/:id/status', () => HttpResponse.json({ connected: true, state: 'IDLE', ams: [], vt_tray: [] })),
    http.get('/api/v1/library/files/:id', ({ params }) =>
      HttpResponse.json({
        id: Number(params.id), filename: 'support.gcode.3mf', print_name: null, file_type: '3mf', folder_id: null, project_id: 7,
        file_hash: null, file_size_bytes: 1024, thumbnail_path: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
      }),
    ),
    http.get('/api/v1/library/files/:id/plates', () => HttpResponse.json({ is_multi_plate: false, plates: [] })),
    http.get('/api/v1/library/files/:id/filament-requirements', () => HttpResponse.json({ file_id: 60, filename: 'support.gcode.3mf', filaments: [] })),
    http.post('/api/v1/queue/', async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ id: bodies.length, status: 'pending' });
    }),
  );
});

async function openPrintRevision(user: ReturnType<typeof userEvent.setup>) {
  render(<ProjectFilesPanel projectId={7} />);
  await user.click(await screen.findByRole('button', { name: /Support X1C$/ }));
  return screen.getByTestId('revision-3');
}

async function submitModal(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole('button', { name: /^print$/i });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await waitFor(() => expect(bodies.length).toBe(1));
  return bodies[0];
}

describe('Print from a project revision', () => {
  it('offers Print only on printable files and shows the revision print count', async () => {
    const user = userEvent.setup();
    const r3 = await openPrintRevision(user);
    const rows = within(r3).getAllByRole('listitem');
    const printIn = (name: string) => within(rows.find((r) => r.textContent?.includes(name))!).queryByRole('button', { name: /^Print/ });
    expect(printIn('support.gcode.3mf')).toBeInTheDocument();
    expect(printIn('support.gcode')).toBeInTheDocument();
    expect(printIn('notes.pdf')).not.toBeInTheDocument();
    expect(within(r3).getByText('printed 2 times')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Support$/ }));
    expect(within(screen.getByTestId('revision-2')).queryByRole('button', { name: /^Print/ })).not.toBeInTheDocument();
  });

  it('preselects the only open order and sends its task in the queue body', async () => {
    orders = [order({ task_id: 12 }), order({ task_id: 13, order_id: 40, board_column: 'done', client_name: 'Old' })];
    const user = userEvent.setup();
    const r3 = await openPrintRevision(user);
    await user.click(within(r3).getAllByRole('button', { name: /^Print/ })[0]);

    const dialog = await screen.findByRole('dialog', { name: 'Which order is this print for?' });
    const radios = within(dialog).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(within(dialog).getByRole('radio', { name: 'Order #41 — ACME SARL — Support' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'None (internal or test print)' })).not.toBeChecked();
    expect(within(dialog).queryByText(/Old/)).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(screen.queryByRole('dialog', { name: 'Which order is this print for?' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('print-revision-warning')).not.toBeInTheDocument();
    const treeBefore = treeGets;
    const ordersBefore = ordersGets;
    const body = await submitModal(user);
    expect(body.aito_task_id).toBe(12);
    expect(body.library_file_id).toBe(60);
    expect(body.project_id).toBe(7);
    await waitFor(() => expect(treeGets).toBeGreaterThan(treeBefore));
    await waitFor(() => expect(ordersGets).toBeGreaterThan(ordersBefore));
  }, 20000);

  it('"None" sends a null task', async () => {
    orders = [order({ task_id: 12 }), order({ task_id: 14, order_id: 42, task_title: 'Bras', client_name: 'Moana' })];
    const user = userEvent.setup();
    const r3 = await openPrintRevision(user);
    await user.click(within(r3).getAllByRole('button', { name: /^Print/ })[0]);

    const dialog = await screen.findByRole('dialog', { name: 'Which order is this print for?' });
    expect(within(dialog).getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await user.click(within(dialog).getByRole('radio', { name: 'None (internal or test print)' }));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    const body = await submitModal(user);
    expect(body).toHaveProperty('aito_task_id');
    expect(body.aito_task_id).toBeNull();
  }, 20000);

  it('Escape closes only the order picker', async () => {
    orders = [order({ task_id: 12 })];
    const user = userEvent.setup();
    const r3 = await openPrintRevision(user);
    await user.click(within(r3).getAllByRole('button', { name: /^Print/ })[0]);
    await screen.findByRole('dialog', { name: 'Which order is this print for?' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Which order is this print for?' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^print$/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('revision-3')).toBeInTheDocument();
  });

  it('skips the picker without open orders and warns about an outdated revision', async () => {
    outdated = true;
    orders = [order({ board_column: 'done' })];
    const user = userEvent.setup();
    const r3 = await openPrintRevision(user);
    await user.click(within(r3).getAllByRole('button', { name: /^Print/ })[0]);

    expect(await screen.findByTestId('print-revision-warning')).toHaveTextContent('Based on Support R1 — R2 approved since');
    expect(screen.queryByRole('dialog', { name: 'Which order is this print for?' })).not.toBeInTheDocument();
    const body = await submitModal(user);
    expect(body).toHaveProperty('aito_task_id');
    expect(body.aito_task_id).toBeNull();
    expect(body.library_file_id).toBe(60);
  }, 20000);

  it('hides Print without queue:create', async () => {
    granted = new Set(['projects:read', 'projects:update', 'projects:delete', 'aito:read']);
    const user = userEvent.setup();
    const r3 = await openPrintRevision(user);
    expect(within(r3).getByText('support.gcode.3mf')).toBeInTheDocument();
    expect(within(r3).queryByRole('button', { name: /^Print/ })).not.toBeInTheDocument();
  });

  it('still asks when the orders fail to load, offering only None', async () => {
    ordersFail = true;
    const user = userEvent.setup();
    const r3 = await openPrintRevision(user);
    await user.click(within(r3).getByRole('button', { name: 'Print support.gcode.3mf' }));

    const dialog = await screen.findByRole('dialog', { name: 'Which order is this print for?' });
    expect(within(dialog).getByText(/Orders could not be loaded/)).toBeInTheDocument();
    const radios = within(dialog).getAllByRole('radio');
    expect(radios).toHaveLength(1);
    expect(radios[0]).toHaveAccessibleName('None (internal or test print)');
    expect(radios[0]).not.toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await user.click(radios[0]);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    const body = await submitModal(user);
    expect(body).toHaveProperty('aito_task_id');
    expect(body.aito_task_id).toBeNull();
  }, 20000);
});
