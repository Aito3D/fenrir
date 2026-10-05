import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useQuery } from '@tanstack/react-query';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { api } from '../../../../api/client';
import { TaskRow } from '../../../../components/aito/TaskRow';
import { TaskStepList } from '../../../../components/aito/TaskStepList';
import { emptyTaskDraft } from '../../../../utils/taskDraft';
import type { TaskDraft } from '../../../../utils/taskDraft';

const ORDER = 42;
const TASK = 11;

const task = (over: Partial<TaskDraft> = {}): TaskDraft => ({
  ...emptyTaskDraft(),
  id: TASK,
  title: 'Bracket for drone',
  modelisationCost: 1000,
  modelisationDescription: 'Model the support',
  scanCost: 500,
  scanDescription: 'Scan the part',
  ...over,
});

const project = { id: 7, code: 'P-0007', name: 'Drone bracket' };
const unlinked = { order_id: ORDER, tasks: [{ task_id: TASK, project: null, sections: {}, deliveries: [] as number[] }] };
const linked = (deliveries: number[] = [3, 5]) => ({
  order_id: ORDER,
  tasks: [
    {
      task_id: TASK,
      project,
      sections: { modelisation: [{ item_id: 20, item_name: 'Support', number: 3, status: 'valide' }] },
      deliveries,
    },
  ],
});

const rev = (id: number, number: number, status: string) => ({
  id, number, status, note: null, derived_from: null, outdated_by: null, print_profile: null,
  slicer_name: null, slicer_version: null, has_snapshot: false, used: false, created_by: 'paul',
  created_at: '2026-10-04T10:00:00Z', status_changed_at: null, files: [],
});
const item = (id: number, section: string, name: string, revisions: ReturnType<typeof rev>[]) => ({
  id, section, name, name_key: name.toLowerCase(), forked_from: null, revisions,
});
const tree = {
  project_id: 7,
  code: 'P-0007',
  sections: [
    { section: 'scan', items: [] },
    {
      section: 'modelisation',
      items: [
        item(20, 'modelisation', 'Support', [rev(3, 3, 'valide'), rev(2, 2, 'valide'), rev(1, 1, 'wip')]),
        item(21, 'modelisation', 'Clip', [rev(8, 2, 'wip'), rev(7, 1, 'valide')]),
      ],
    },
    { section: 'impression', items: [item(30, 'impression', 'Plate', [rev(6, 1, 'valide')])] },
    { section: 'usinage', items: [] },
    { section: 'docs', items: [item(40, 'docs', 'Plan', [rev(5, 1, 'wip')])] },
  ],
};
const ref = (id: number, name: string, section: string, number: number) => ({
  id, item_id: id * 10, item_name: name, section, number, status: 'valide',
});
const orderRow = (taskId: number, orderId: number, deliveries: ReturnType<typeof ref>[]) => ({
  task_id: taskId, task_title: 'T', order_id: orderId, order_description: 'D', client_name: 'Acme',
  board_column: 'done', created_at: '2026-09-01T00:00:00Z', deliveries,
});

let links: unknown;
let puts: { url: string; body: unknown }[];
let codesGets: number;
let dropped: string[] | null;

beforeEach(() => {
  links = unlinked;
  puts = [];
  codesGets = 0;
  dropped = null;
  server.use(
    http.get(`/api/v1/aito/${ORDER}/project-links`, () => HttpResponse.json(links)),
    http.get('/api/v1/aito/project-codes', () => {
      codesGets += 1;
      return HttpResponse.json({});
    }),
    http.get(`/api/v1/aito/tasks/${TASK}/project-suggestions`, () =>
      HttpResponse.json([
        { id: 7, code: 'P-0007', name: 'Drone bracket', reason: 'same_client' },
        { id: 8, code: 'P-0008', name: 'Bracket v2', reason: 'similar_title' },
      ]),
    ),
    http.put(`/api/v1/aito/tasks/${TASK}/project`, async ({ request }) => {
      const body = (await request.json()) as { project_id: number | null };
      puts.push({ url: 'project', body });
      links = body.project_id === null ? unlinked : linked([]);
      return HttpResponse.json({ task_id: TASK, project: body.project_id === null ? null : project, sections: {}, deliveries: [] });
    }),
    http.put(`/api/v1/aito/tasks/${TASK}/deliveries`, async ({ request }) => {
      const body = await request.json();
      puts.push({ url: 'deliveries', body });
      return HttpResponse.json({ task_id: TASK, project, sections: {}, deliveries: [] });
    }),
    http.post('/api/v1/aito/tasks/:id/files', ({ params }) => {
      // Counted, not parsed: Node's fetch serialises the jsdom File as a bare
      // "blob" part (see PrintersPageDropOnBusy.test.tsx); the file names are
      // asserted on the api call instead.
      dropped = [String(params.id)];
      return HttpResponse.json({
        project_id: 7,
        results: [{ filename: 'support.step', section: 'modelisation', item_id: 20, item_name: 'support', revision_number: 4 }],
      });
    }),
    http.get('/api/v1/projects/7/tree', () => HttpResponse.json(tree)),
    http.get('/api/v1/projects/7/orders', () =>
      HttpResponse.json({
        orders: [
          orderRow(TASK, ORDER, [ref(3, 'Support', 'modelisation', 3)]),
          orderRow(30, 187, [ref(5, 'Plan', 'docs', 1), ref(6, 'Plate', 'impression', 1)]),
          orderRow(31, 190, []),
        ],
      }),
    ),
  );
});

