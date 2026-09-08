import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { DuplicateProjectButton } from '../../components/aito/DuplicateProjectButton';
import { readNewProjectDraft, writeNewProjectDraft } from '../../hooks/useNewProjectDraft';
import { emptyTaskDraft } from '../../utils/taskDraft';
import type { AitoProject, AitoTask } from '../../api/client';

const project = {
  id: 12,
  description: 'Support de caméra, PLA noir',
  client_id: 'z1',
  client_name: 'Jean-Pierre DUPONT',
  client_phone: '+689-87123456',
  client_email: 'jp@example.pf',
  client_is_company: false,
  client_social_network: null,
  client_social_handle: null,
  due_date: '2026-09-20',
  flag: 'urgent',
  shipping_island: null,
} as unknown as AitoProject;

const task = {
  id: 41,
  project_id: 12,
  position: 0,
  title: 'Support GoPro',
  scan_cost: 1000,
  scan_done: true,
  scan_quantity: 1,
  impression_quantity: 1,
  impression_cost: 3400,
  impression_done: true,
} as unknown as AitoTask;

function mockTasks(tasks: AitoTask[] = [task]) {
  server.use(http.get('/api/v1/aito/12/tasks', () => HttpResponse.json(tasks)));
}

const dirtyDraft = () =>
  writeNewProjectDraft({
    tasks: [{ ...emptyTaskDraft(), title: 'Un devis en cours' }],
    client: null,
    summaryText: '',
    summaryEdited: false,
    summarySignature: '',
    shipping: null,
    dueDate: '',
  });

afterEach(() => localStorage.clear());

describe('DuplicateProjectButton', () => {
  it('seeds the drawer from the card and opens it when no draft is waiting', async () => {
    mockTasks();
    const onDuplicate = vi.fn();
    render(<DuplicateProjectButton project={project} onDuplicate={onDuplicate} />);

    await userEvent.click(screen.getByRole('button', { name: /duplicate/i }));

    await waitFor(() => expect(onDuplicate).toHaveBeenCalledTimes(1));
    const seeded = readNewProjectDraft()!;
    expect(seeded.tasks).toHaveLength(1);
    expect(seeded.tasks[0].title).toBe('Support GoPro');
    expect(seeded.tasks[0].id).toBeNull();
    expect(seeded.tasks[0].done.scan).toBe(false);
    expect(seeded.client?.name).toBe('Jean-Pierre DUPONT');
    expect(seeded.summaryText).toBe('Support de caméra, PLA noir');
    // The old job's promise does not follow the new one.
    expect(seeded.dueDate).toBe('');
  });

  it('asks before discarding a draft that has work in it, and does nothing on cancel', async () => {
    mockTasks();
    dirtyDraft();
    const onDuplicate = vi.fn();
    render(<DuplicateProjectButton project={project} onDuplicate={onDuplicate} />);

    await userEvent.click(screen.getByRole('button', { name: /duplicate/i }));
    expect(await screen.findByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    expect(onDuplicate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onDuplicate).not.toHaveBeenCalled();
    expect(readNewProjectDraft()?.tasks[0].title).toBe('Un devis en cours');
  });

  it('replaces the waiting draft once the operator confirms', async () => {
    mockTasks();
    dirtyDraft();
    const onDuplicate = vi.fn();
    render(<DuplicateProjectButton project={project} onDuplicate={onDuplicate} />);

    await userEvent.click(screen.getByRole('button', { name: /duplicate/i }));
    await userEvent.click(await screen.findByRole('button', { name: /replace/i }));

    await waitFor(() => expect(onDuplicate).toHaveBeenCalledTimes(1));
    expect(readNewProjectDraft()?.tasks[0].title).toBe('Support GoPro');
  });

  it('waits for the tasks before seeding, so a duplicate never loses the work', async () => {
    let release: (value: unknown) => void = () => {};
    const held = new Promise((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/v1/aito/12/tasks', async () => {
        await held;
        return HttpResponse.json([task]);
      }),
    );
    const onDuplicate = vi.fn();
    render(<DuplicateProjectButton project={project} onDuplicate={onDuplicate} />);

    await userEvent.click(screen.getByRole('button', { name: /duplicate/i }));
    // Still loading: nothing seeded, nothing opened.
    expect(onDuplicate).not.toHaveBeenCalled();
    expect(readNewProjectDraft()).toBeNull();

    release(null);

    await waitFor(() => expect(onDuplicate).toHaveBeenCalledTimes(1));
    expect(readNewProjectDraft()?.tasks[0].title).toBe('Support GoPro');
  });
});
