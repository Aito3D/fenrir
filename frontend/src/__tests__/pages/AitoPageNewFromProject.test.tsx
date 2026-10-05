/**
 * The board's `?newFromProject=` link (the project page's "New order"): the
 * create drawer opens seeded from the project, and the order it creates gets
 * its first task linked to that project. The drawer itself is stubbed — its
 * seed behaviour has its own test (NewProjectDrawerSeed.test.tsx); this pins
 * the page's half: the seed it passes, and the link it makes after create.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';
import { makeProject } from '../fixtures/aitoProject';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { defaultClientDraft } from '../../utils/clientDraft';
import { emptyTaskDraft } from '../../utils/taskDraft';
import type { NewProjectDrawerProps } from '../../components/aito/NewProjectDrawer';

vi.mock('../../components/aito/NewProjectDrawer', () => ({
  NewProjectDrawer: ({ onClose, onCreate, seed }: NewProjectDrawerProps) => (
    <div role="dialog" aria-label="New Project">
      <pre data-testid="drawer-seed">{JSON.stringify(seed ?? null)}</pre>
      <button type="button" onClick={onClose}>
        stub close
      </button>
      <button
        type="button"
        onClick={() =>
          onCreate(
            'Support caméra',
            { ...defaultClientDraft('z1', 'ACME'), nationalNumber: '87123456' },
            [{ ...emptyTaskDraft(), title: 'P-0042 Support GoPro', scanCost: 1000 }],
            null,
            null,
            false,
            { keepStoredDraft: true },
          )
        }
      >
        stub create
      </button>
    </div>
  ),
}));

const project = {
  id: 7,
  code: 'P-0042',
  name: 'P-0042 Support GoPro',
  description: 'Support caméra GoPro pour casque',
  status: 'active',
};

function renderAt(url: string) {
  window.history.pushState({}, '', url);
  render(<AitoPage />);
}

describe('AitoPage ?newFromProject= link', () => {
  const original = window.location.href;
  let linkBodies: unknown[];
  let createBodies: unknown[];

  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    Element.prototype.scrollIntoView = vi.fn();
    __resetBoardSync();
    linkBodies = [];
    createBodies = [];
    server.use(
      http.get('/api/v1/aito/', () => HttpResponse.json([])),
      http.get('/api/v1/projects/7', () => HttpResponse.json(project)),
      http.post('/api/v1/aito/', async ({ request }) => {
        createBodies.push(await request.json());
        return HttpResponse.json(makeProject({ id: 77, description: 'Support caméra' }), { status: 201 });
      }),
      http.get('/api/v1/aito/77/tasks', () => HttpResponse.json([{ id: 501, project_id: 77, position: 0 }])),
      http.put('/api/v1/aito/tasks/:taskId/project', async ({ request, params }) => {
        linkBodies.push({ taskId: params.taskId, body: await request.json() });
        return HttpResponse.json({ task_id: 501, task_title: null, project: null, sections: {}, deliveries: [] });
      }),
    );
  });

  afterEach(() => {
    window.history.replaceState({}, '', original);
    vi.mocked(localStorage.getItem).mockReset();
  });

  it('opens the drawer seeded from the project', async () => {
    renderAt('/aito?newFromProject=7');
    const seed = await screen.findByTestId('drawer-seed');
    expect(JSON.parse(seed.textContent ?? 'null')).toEqual({
      description: 'Support caméra GoPro pour casque',
      taskTitle: 'P-0042 Support GoPro',
    });
  });

  it('drops the parameter on submit, then links the created order\'s first task to the project', async () => {
    // The create is held open so the URL can be checked inside the
    // create→link window: a reload there must not reopen the seeded drawer.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    server.use(
      http.post('/api/v1/aito/', async ({ request }) => {
        createBodies.push(await request.json());
        await held;
        return HttpResponse.json(makeProject({ id: 77, description: 'Support caméra' }), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderAt('/aito?newFromProject=7');
    await screen.findByTestId('drawer-seed');
    await user.click(screen.getByRole('button', { name: 'stub create' }));

    await waitFor(() => expect(createBodies).toHaveLength(1));
    expect(window.location.search).not.toContain('newFromProject');
    expect(linkBodies).toEqual([]);
    release();

    await waitFor(() => expect(linkBodies).toEqual([{ taskId: '501', body: { project_id: 7 } }]));
    // The seeded drawer was never edited: the operator's stored draft stays.
    expect(localStorage.removeItem).not.toHaveBeenCalledWith('aito.newProjectDraft.v1');
  });

  it('closing the drawer without creating drops the parameter and links nothing', async () => {
    const user = userEvent.setup();
    renderAt('/aito?newFromProject=7');
    await screen.findByTestId('drawer-seed');
    await user.click(screen.getByRole('button', { name: 'stub close' }));

    await waitFor(() => expect(window.location.search).not.toContain('newFromProject'));
    expect(screen.queryByTestId('drawer-seed')).not.toBeInTheDocument();
    expect(linkBodies).toEqual([]);
  });

  it('the plain New project button still opens an unseeded drawer', async () => {
    const user = userEvent.setup();
    renderAt('/aito');
    await user.click(await screen.findByRole('button', { name: /^project$/i }));
    expect(JSON.parse((await screen.findByTestId('drawer-seed')).textContent ?? '')).toBeNull();
  });
});
