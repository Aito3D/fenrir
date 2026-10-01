import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { MergeProjectModal } from '../../components/aito/MergeProjectModal';
import { makeProject } from '../fixtures/aitoProject';

const target = makeProject({ id: 41, description: 'Pièce carrosserie de BMW X3' });

const board = [
  target,
  makeProject({ id: 33, description: 'Pièce de tambour en inox', client_name: 'PACIFIC MARINE', column: 'print', task_count: 2, quote_number: 'DEV26-2483' }),
  makeProject({ id: 17, description: 'Engrenage machine à laver', client_name: 'ACME SARL', column: 'devis', task_count: 1 }),
  // Invoiced: its lines are accounting and stay where they were billed.
  makeProject({ id: 9, description: 'Bague entretoise', quote_invoiced: true }),
];

function mockBoard() {
  const merges: { url: string; body: unknown }[] = [];
  server.use(
    http.get('/api/v1/aito/', () => HttpResponse.json(board)),
    http.post('/api/v1/aito/:id/merge', async ({ request }) => {
      merges.push({ url: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json({ ...target, task_count: 3 });
    }),
  );
  return merges;
}

describe('MergeProjectModal', () => {
  it('lists every other active, uninvoiced card and leaves Merge disabled until one is picked', async () => {
    mockBoard();
    render(<MergeProjectModal project={target} onClose={vi.fn()} />);
    const rows = await screen.findAllByTestId('merge-candidate');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Pièce de tambour en inox'),
      expect.stringContaining('Engrenage machine à laver'),
    ]);
    expect(rows[0]).toHaveTextContent('PACIFIC MARINE');
    expect(rows[0]).toHaveTextContent('DEV26-2483');
    expect(rows[0]).toHaveTextContent('2 tasks');
    expect(rows[1]).toHaveTextContent('1 task');
    expect(screen.queryByText('Bague entretoise')).not.toBeInTheDocument();
    expect(screen.queryByText('Pièce carrosserie de BMW X3')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
  });

  it('filters the list by description, client or quote number', async () => {
    mockBoard();
    const user = userEvent.setup();
    render(<MergeProjectModal project={target} onClose={vi.fn()} />);
    await screen.findAllByTestId('merge-candidate');
    await user.type(screen.getByRole('searchbox'), 'pacific');
    expect(screen.getAllByTestId('merge-candidate')).toHaveLength(1);
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.queryAllByTestId('merge-candidate')).toHaveLength(0);
    expect(screen.getByText('No card matches.')).toBeInTheDocument();
  });

  it('merges the picked card into this one and closes', async () => {
    const merges = mockBoard();
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MergeProjectModal project={target} onClose={onClose} />);
    const rows = await screen.findAllByTestId('merge-candidate');
    await user.click(rows[1]);
    expect(rows[1]).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(merges).toEqual([{ url: '/api/v1/aito/41/merge', body: { source_project_id: 17 } }]);
  });

  it('keeps the dialog open and says so when the merge is refused', async () => {
    server.use(
      http.get('/api/v1/aito/', () => HttpResponse.json(board)),
      http.post('/api/v1/aito/:id/merge', () =>
        HttpResponse.json({ detail: 'This project has been invoiced' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MergeProjectModal project={target} onClose={onClose} />);
    const rows = await screen.findAllByTestId('merge-candidate');
    await user.click(rows[0]);
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    expect(await screen.findByText('This project has been invoiced')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
