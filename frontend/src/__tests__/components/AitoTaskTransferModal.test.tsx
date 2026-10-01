import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { TaskTransferModal } from '../../components/aito/TaskTransferModal';
import { makeProject } from '../fixtures/aitoProject';
import { emptyTaskDraft, type TaskDraft } from '../../utils/taskDraft';

const source = makeProject({ id: 41, description: 'Pièce carrosserie de BMW X3', task_count: 3 });
const created = makeProject({ id: 58, description: 'Pièce carrosserie de BMW X3' });

const board = [
  source,
  makeProject({ id: 33, description: 'Pièce de tambour en inox', client_name: 'PACIFIC MARINE', task_count: 2 }),
  makeProject({ id: 17, description: 'Engrenage machine à laver', task_count: 1 }),
];

const task = (id: number | null, title: string, scanCost: number | null = 500): TaskDraft => ({
  ...emptyTaskDraft(),
  id,
  title,
  scanCost,
});

const tasks = [task(501, 'Aile avant'), task(502, 'Pare-choc'), task(503, 'Rétroviseur')];

function mockTransfer(target = created) {
  const posts: { url: string; body: unknown }[] = [];
  server.use(
    http.get('/api/v1/aito/', () => HttpResponse.json(board)),
    http.post('/api/v1/aito/:id/tasks/transfer', async ({ request }) => {
      posts.push({ url: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json({ source, target });
    }),
  );
  return posts;
}

const taskBox = (title: string) => screen.getByRole('checkbox', { name: new RegExp(title) });

describe('TaskTransferModal — split', () => {
  it('lists every task with a checkbox and keeps Split disabled at none and at all ticked', async () => {
    mockTransfer();
    const user = userEvent.setup();
    render(<TaskTransferModal project={source} tasks={tasks} mode="split" onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Split into a new card' })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
    const split = screen.getByRole('button', { name: 'Split' });
    expect(split).toBeDisabled();
    await user.click(taskBox('Aile avant'));
    expect(split).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeChecked();
    expect(split).toBeDisabled();
    expect(screen.getByText(/The ticked tasks move to a new card for ACME SARL/)).toBeInTheDocument();
  });

  it('leaves an unsaved row unpickable', () => {
    mockTransfer();
    render(
      <TaskTransferModal
        project={source}
        tasks={[...tasks, task(null, 'Brouillon')]}
        mode="split"
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(taskBox('Brouillon')).toBeDisabled();
    expect(screen.getByText('Not saved yet')).toBeInTheDocument();
  });

  it('posts the ticked ids with no target and hands the response to onDone', async () => {
    const posts = mockTransfer();
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<TaskTransferModal project={source} tasks={tasks} mode="split" onClose={vi.fn()} onDone={onDone} />);
    await user.click(taskBox('Aile avant'));
    await user.click(taskBox('Rétroviseur'));
    await user.click(screen.getByRole('button', { name: 'Split' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ source, target: created }));
    expect(posts).toEqual([
      { url: '/api/v1/aito/41/tasks/transfer', body: { task_ids: [501, 503], target_project_id: null } },
    ]);
    expect(await screen.findByText('2 tasks moved to #58')).toBeInTheDocument();
  });

  it('keeps the dialog open and shows the refusal when the server says no', async () => {
    server.use(
      http.post('/api/v1/aito/:id/tasks/transfer', () =>
        HttpResponse.json({ detail: 'The task list changed' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<TaskTransferModal project={source} tasks={tasks} mode="split" onClose={onClose} onDone={onDone} />);
    await user.click(taskBox('Pare-choc'));
    await user.click(screen.getByRole('button', { name: 'Split' }));
    expect(await screen.findByText('The task list changed')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('TaskTransferModal — move', () => {
  it('ticks two tasks, picks a card and posts with its id', async () => {
    const target = board[1];
    const posts = mockTransfer(target);
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<TaskTransferModal project={source} tasks={tasks} mode="move" onClose={vi.fn()} onDone={onDone} />);
    expect(screen.getByRole('dialog', { name: 'Move tasks to another card' })).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();
    await user.click(taskBox('Aile avant'));
    await user.click(taskBox('Pare-choc'));
    await user.click(next);
    const rows = await screen.findAllByTestId('merge-candidate');
    expect(rows).toHaveLength(2);
    const move = screen.getByRole('button', { name: 'Move' });
    expect(move).toBeDisabled();
    await user.click(rows[0]);
    await user.click(move);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ source, target }));
    expect(posts).toEqual([
      { url: '/api/v1/aito/41/tasks/transfer', body: { task_ids: [501, 502], target_project_id: 33 } },
    ]);
  });

  it('allows moving every task and says the card will be left empty', async () => {
    mockTransfer();
    const user = userEvent.setup();
    render(<TaskTransferModal project={source} tasks={tasks} mode="move" onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.queryByText('This card will be left without tasks.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByText('This card will be left without tasks.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('goes back to the task list with the ticks kept', async () => {
    mockTransfer();
    const user = userEvent.setup();
    render(<TaskTransferModal project={source} tasks={tasks} mode="move" onClose={vi.fn()} onDone={vi.fn()} />);
    await user.click(taskBox('Pare-choc'));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findAllByTestId('merge-candidate');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(taskBox('Pare-choc')).toBeChecked();
    expect(taskBox('Aile avant')).not.toBeChecked();
  });
});
