/**
 * Printing from an Aito task (phase 4, Task 6): the printed/rejected/queued
 * counts on the Impression step, the "tick the step?" suggestion at target,
 * the task's Print button → revision picker → PrintModal with the task, and
 * the revision/order caption on the project page's print tiles.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient } from '@tanstack/react-query';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { PrintedCount } from '../../../../components/projects/print/PrintedCount';
import { TaskStepList } from '../../../../components/aito/TaskStepList';
import { TaskRow } from '../../../../components/aito/TaskRow';
import { ProjectDetailPage } from '../../../../pages/ProjectDetailPage';
import { emptyTaskDraft } from '../../../../utils/taskDraft';
import type { TaskDraft } from '../../../../utils/taskDraft';

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

// The print modal itself is covered elsewhere; here only what it receives.
vi.mock('../../../../components/PrintModal', () => ({
  PrintModal: (props: {
    libraryFileId?: number;
    projectId?: number;
    aitoTaskId?: number | null;
    revisionWarning?: string;
    isolateEscape?: boolean;
    onSuccess?: () => void;
    onClose: () => void;
  }) => (
    <div
      data-testid="print-modal"
      data-file={props.libraryFileId}
      data-project={props.projectId}
      data-task={String(props.aitoTaskId)}
      data-warning={props.revisionWarning ?? ''}
      data-isolate={String(!!props.isolateEscape)}
    >
      <button type="button" onClick={() => props.onSuccess?.()}>fake-success</button>
      <button type="button" onClick={props.onClose}>fake-close</button>
    </div>
  ),
}));

// ProjectDetailPage reads its id from the route.
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: '7' }), useNavigate: () => vi.fn() };
});

beforeAll(() => configure({ asyncUtilTimeout: 8000 }));
afterAll(() => configure({ asyncUtilTimeout: 1000 }));

const ORDER = 42;
const TASK = 11;

const task = (over: Partial<TaskDraft> = {}): TaskDraft => ({
  ...emptyTaskDraft(),
  id: TASK,
  title: 'Support GoPro',
  impressionCost: 2000,
  impression: { printerId: null, filamentId: null, weightG: null, timeMin: null, quantity: 20, color: '' },
  ...over,
});

const counts = (over: Partial<{ printed: number; rejected: number; queued: number; target: number | null }> = {}) => ({
  printed: 12, rejected: 2, queued: 4, target: 20, ...over,
});

const ref = (id: number, item: string, section: string, number: number, status = 'valide') => ({
  id, item_id: id * 10, item_name: item, section, number, status,
});
const file = (id: number, filename: string) => ({
  id, filename, file_type: filename.split('.').pop(), file_size: 2048, file_hash: `h${id}`, has_thumbnail: false,
  created_at: '2026-10-04T10:00:00Z',
});
const rev = (over: Record<string, unknown>) => ({
  id: 1, number: 1, status: 'wip', note: null, derived_from: null, outdated_by: null, print_profile: null,
  slicer_name: null, slicer_version: null, has_snapshot: false, used: false, print_count: 0, pipeline_name: null, created_by: 'paul',
  created_at: '2026-10-04T10:00:00Z', status_changed_at: null, files: [],
  ...over,
});

let outdated: boolean;
let printFiles: boolean;
function makeTree() {
  return {
    project_id: 7,
    code: 'P-0007',
    sections: [
      { section: 'scan', items: [] },
      { section: 'modelisation', items: [{ id: 20, section: 'modelisation', name: 'Support', name_key: 'support', forked_from: null, revisions: [rev({ id: 2, number: 2, status: 'valide', files: [file(50, 'support.step')] })] }] },
      {
        section: 'impression',
        items: printFiles
          ? [{
              id: 30, section: 'impression', name: 'Support X1C', name_key: 'support x1c', forked_from: null,
              revisions: [
                rev({
                  id: 4, number: 2, status: 'valide', created_at: '2026-10-04T12:00:00Z',
                  print_profile: { printer_model: 'X1C', nozzle_diameter: 0.4, layer_height: 0.2, filament_types: ['PETG'] },
                  derived_from: ref(1, 'Support', 'modelisation', 1, 'obsolete'),
                  outdated_by: outdated ? ref(2, 'Support', 'modelisation', 2) : null,
                  files: [file(61, 'support-r2.gcode.3mf'), file(62, 'notes.pdf')],
                }),
                rev({ id: 3, number: 1, status: 'obsolete', created_at: '2026-10-03T12:00:00Z', files: [file(60, 'support-r1.gcode.3mf')] }),
              ],
            }]
          : [],
      },
      { section: 'usinage', items: [] },
      { section: 'docs', items: [] },
    ],
  };
}

let linkGets: number;

beforeEach(() => {
  granted = null;
  outdated = false;
  printFiles = true;
  linkGets = 0;
  server.use(
    http.get(`/api/v1/aito/${ORDER}/project-links`, () => {
      linkGets += 1;
      return HttpResponse.json({
        order_id: ORDER,
        tasks: [{ task_id: TASK, task_title: 'Support GoPro', project: { id: 7, code: 'P-0007', name: 'GoPro' }, sections: {}, deliveries: [], ...counts() }],
      });
    }),
    http.get('/api/v1/projects/7/tree', () => HttpResponse.json(makeTree())),
  );
});

describe('PrintedCount', () => {
  it('states printed/target, rejected and queued', () => {
    render(<PrintedCount {...counts()} />);
    expect(screen.getByTestId('printed-count')).toHaveTextContent('12/20 printed · 2 rejected · 4 queued');
  });

  it('states a bare printed count without a target and hides zero parts', () => {
    render(<PrintedCount {...counts({ target: null, rejected: 0, queued: 0 })} />);
    expect(screen.getByTestId('printed-count')).toHaveTextContent(/^12 printed$/);
  });

  it('uses the singular plural form for one', () => {
    render(<PrintedCount {...counts({ rejected: 1, queued: 1 })} />);
    expect(screen.getByTestId('printed-count')).toHaveTextContent('12/20 printed · 1 rejected · 1 queued');
  });

  it('renders nothing with no prints and nothing queued', () => {
    render(<PrintedCount {...counts({ printed: 0, rejected: 0, queued: 0, target: 20 })} />);
    expect(screen.queryByTestId('printed-count')).not.toBeInTheDocument();
  });
});

describe('Impression step counts and tick suggestion', () => {
  it('shows the counts on the Impression step line', () => {
    render(<TaskStepList task={task()} onChange={vi.fn()} canTick printCounts={counts()} />);
    expect(screen.getByTestId('printed-count')).toHaveTextContent('12/20 printed · 2 rejected · 4 queued');
    expect(screen.queryByRole('button', { name: 'Tick' })).not.toBeInTheDocument();
  });

  it('shows nothing without counts (no link)', () => {
    render(<TaskStepList task={task()} onChange={vi.fn()} canTick />);
    expect(screen.queryByTestId('printed-count')).not.toBeInTheDocument();
  });

  it('suggests ticking at target; "Tick" goes through the step tick handler once', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const draft = task();
    render(<TaskStepList task={draft} onChange={onChange} canTick printCounts={counts({ printed: 20, queued: 0 })} />);
    expect(screen.getByText('All requested prints are done — tick the step?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tick' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...draft, done: { ...draft.done, impression: true } });
  });

  it('never ticks by itself and hides the suggestion once ticked or untickable', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TaskStepList task={task({ done: { ...emptyTaskDraft().done, impression: true } })} onChange={onChange} canTick printCounts={counts({ printed: 21 })} />,
    );
    expect(screen.queryByRole('button', { name: 'Tick' })).not.toBeInTheDocument();
    rerender(<TaskStepList task={task()} onChange={onChange} canTick={false} printCounts={counts({ printed: 21 })} />);
    expect(screen.queryByRole('button', { name: 'Tick' })).not.toBeInTheDocument();
    // A zero target is no target to reach.
    rerender(<TaskStepList task={task()} onChange={onChange} canTick printCounts={counts({ printed: 3, target: 0 })} />);
    expect(screen.queryByRole('button', { name: 'Tick' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});

function renderRow(onChange = vi.fn()) {
  render(
    <TaskRow task={task()} index={0} onChange={onChange} editing={false} onToggleEdit={vi.fn()} canTick orderId={ORDER} />,
  );
}

describe('Print from an Aito task', () => {
  it('feeds the link counts to the Impression step', async () => {
    renderRow();
    expect(await screen.findByTestId('printed-count')).toHaveTextContent('12/20 printed · 2 rejected · 4 queued');
  });

  it('Print → revision picker (newest first, printable files) → PrintModal with the task', async () => {
    const user = userEvent.setup();
    renderRow();
    await user.click(await screen.findByRole('button', { name: 'Print' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose a print file' });
    const revisions = await within(dialog).findAllByTestId(/^pick-revision-/);
    expect(revisions.map((r) => r.dataset.testid)).toEqual(['pick-revision-4', 'pick-revision-3']);
    expect(revisions[0]).toHaveTextContent('Support X1C R2');
    expect(revisions[0]).toHaveTextContent('Approved');
    expect(revisions[0]).toHaveTextContent('X1C · 0.4 mm · 0.2 mm · PETG');
    expect(within(revisions[0]).queryByText('notes.pdf')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/support\.step/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Based on/)).not.toBeInTheDocument();

    await user.click(within(revisions[0]).getByRole('button', { name: 'Print support-r2.gcode.3mf' }));
    expect(screen.queryByRole('dialog', { name: 'Choose a print file' })).not.toBeInTheDocument();
    const modal = screen.getByTestId('print-modal');
    expect(modal.dataset.task).toBe(String(TASK));
    expect(modal.dataset.file).toBe('61');
    expect(modal.dataset.project).toBe('7');
    expect(modal.dataset.warning).toBe('');
    expect(modal.dataset.isolate).toBe('true');

    // The tree has no observer once the picker is gone, so assert the
    // invalidation itself; the links query is live and refetches.
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    const linksBefore = linkGets;
    await user.click(within(modal).getByRole('button', { name: 'fake-success' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['aito-project-links', ORDER] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project-tree', 7] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['aito-events', ORDER] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project-orders', 7] });
    await waitFor(() => expect(linkGets).toBeGreaterThan(linksBefore));
    invalidate.mockRestore();
  });

  it('an outdated revision shows the warning in the picker and passes it to the modal', async () => {
    outdated = true;
    const user = userEvent.setup();
    renderRow();
    await user.click(await screen.findByRole('button', { name: 'Print' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose a print file' });
    const r2 = await within(dialog).findByTestId('pick-revision-4');
    expect(r2).toHaveTextContent(/OUTDATED/i);
    await user.click(within(r2).getByRole('button', { name: 'Print support-r2.gcode.3mf' }));
    expect(screen.getByTestId('print-modal').dataset.warning).toBe('Based on Support R1 — R2 approved since');
  });

  it('says so when the project has no print file; Escape closes the picker', async () => {
    printFiles = false;
    const user = userEvent.setup();
    renderRow();
    await user.click(await screen.findByRole('button', { name: 'Print' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose a print file' });
    expect(await within(dialog).findByText('No print file in this project yet')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Choose a print file' })).not.toBeInTheDocument();
  });

  it('no Print button without queue:create', async () => {
    granted = new Set(['projects:read', 'aito:read', 'aito:update']);
    renderRow();
    await screen.findByTestId('printed-count');
    expect(screen.queryByRole('button', { name: 'Print' })).not.toBeInTheDocument();
  });
});

describe('Project page print tiles', () => {
  it('captions a print with its revision and order', async () => {
    server.use(
      http.get('/api/v1/projects/:id', () =>
        HttpResponse.json({
          id: 7, name: 'GoPro', description: null, color: '#00ae42', status: 'active', priority: 'normal', due_date: null,
          notes: null, parent_id: null, archive_count: 2, total_print_time_seconds: 0, total_filament_grams: 0,
          created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
        }),
      ),
      http.get('/api/v1/projects/:id/archives', () =>
        HttpResponse.json([
          { id: 1, print_name: 'Support', status: 'completed', thumbnail_path: null, revision_label: 'Support X1C R2', order_id: 41, aito_task_id: TASK },
          { id: 2, print_name: 'Loose', status: 'completed', thumbnail_path: null },
        ]),
      ),
      http.get('/api/v1/projects/:id/bom', () => HttpResponse.json([])),
      http.get('/api/v1/projects/:id/timeline', () => HttpResponse.json([])),
      http.get('/api/v1/library/folders/by-project/:id', () => HttpResponse.json([])),
      http.get('/api/v1/library/files', () => HttpResponse.json([])),
    );
    render(<ProjectDetailPage />);
    const caption = await screen.findByTestId('archive-revision-1');
    expect(caption).toHaveTextContent('Support X1C R2 · Order #41');
    expect(caption.closest('a')).toHaveAttribute('title', 'Support · Support X1C R2 · Order #41');
    expect(screen.queryByTestId('archive-revision-2')).not.toBeInTheDocument();
  });
});
