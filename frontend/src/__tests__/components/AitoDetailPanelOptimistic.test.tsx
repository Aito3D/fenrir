import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectDetailPanel } from '../../components/aito/ProjectDetailPanel';
import { ToastProvider } from '../../contexts/ToastContext';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';
import { flashRevert } from '../../hooks/useRevertFlash';

// `flashRevert` is imported as a direct binding by useOptimisticBoardMutation,
// so vi.spyOn on the module namespace would patch an object nobody reads.
// Mock the module instead, spreading the original so useIsReverting (which
// the card's revert-flash styling relies on) stays real.
vi.mock('../../hooks/useRevertFlash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useRevertFlash')>()),
  flashRevert: vi.fn(),
}));

// A project with every field the board cache needs, defaulted so a test can
// override only what it cares about. Copied from AitoQuoteStatusActions.test.tsx
// rather than shared — see that file's own fixture for the reasoning on
// `task_pending` defaulting to `task_services`.
function makeProject(overrides: Partial<AitoProject> = {}): AitoProject {
  const base: AitoProject = {
    id: 1,
    description: 'Support de caméra',
    column: 'devis',
    position: 0,
    status: 'active',
    client_id: 'z1',
    client_name: 'ACME SARL',
    client_phone: '+689-87123456',
    client_email: 'hi@acme.pf',
    client_is_company: null,
    quote_id: 'EST-1',
    quote_number: null,
    quote_date: null,
    quote_total: null,
    quote_url: null,
    quote_salesperson: null,
    quote_status: 'draft',
    quote_sync_state: 'idle',
    quote_sync_error: null,
    quote_status_block: null,
    quote_status_remote: null,
    created_by: null,
    task_count: 0,
    tasks_total: 0,
    task_services: [],
    task_pending: [],
    steps_total: 0,
    steps_done: 0,
    task_steps: [],
    move_lock: null,
    created_at: '2026-07-27T00:00:00',
    updated_at: '2026-07-27T00:00:00',
  };
  return {
    ...base,
    ...overrides,
    task_pending: overrides.task_pending ?? overrides.task_services ?? base.task_pending,
  };
}

/** Renders ProjectDetailPanel against a real QueryClient seeded with one
 *  project, and returns that client so a test can inspect the
 *  ['aito-projects'] cache directly. The panel also mounts TaskEditor (which
 *  fetches settings and, via useProjectTasks, the project's tasks) and
 *  ActivityRail (which fetches events and offers its own note textbox) — both
 *  are stubbed so the panel doesn't perform real network calls, and so
 *  ActivityRail's note input doesn't collide with the description field on a
 *  plain `getByRole('textbox')` query. */
function renderPanel(project: AitoProject) {
  vi.spyOn(api, 'getAitoTasks').mockResolvedValue([]);
  vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['aito-projects'], [project]);
  rtlRender(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ProjectDetailPanel project={project} onClose={() => {}} onDelete={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return client;
}

/** The description edit box, disambiguated from ActivityRail's note <input>
 *  — mounting the rail as the panel's third column means a plain
 *  `getByRole('textbox')` matches both, since a text <input> shares the
 *  textbox role with a <textarea>. Mirrors AitoPage.test.tsx's own helper. */
function getDescriptionTextarea(): HTMLTextAreaElement {
  return screen
    .getAllByRole('textbox')
    .find((el) => el.tagName === 'TEXTAREA') as HTMLTextAreaElement;
}

describe('ProjectDetailPanel optimistic writes', () => {
  beforeEach(() => {
    __resetBoardSync();
    vi.mocked(flashRevert).mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the new description before the PATCH resolves', async () => {
    let release: (v: unknown) => void = () => {};
    vi.spyOn(api, 'updateAitoProject').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const project = makeProject({ id: 1, description: 'old text' });
    const client = renderPanel(project);

    await userEvent.click(screen.getByRole('button', { name: /edit description/i }));
    const box = getDescriptionTextarea();
    await userEvent.clear(box);
    await userEvent.type(box, 'new text');
    await userEvent.tab();

    // The mutationFn above is deliberately still pending — `release` is not
    // called until after this assertion — so this is the optimistic write,
    // not a fluke of the request having already settled.
    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].description).toBe('new text');
    });
    release(makeProject({ id: 1, description: 'new text' }));
  });

  it('restores the old description and flashes when the PATCH fails', async () => {
    vi.spyOn(api, 'updateAitoProject').mockRejectedValue(new Error('nope'));
    const flash = vi.mocked(flashRevert);
    const project = makeProject({ id: 1, description: 'old text' });
    const client = renderPanel(project);

    await userEvent.click(screen.getByRole('button', { name: /edit description/i }));
    const box = getDescriptionTextarea();
    await userEvent.clear(box);
    await userEvent.type(box, 'new text');
    await userEvent.tab();

    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].description).toBe('old text');
    });
    expect(flash).toHaveBeenCalledWith(1);
  });

  it('flips quote_sync_state to pending the moment retry sync is clicked, before the PATCH resolves', async () => {
    // The retry-sync button sends the description UNCHANGED — its only job is
    // to re-mark the project pending for the Zoho worker — so the optimistic
    // transform must branch to applySyncState rather than applyDescription.
    // Nothing else in this task covers that branch.
    let release: (v: unknown) => void = () => {};
    vi.spyOn(api, 'updateAitoProject').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const project = makeProject({ id: 1, quote_sync_state: 'error', quote_sync_error: 'boom' });
    const client = renderPanel(project);

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].quote_sync_state).toBe('pending');
    });
    // The description must not have been touched by the branch that fires
    // for a genuine edit.
    expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].description).toBe(project.description);
    release(makeProject({ id: 1, quote_sync_state: 'pending' }));
  });
});
