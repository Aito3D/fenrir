import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useQuery } from '@tanstack/react-query';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { api } from '../../../../api/client';
import type { RevisionStatus } from '../../../../api/client';
import { item, projectTree, ref, rev as baseRev } from '../../../fixtures/projectTree';
import { TaskRow } from '../../../../components/aito/TaskRow';
import { TaskStepList } from '../../../../components/aito/TaskStepList';
import { emptyTaskDraft } from '../../../../utils/taskDraft';
import type { TaskDraft } from '../../../../utils/taskDraft';
import { reachesDocument } from '../../../dragHelpers';
import en from '../../../../i18n/locales/en';

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

// This suite's revisions carry no print_count / pipeline_name (left out of the JSON).
const rev = (id: number, number: number, status: RevisionStatus) =>
  baseRev({ id, number, status, print_count: undefined, pipeline_name: undefined });
const tree = projectTree({
  modelisation: [
    item(20, 'modelisation', 'Support', [rev(3, 3, 'valide'), rev(2, 2, 'valide'), rev(1, 1, 'wip')]),
    item(21, 'modelisation', 'Clip', [rev(8, 2, 'wip'), rev(7, 1, 'valide')]),
  ],
  impression: [item(30, 'impression', 'Plate', [rev(6, 1, 'valide')])],
  docs: [item(40, 'docs', 'Plan', [rev(5, 1, 'wip')])],
});
const orderRow = (taskId: number, orderId: number, deliveries: ReturnType<typeof ref>[]) => ({
  task_id: taskId, task_title: 'T', order_id: orderId, order_description: 'D', client_name: 'Acme',
  board_column: 'done', created_at: '2026-09-01T00:00:00Z', deliveries,
});

