import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ProjectDetailPanel } from '../../components/aito/ProjectDetailPanel';
import { AuthProvider } from '../../contexts/AuthContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { api, ApiError } from '../../api/client';
import type { AitoProject, AitoProjectUpdate } from '../../api/client';
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
    client_social_network: null,
    client_social_handle: null,
    quote_id: 'EST-1',
    quote_number: null,
    quote_date: null,
    quote_total: null,
    quote_url: null,
    quote_salesperson: null,
    quote_status: 'draft',
    quote_accepted_at: null,
    quote_sync_state: 'idle',
    quote_invoiced: false,
    urgent: false,
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
    shipping_island: null,
    shipping_service: null,
    shipping_first_name: null,
    shipping_last_name: null,
    shipping_phone: null,
    shipping_price: null,
    shipping_service_name: null,
    version: 1,
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
      <AuthProvider>
        <ToastProvider>
          <ProjectDetailPanel project={project} onClose={() => {}} onDelete={() => {}} />
        </ToastProvider>
      </AuthProvider>
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

  // F1: the spec's error-handling table promises the operator's typed text
  // survives a version conflict — a slower save must not cost them the edit
  // they just made. Every OTHER failure still reverts (see the test above),
  // so this pins the one code path (`ApiError` with `code ===
  // 'version_conflict'`) that must not.
  it('reopens the description editor with the typed text on a version_conflict 409', async () => {
    vi.spyOn(api, 'updateAitoProject').mockRejectedValue(
      new ApiError('stale', 409, 'version_conflict'),
    );
    const project = makeProject({ id: 1, description: 'old text' });
    renderPanel(project);

    await userEvent.click(screen.getByRole('button', { name: /edit description/i }));
    const box = getDescriptionTextarea();
    await userEvent.clear(box);
    await userEvent.type(box, 'new text');
    await userEvent.tab();

    // The editor re-opens (the textarea comes back) with the typed text
    // still in it, rather than the panel settling back on the read-only
    // paragraph showing the (now stale) server description.
    await waitFor(() => {
      expect(getDescriptionTextarea()).toBeInTheDocument();
    });
    expect(getDescriptionTextarea()).toHaveValue('new text');
  });
});

/** Renders `ProjectDetailPanel` wrapped in a component that re-derives
 *  `project` from the `['aito-projects']` cache on every change, mirroring
 *  how `AitoPage` actually feeds the panel (`expandedProject`, a `useMemo`
 *  over `aitoQuery.data` — see AitoPage.tsx). `renderPanel` above hands the
 *  panel a fixed snapshot instead, which is the right shape for pinning ONE
 *  mutation's own optimistic write, but wrong for F2: the whole question is
 *  whether a second mutation's `mutationFn` closure ever sees a version a
 *  FIRST mutation's `onSuccess` bumped, and that can only happen if the tree
 *  actually re-renders with the fresh cache row in between — exactly what
 *  `AitoPage`'s reactive selection (and this harness) provides. */
function renderPanelReactive(project: AitoProject) {
  vi.spyOn(api, 'getAitoTasks').mockResolvedValue([]);
  vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
  vi.spyOn(api, 'getAitoShippingServices').mockResolvedValue({ services: [], catalogue_resolved: true });

  const client = new QueryClient({
    defaultOptions: {
      // staleTime: Infinity — this queryFn is a stand-in for the network
      // request AitoPage's real `aitoQuery` makes; nothing here should ever
      // actually run it, only `setQueryData` calls (seed + optimistic
      // writes + onSuccess) are meant to drive this cache entry.
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(['aito-projects'], [project]);

  function Harness() {
    const { data } = useQuery<AitoProject[]>({
      queryKey: ['aito-projects'],
      queryFn: () => Promise.resolve(client.getQueryData<AitoProject[]>(['aito-projects']) ?? []),
    });
    const current = data?.find((p) => p.id === project.id);
    if (!current) return null;
    return <ProjectDetailPanel project={current} onClose={() => {}} onDelete={() => {}} />;
  }

  rtlRender(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return client;
}

describe('F2 — self-conflict on back-to-back saves from one client (empirical)', () => {
  beforeEach(() => __resetBoardSync());
  afterEach(() => vi.restoreAllMocks());

  // All three panel mutations build `expected_version: project.version` from
  // the render closure. Concern: a description save fires on blur, so
  // "type description -> click shipping Save" can queue two PATCHes where
  // the second still carries the pre-first-save version -> a false 409
  // against a peer who never touched the row.
  //
  // BUT `useOptimisticBoardMutation` gives every board write the SAME
  // `scope: {id: 'aito-board'}`, which react-query uses to serialize
  // mutations: the second mutation's ACTUAL mutationFn execution is queued
  // behind the first one's settle (see @tanstack/query-core's
  // `mutationCache.canRun`/`runNext`). Whether the closure that finally runs
  // is the STALE one captured when `.mutate()` was first called, or a FRESH
  // one rebound by the re-render `onSuccess` triggers before the queue lets
  // the second request go, decides whether this bug is real. This test does
  // not reason about it — it drives the real react-query mutation queue
  // through two of this panel's own mutations and reads the wire body.
  it('sends the freshest acked version on the second request, not the stale render closure', async () => {
    const calls: { patch: AitoProjectUpdate; resolve: (v: AitoProject) => void }[] = [];
    vi.spyOn(api, 'updateAitoProject').mockImplementation(
      (_id, patch) =>
        new Promise<AitoProject>((resolve) => {
          calls.push({ patch: patch as AitoProjectUpdate, resolve });
        }),
    );

    const project = makeProject({
      id: 1,
      version: 1,
      description: 'old text',
      shipping_island: 'rangiroa',
      shipping_service: 'tuamotu',
      shipping_service_name: 'Livraison Avion Tuamotu',
      shipping_first_name: 'Jean',
      shipping_last_name: 'Pierre',
      shipping_phone: '+689-89645864',
      shipping_price: 3200,
    });
    renderPanelReactive(project);

    // 1. Type a new description and blur — the first board-scoped mutation.
    await userEvent.click(screen.getByRole('button', { name: /edit description/i }));
    const box = getDescriptionTextarea();
    await userEvent.clear(box);
    await userEvent.type(box, 'new text');
    await userEvent.tab();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].patch.expected_version).toBe(1);

    // 2. Before that PATCH resolves, open the shipping editor and click Save
    //    unchanged — the second board-scoped mutation, fired while the
    //    first is still in flight from a single operator's own actions.
    await userEvent.click(screen.getByRole('button', { name: /edit shipping/i }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    // The scope gates the second mutationFn behind the first one's settle,
    // so it must not have executed (and therefore not called the mock) yet
    // — this is the "queued, not concurrent" half of the architecture's
    // claim.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);

    // 3. Resolve the first PATCH with the server's bumped version, exactly
    //    as the real backend would after incrementing `project.version`.
    calls[0].resolve({ ...project, description: 'new text', version: 2 });

    // 4. The second mutation's mutationFn now runs — read what it actually
    //    put on the wire.
    await waitFor(() => expect(calls).toHaveLength(2));
    // F2 asks for the empirical result to be visible in the test run's own
    // output, not just asserted.
    console.log('F2 empirical result: second PATCH expected_version =', calls[1].patch.expected_version);
    expect(calls[1].patch.expected_version).toBe(2);

    calls[1].resolve({ ...project, version: 3, shipping_price: 3200 });
  });
});