/** Keeps the board's project-codes query mounted, so its refetch after a link
 *  change is observable as a second GET. */
function CodesObserver() {
  useQuery({ queryKey: ['aito-project-codes'], queryFn: api.getAitoProjectCodes });
  return null;
}

const renderRow = (draft: TaskDraft = task()) =>
  render(
    <>
      <CodesObserver />
      <TaskRow task={draft} index={0} onChange={vi.fn()} editing={false} onToggleEdit={vi.fn()} canTick orderId={ORDER} />
    </>,
  );

describe('TaskProjectRow', () => {
  it('shows both link buttons on an unlinked task', async () => {
    renderRow();
    expect(await screen.findByRole('button', { name: 'New project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link an existing project' })).toBeInTheDocument();
  });

  it('"New project" opens the create modal prefilled from the task, then links what it created', async () => {
    const user = userEvent.setup();
    let created: unknown = null;
    server.use(
      http.post('/api/v1/projects/', async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ ...project, id: 9 }, { status: 201 });
      }),
    );
    renderRow();
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByDisplayValue('Bracket for drone')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('Scan the part. Model the support')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(puts).toEqual([{ url: 'project', body: { project_id: 9 } }]));
    expect(created).toMatchObject({ name: 'Bracket for drone', description: 'Scan the part. Model the support' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a saved task missing from the loaded links (created after the fetch) counts as unlinked', async () => {
    links = { order_id: ORDER, tasks: [] };
    renderRow();
    expect(await screen.findByRole('button', { name: 'New project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link an existing project' })).toBeInTheDocument();
  });

  it('Escape closes only the open dialog, never the panel listening on window', async () => {
    const user = userEvent.setup();
    const panelClose = vi.fn();
    // The detail panel's useDismissableDialog: a bubble-phase window listener.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') panelClose();
    };
    window.addEventListener('keydown', onKey);
    try {
      links = linked([]);
      renderRow();
      await user.click(await screen.findByRole('button', { name: 'Edit delivered files' }));
      expect(await screen.findByRole('dialog')).toHaveAttribute('aria-modal', 'true');
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      links = unlinked;
      cleanup();
      renderRow();
      await user.click(await screen.findByRole('button', { name: 'New project' }));
      await screen.findByRole('dialog');
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(panelClose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });

  it('a file dropped on a dialog opened from the row does not upload', async () => {
    links = linked([]);
    renderRow();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit delivered files' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.drop(dialog, { dataTransfer: { files: [new File(['x'], 'support.step')], types: ['Files'] } });
    await new Promise((r) => setTimeout(r, 50));
    expect(dropped).toBeNull();
  });

  it('linking from a suggestion PUTs the project id and refetches the board codes', async () => {
    const user = userEvent.setup();
    renderRow();
    await waitFor(() => expect(codesGets).toBe(1));
    await user.click(await screen.findByRole('button', { name: 'Link an existing project' }));
    const suggestion = await screen.findByRole('button', { name: /Drone bracket/ });
    expect(within(suggestion).getByText('Same client')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Bracket v2/ })).toHaveTextContent('Similar title');
    await user.click(suggestion);
    await waitFor(() => expect(puts).toEqual([{ url: 'project', body: { project_id: 7 } }]));
    await waitFor(() => expect(codesGets).toBe(2));
    expect(await screen.findByRole('link', { name: 'Drone bracket' })).toHaveAttribute('href', '/projects/7');
  });

  it('a linked task shows the code, a link to the project and the delivered files', async () => {
    links = linked();
    renderRow();
    const nameLink = await screen.findByRole('link', { name: 'Drone bracket' });
    expect(nameLink).toHaveAttribute('href', '/projects/7');
    expect(screen.getByText('P-0007')).toBeInTheDocument();
    expect(await screen.findByText('Support R3, Plan R1')).toHaveAttribute('title', 'Support R3, Plan R1');
    expect(screen.getByText('Delivered files:')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
  });

  it('unlinking asks for confirmation then PUTs a null project', async () => {
    const user = userEvent.setup();
    links = linked();
    renderRow();
    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    // The confirm's own button is the second "Unlink" on screen.
    await screen.findByText(/Its delivered files list is cleared/);
    await user.click(screen.getAllByRole('button', { name: 'Unlink' })[1]);
    await waitFor(() => expect(puts).toEqual([{ url: 'project', body: { project_id: null } }]));
  });

  it('"suggest latest approved" checks the newest approved revision per item in the task sections, then saves them', async () => {
    const user = userEvent.setup();
    links = linked([]);
    renderRow();
    expect(await screen.findByText('Nothing recorded yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit delivered files' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('checkbox', { name: /Support R3/ });
    await user.click(within(dialog).getByRole('button', { name: 'Suggest latest approved' }));
    const box = (name: RegExp) => within(dialog).getByRole('checkbox', { name }) as HTMLInputElement;
    expect(box(/Support R3/).checked).toBe(true);
    expect(box(/Support R2/).checked).toBe(false);
    expect(box(/Clip R1/).checked).toBe(true);
    expect(box(/Clip R2/).checked).toBe(false);
    expect(box(/Plate R1/).checked).toBe(false); // printing is not one of this task's services
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toEqual([{ url: 'deliveries', body: { revision_ids: [3, 7] } }]));
  });

  it('"reuse from order" replaces the checks with that task\'s deliveries', async () => {
    const user = userEvent.setup();
    links = linked([3]);
    renderRow();
    await user.click(await screen.findByRole('button', { name: 'Edit delivered files' }));
    const dialog = await screen.findByRole('dialog');
    const select = await within(dialog).findByRole('combobox');
    // Only other orders that delivered something are offered.
    expect(within(select).queryByRole('option', { name: /#190/ })).not.toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /#42/ })).not.toBeInTheDocument();
    await user.selectOptions(select, within(select).getByRole('option', { name: 'Reuse the files from order #187' }));
    const box = (name: RegExp) => within(dialog).getByRole('checkbox', { name }) as HTMLInputElement;
    expect(box(/Support R3/).checked).toBe(false);
    expect(box(/Plan R1/).checked).toBe(true);
    expect(box(/Plate R1/).checked).toBe(true);
  });

  it('dropping a file on a linked task uploads it and toasts the count and code', async () => {
    links = linked();
    const spy = vi.spyOn(api, 'dropFilesOnTask');
    renderRow();
    await screen.findByRole('link', { name: 'Drone bracket' });
    const zone = screen.getByTestId(`task-drop-${TASK}`);
    fireEvent.dragOver(zone, { dataTransfer: { types: ['Files'] } });
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'support.step')], types: ['Files'] } });
    await waitFor(() => expect(dropped).toEqual([String(TASK)]));
    expect(spy).toHaveBeenCalledWith(TASK, [expect.objectContaining({ name: 'support.step' })]);
    expect(await screen.findByText('1 file added to P-0007')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('dropping a file on an unlinked task asks for a project first', async () => {
    renderRow();
    await screen.findByRole('button', { name: 'New project' });
    fireEvent.drop(screen.getByTestId(`task-drop-${TASK}`), {
      dataTransfer: { files: [new File(['x'], 'support.step')], types: ['Files'] },
    });
    expect(await screen.findByText('Link a project to this task first')).toBeInTheDocument();
    expect(dropped).toBeNull();
  });

  it('an unsaved task says to save it first', async () => {
    renderRow(task({ id: null }));
    expect(await screen.findByText('Save the task first')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
  });

  it('the linked task step shows its section summary', async () => {
    links = linked();
    renderRow();
    expect(await screen.findByTestId('step-files-modelisation')).toHaveTextContent('Support R3 · Approved');
    expect(screen.queryByTestId('step-files-scan')).not.toBeInTheDocument();
  });
});

describe('TaskStepList section summaries', () => {
  it('renders one summary line per step with a matching section, items joined by a dot', () => {
    render(
      <TaskStepList
        task={task()}
        onChange={vi.fn()}
        canTick={false}
        sectionSummaries={{
          modelisation: [
            { item_id: 20, item_name: 'Support', number: 3, status: 'valide' },
            { item_id: 21, item_name: 'Clip', number: 1, status: 'wip' },
          ],
        }}
      />,
    );
    const line = screen.getByTestId('step-files-modelisation');
    expect(line).toHaveTextContent('Support R3 · Approved · Clip R1 · In progress');
    expect(within(line).getByTitle('Support R3 · Approved · Clip R1 · In progress')).toBeInTheDocument();
  });
});