let links: unknown;
let puts: { url: string; body: unknown }[];
let taskCreates: unknown[];
let plainCreates: number;
let codesGets: number;
let dropped: string[] | null;

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  links = unlinked;
  puts = [];
  taskCreates = [];
  plainCreates = 0;
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
    // T-257: "New project" creates and links in one request.
    http.post(`/api/v1/aito/tasks/${TASK}/project`, async ({ request }) => {
      taskCreates.push(await request.json());
      links = { order_id: ORDER, tasks: [{ task_id: TASK, project: { ...project, id: 9 }, sections: {}, deliveries: [] }] };
      return HttpResponse.json(
        { task_id: TASK, project: { ...project, id: 9 }, sections: {}, deliveries: [] },
        { status: 201 },
      );
    }),
    // Never called from the row any more: a stray create would show up here.
    http.post('/api/v1/projects/', () => {
      plainCreates += 1;
      return HttpResponse.json({ ...project, id: 99 }, { status: 201 });
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
        results: [{ filename: 'support.3mf', section: 'impression', item_id: 20, item_name: 'support', revision_number: 4 }],
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

  it('"New project" opens the create modal prefilled from the task, then creates and links it in one request', async () => {
    const user = userEvent.setup();
    renderRow();
    await waitFor(() => expect(codesGets).toBe(1));
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByDisplayValue('Bracket for drone')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('Scan the part. Model the support')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(taskCreates).toEqual([
        { name: 'Bracket for drone', description: 'Scan the part. Model the support', tag_ids: [], new_tag_names: [] },
      ]),
    );
    expect(puts).toEqual([]);
    expect(plainCreates).toBe(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The links and the board codes refetch: the row now shows the new project.
    await waitFor(() => expect(codesGets).toBe(2));
    expect(await screen.findByRole('link', { name: 'Drone bracket' })).toHaveAttribute('href', '/projects/9');
  });

  it('a failed create-and-link leaves no project behind: one request, the modal stays open', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    server.use(
      http.post(`/api/v1/aito/tasks/${TASK}/project`, () => {
        attempts += 1;
        return HttpResponse.json({ detail: 'Order not found' }, { status: 404 });
      }),
    );
    renderRow();
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByText(en.projectsPdm.saveFailed)).toBeInTheDocument();
    expect(attempts).toBe(1);
    expect(plainCreates).toBe(0);
    expect(puts).toEqual([]);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
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
    const send = vi.spyOn(api, 'dropFilesOnTask');
    // A printing file: a .step would be refused by the type check even if the drop got through.
    fireEvent.drop(dialog, { dataTransfer: { files: [new File(['x'], 'support.3mf')], types: ['Files'] } });
    expect(send).not.toHaveBeenCalled();
    expect(dropped).toBeNull();
    // Positive control: the same file dropped on the task itself is sent, once.
    fireEvent.drop(screen.getByTestId(`task-drop-${TASK}`), {
      dataTransfer: { files: [new File(['x'], 'support.3mf')], types: ['Files'] },
    });
    await waitFor(() => expect(dropped).toEqual([String(TASK)]));
    expect(send).toHaveBeenCalledTimes(1);
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

  it('a failed link toasts, keeps the picker open and leaves the task unlinked', async () => {
    const user = userEvent.setup();
    server.use(http.put(`/api/v1/aito/tasks/${TASK}/project`, () => HttpResponse.json({ detail: 'nope' }, { status: 500 })));
    renderRow();
    await user.click(await screen.findByRole('button', { name: 'Link an existing project' }));
    await user.click(await screen.findByRole('button', { name: /Drone bracket/ }));
    expect(await screen.findByText('Could not update the link')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Drone bracket/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Drone bracket' })).not.toBeInTheDocument();
  });

  it('cancelling the unlink confirmation keeps the link and sends nothing', async () => {
    const user = userEvent.setup();
    links = linked();
    renderRow();
    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    await screen.findByText(/Its delivered files list is cleared/);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/Its delivered files list is cleared/)).not.toBeInTheDocument());
    expect(puts).toEqual([]);
    expect(screen.getByRole('link', { name: 'Drone bracket' })).toBeInTheDocument();
  });

  it('"suggest latest approved" checks the newest approved Printing revision per item, then saves them', async () => {
    const user = userEvent.setup();
    links = linked([]);
    renderRow();
    expect(await screen.findByText('Nothing recorded yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit delivered files' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('checkbox', { name: /Support R3/ });
    await user.click(within(dialog).getByRole('button', { name: 'Suggest latest approved' }));
    const box = (name: RegExp) => within(dialog).getByRole('checkbox', { name }) as HTMLInputElement;
    // Projects hold printing files only for now: whatever the task's services,
    // only Printing items are suggested; older Modeling items stay checkable.
    expect(box(/Plate R1/).checked).toBe(true);
    expect(box(/Support R3/).checked).toBe(false);
    expect(box(/Clip R1/).checked).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toEqual([{ url: 'deliveries', body: { revision_ids: [6] } }]));
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
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'support.3mf')], types: ['Files'] } });
    await waitFor(() => expect(dropped).toEqual([String(TASK)]));
    expect(spy).toHaveBeenCalledWith(TASK, [expect.objectContaining({ name: 'support.3mf' })]);
    expect(await screen.findByText('1 file added to P-0007')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('a partly failed drop toasts what was added and names the files that were not (T-286)', async () => {
    links = linked();
    server.use(
      http.post('/api/v1/aito/tasks/:id/files', ({ params }) => {
        dropped = [String(params.id)];
        return HttpResponse.json(
          {
            project_id: 7,
            code: 'P-0007',
            results: [{ filename: 'a.3mf', section: 'impression', item_id: 20, item_name: 'a', revision_number: 1 }],
            errors: [{ filenames: ['b.3mf', 'c.3mf'], status_code: 409, detail: 'Another upload just created this revision number; try again' }],
          },
          { status: 201 },
        );
      }),
    );
    renderRow();
    await screen.findByRole('link', { name: 'Drone bracket' });
    fireEvent.drop(screen.getByTestId(`task-drop-${TASK}`), {
      dataTransfer: {
        files: [new File(['x'], 'a.3mf'), new File(['x'], 'b.3mf'), new File(['x'], 'c.3mf')],
        types: ['Files'],
      },
    });
    expect(
      await screen.findByText(
        '1 file added to P-0007; not added: b.3mf, c.3mf (Another upload just created this revision number; try again)',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('1 file added to P-0007')).not.toBeInTheDocument();
    expect(screen.queryByText('Upload failed')).not.toBeInTheDocument();
  });

  it('an errors entry with no file left unstored keeps the plain success toast (T-286)', async () => {
    links = linked();
    server.use(
      http.post('/api/v1/aito/tasks/:id/files', () =>
        HttpResponse.json({
          project_id: 7,
          results: [{ filename: 'a.3mf', section: 'impression', item_id: 20, item_name: 'a', revision_number: 1 }],
          errors: [{ filenames: [], status_code: 409, detail: 'Task is not linked to a project' }],
        }),
      ),
    );
    renderRow();
    await screen.findByRole('link', { name: 'Drone bracket' });
    fireEvent.drop(screen.getByTestId(`task-drop-${TASK}`), {
      dataTransfer: { files: [new File(['x'], 'a.3mf')], types: ['Files'] },
    });
    expect(await screen.findByText('1 file added to P-0007')).toBeInTheDocument();
  });

  it('dropping a non-printing file on a linked task toasts and sends nothing', async () => {
    links = linked();
    const spy = vi.spyOn(api, 'dropFilesOnTask');
    renderRow();
    await screen.findByRole('link', { name: 'Drone bracket' });
    fireEvent.drop(screen.getByTestId(`task-drop-${TASK}`), {
      dataTransfer: { files: [new File(['x'], 'support.3mf'), new File(['x'], 'support.stl')], types: ['Files'] },
    });
    expect(await screen.findByText('Only Bambu Studio project files (.3mf) can be added. Sliced files (.gcode.3mf, .gcode) are made by the server.')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    expect(dropped).toBeNull();
    spy.mockRestore();
  });

  it('refuses a dropped sliced .gcode.3mf before sending anything', async () => {
    links = linked();
    const spy = vi.spyOn(api, 'dropFilesOnTask');
    renderRow();
    await screen.findByRole('link', { name: 'Drone bracket' });
    fireEvent.drop(screen.getByTestId(`task-drop-${TASK}`), {
      dataTransfer: { files: [new File(['x'], 'support.gcode.3mf')], types: ['Files'] },
    });
    expect(await screen.findByText('Only Bambu Studio project files (.3mf) can be added. Sliced files (.gcode.3mf, .gcode) are made by the server.')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a server 400 "already sliced" shows the translated copy with the file name', async () => {
    links = linked();
    server.use(
      http.post('/api/v1/aito/tasks/:id/files', () =>
        HttpResponse.json({ detail: 'server: already sliced' }, { status: 400 }),
      ),
    );
    renderRow();
    await screen.findByRole('link', { name: 'Drone bracket' });
    fireEvent.drop(screen.getByTestId(`task-drop-${TASK}`), {
      dataTransfer: { files: [new File(['x'], 'part.3mf')], types: ['Files'] },
    });
    expect(await screen.findByText('part.3mf is already sliced. Upload the original .3mf project instead.')).toBeInTheDocument();
  });

  it('a per-file ONE_FILE error in a partial result shows the translated copy', async () => {
    links = linked();
    server.use(
      http.post('/api/v1/aito/tasks/:id/files', () =>
        HttpResponse.json({
          project_id: 7,
          results: [],
          errors: [{ filenames: ['b.3mf'], status_code: 400, detail: 'server: one .3mf only' }],
        }),
      ),
    );
    renderRow();
    await screen.findByRole('link', { name: 'Drone bracket' });
    fireEvent.drop(screen.getByTestId(`task-drop-${TASK}`), {
      dataTransfer: { files: [new File(['x'], 'b.3mf')], types: ['Files'] },
    });
    expect(await screen.findByText(/A revision holds one \.3mf\. Upload each part as its own item\./)).toBeInTheDocument();
  });

  it('dropping a file on an unlinked task asks for a project first', async () => {
    renderRow();
    await screen.findByRole('button', { name: 'New project' });
    fireEvent.drop(screen.getByTestId(`task-drop-${TASK}`), {
      dataTransfer: { files: [new File(['x'], 'support.3mf')], types: ['Files'] },
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

describe('task file drop zone', () => {
  const files = (...names: string[]) => ({ dataTransfer: { files: names.map((n) => new File(['x'], n)), types: ['Files'] } });
  const linkedZone = async () => {
    links = linked();
    renderRow();
    await screen.findByRole('link', { name: 'Drone bracket' });
    return screen.getByTestId(`task-drop-${TASK}`);
  };

  it('claims a file drag, outlines the task with a title, and keeps it while the drag moves inside', async () => {
    const zone = await linkedZone();
    expect(zone).not.toHaveAttribute('title');
    let notPrevented = true;
    expect(reachesDocument('dragover', () => (notPrevented = fireEvent.dragOver(zone, files())))).toBe(true);
    expect(notPrevented).toBe(false);
    expect(zone.className).toContain('outline-dashed');
    expect(zone).toHaveAttribute('title', 'Drop files to add them to the project');
    // jsdom has no DragEvent, so `relatedTarget` is set on the event by hand.
    const leaveInside = createEvent.dragLeave(zone);
    Object.defineProperty(leaveInside, 'relatedTarget', { value: zone.firstElementChild });
    fireEvent(zone, leaveInside);
    expect(zone.className).toContain('outline-dashed');
    fireEvent.dragLeave(zone, { relatedTarget: null });
    expect(zone.className).not.toContain('outline-dashed');
    expect(zone).not.toHaveAttribute('title');
  });

  it('ignores a non-file drag entirely: not claimed, no outline, nothing sent', async () => {
    const zone = await linkedZone();
    const send = vi.spyOn(api, 'dropFilesOnTask');
    expect(fireEvent.dragOver(zone, { dataTransfer: { types: ['text/plain'] } })).toBe(true);
    expect(zone.className).not.toContain('outline-dashed');
    let notPrevented = false;
    // It even carries a file: only the `Files` type makes a drag a file drop.
    const textDrop = { dataTransfer: { files: [new File(['x'], 'support.3mf')], types: ['text/plain'] } };
    expect(reachesDocument('drop', () => (notPrevented = fireEvent.drop(zone, textDrop)))).toBe(true);
    expect(notPrevented).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(dropped).toBeNull();
    // Positive control: the same file as a file drag is sent, once.
    fireEvent.drop(zone, files('support.3mf'));
    await waitFor(() => expect(dropped).toEqual([String(TASK)]));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a file drop is claimed, stops at the task, and clears the outline', async () => {
    const zone = await linkedZone();
    fireEvent.dragOver(zone, files());
    let notPrevented = true;
    expect(reachesDocument('drop', () => (notPrevented = fireEvent.drop(zone, files('support.3mf'))))).toBe(false);
    expect(notPrevented).toBe(false);
    expect(zone.className).not.toContain('outline-dashed');
    await waitFor(() => expect(dropped).toEqual([String(TASK)]));
  });

  it('an empty file drop on an unlinked task does nothing, not even the link hint', async () => {
    renderRow();
    await screen.findByRole('button', { name: 'New project' });
    const zone = screen.getByTestId(`task-drop-${TASK}`);
    expect(fireEvent.drop(zone, { dataTransfer: { files: [], types: ['Files'] } })).toBe(false);
    await act(async () => {});
    expect(screen.queryByText('Link a project to this task first')).not.toBeInTheDocument();
    // Positive control: a drop with a file shows the hint, and only its own (toasts never merge,
    // so a hint from the empty drop would show twice).
    fireEvent.drop(zone, files('support.3mf'));
    expect(await screen.findByText('Link a project to this task first')).toBeInTheDocument();
    expect(screen.getAllByText('Link a project to this task first')).toHaveLength(1);
  });

  it('an unsaved task claims a file drag but neither outlines nor takes it', async () => {
    renderRow(task({ id: null }));
    const zone = (await screen.findByText('Save the task first')).closest('div[class*="rounded-[.6rem]"]') as HTMLElement;
    expect(zone).not.toBeNull();
    expect(fireEvent.dragOver(zone, files())).toBe(false);
    expect(zone.className).not.toContain('outline-dashed');
    const send = vi.spyOn(api, 'dropFilesOnTask');
    expect(fireEvent.drop(zone, files('support.3mf'))).toBe(false);
    // A taken drop toasts or calls the client synchronously; flush React and microtasks anyway.
    await act(async () => {});
    expect(screen.queryByText('Link a project to this task first')).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
    expect(dropped).toBeNull();
  });

  it('a failed upload that is not an Error, or has no message, toasts the generic failure', async () => {
    const spy = vi.spyOn(api, 'dropFilesOnTask').mockRejectedValueOnce('nope').mockRejectedValueOnce(new Error(''));
    const zone = await linkedZone();
    fireEvent.drop(zone, files('support.3mf'));
    expect(await screen.findByText('Upload failed')).toBeInTheDocument();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    fireEvent.drop(zone, files('support.3mf'));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText('Upload failed')).toHaveLength(2));
    expect(dropped).toBeNull();
    spy.mockRestore();
  });
});
