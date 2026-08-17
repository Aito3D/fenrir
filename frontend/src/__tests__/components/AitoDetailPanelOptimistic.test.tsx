import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ProjectDetailPanel } from '../../components/aito/ProjectDetailPanel';
import { AuthProvider } from '../../contexts/AuthContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { __resetOwnAckedVersion } from '../../components/aito/useProjectPatchMutation';
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
    flag: null,
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
          <ProjectDetailPanel canCreate canUpdate canDelete project={project} onClose={() => {}} onDelete={() => {}} />
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
    __resetOwnAckedVersion();
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
    return <ProjectDetailPanel canCreate canUpdate canDelete project={current} onClose={() => {}} onDelete={() => {}} />;
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
  beforeEach(() => {
    __resetBoardSync();
    __resetOwnAckedVersion();
  });
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

// T-021: `ownAckedVersion` (useProjectPatchMutation.ts) is a module-level map,
// never pruned. The F2 suite above reuses project id 1 and — by design —
// leaves that map holding `1 -> 3` when it finishes (the last `resolve()`
// acks version 3). Without a per-test reset, THIS suite (also id 1) would
// silently inherit that leftover entry: its typed edit session captures
// `expected_version: 1`, but `useProjectPatchMutation`'s
// `Math.max(patch.expected_version, ownAckedVersion.get(1))` would send `3`
// instead — a wrong value on the wire, entirely dependent on F2 having run
// first in this file. `__resetOwnAckedVersion()` in `beforeEach` is what
// makes this test's outcome independent of file order.
describe('T-021 — ownAckedVersion does not leak across tests reusing project id 1', () => {
  beforeEach(() => {
    __resetBoardSync();
    __resetOwnAckedVersion();
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends the session-captured version, not a leftover acked version from an earlier test at the same id', async () => {
    const calls: { patch: AitoProjectUpdate; resolve: (v: AitoProject) => void }[] = [];
    vi.spyOn(api, 'updateAitoProject').mockImplementation(
      (_id, patch) =>
        new Promise<AitoProject>((resolve) => {
          calls.push({ patch: patch as AitoProjectUpdate, resolve });
        }),
    );

    // Same project id (1) and starting version (1) the F2 suite above used —
    // if the reset above were missing, F2's leftover `1 -> 3` entry would
    // corrupt this session's expected_version.
    const project = makeProject({ id: 1, version: 1, description: 'old text' });
    renderPanelReactive(project);

    await userEvent.click(screen.getByRole('button', { name: /edit description/i }));
    const box = getDescriptionTextarea();
    await userEvent.clear(box);
    await userEvent.type(box, 'new text');
    await userEvent.tab();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].patch.expected_version).toBe(1);

    calls[0].resolve({ ...project, description: 'new text', version: 2 });
  });
});

describe('T-012 — cross-operator version guard on the description edit session', () => {
  beforeEach(() => {
    __resetBoardSync();
    __resetOwnAckedVersion();
  });
  afterEach(() => vi.restoreAllMocks());

  // T-012's exact repro: operator A opens the description editor at version 1
  // and types over it. Before A saves, operator B's own edit lands and the
  // board's WS-triggered refetch rewrites the `['aito-projects']` cache under
  // A's still-open editor (mirrored here by pushing straight into the cache,
  // the same effect `boardSync.resyncIfIdle` -> `invalidateQueries` has).
  // `ProjectDetailPanel.tsx`'s `editingDesc` guard deliberately does not
  // reseed the textarea, so A's draft still reads their own typed text. A
  // then blurs. The bug this pins: computing `expected_version` by re-reading
  // the (now B-owned) cache at save time makes A's PATCH carry B's version,
  // which matches the server and silently overwrites B's edit with no 409.
  it('rejects with 409 and reopens the editor on A\'s text, instead of silently overwriting B\'s save', async () => {
    // A tiny stand-in server: the real guard this whole task is about
    // (routes/aito.py:1637) is `expected_version != project.version -> 409`.
    // Modelling it here — rather than a canned mock — is what lets this test
    // tell the two behaviours apart: the bug sends whatever the client cache
    // currently holds (which would happen to match `serverVersion` and pass);
    // the fix sends what A's edit was actually based on (which must not).
    let serverVersion = 2; // already bumped by B's own (untested-here) save
    let serverDescription = 'B text';
    vi.spyOn(api, 'updateAitoProject').mockImplementation((_id, patch) => {
      if (patch.expected_version !== undefined && patch.expected_version !== serverVersion) {
        return Promise.reject(new ApiError('stale', 409, 'version_conflict'));
      }
      serverVersion += 1;
      if (patch.description !== undefined) serverDescription = patch.description;
      return Promise.resolve({ ...project, description: serverDescription, version: serverVersion });
    });

    const project = makeProject({ id: 7, description: 'A description', version: 1 });
    const client = renderPanelReactive(project);

    // 1. Operator A opens the description editor at version 1 and types.
    await userEvent.click(screen.getByRole('button', { name: /edit description/i }));
    const box = getDescriptionTextarea();
    await userEvent.clear(box);
    await userEvent.type(box, 'A text');

    // 2. Operator B's edit lands: the board cache is rewritten under A's
    //    still-open editor, exactly as the WS-triggered refetch would.
    act(() => {
      client.setQueryData(['aito-projects'], [{ ...project, description: 'B text', version: 2 }]);
    });

    // A's draft must survive the refresh untouched — the guard this whole bug
    // depends on.
    expect(getDescriptionTextarea()).toHaveValue('A text');

    // 3. A blurs, saving over what A last saw.
    await userEvent.tab();

    // The save must be rejected (409) rather than silently accepted, and the
    // editor must reopen on A's own typed text per the spec's error-handling
    // table — not the (now doubly stale) server description.
    await waitFor(() => {
      expect(getDescriptionTextarea()).toBeInTheDocument();
    });
    expect(getDescriptionTextarea()).toHaveValue('A text');

    // B's save must not have been clobbered.
    expect(client.getQueryData<AitoProject[]>(['aito-projects'])?.[0].description).toBe('B text');
    expect(serverDescription).toBe('B text');
  });
});

// T-047: `ownAckedVersion`'s old `Math.max(patch.expected_version,
// ownAckedVersion.get(id))` raised a session's captured version to whatever
// this client had most recently acked, with no regard for what happened in
// between. The F2 suite above proves that raise is needed for a same-client
// back-to-back save (both sessions captured off the SAME pre-burst version,
// so the ack legitimately covers the second one too). This suite proves the
// old unconditional `Math.max` went further than that: it also raised a
// session that was captured BEFORE a peer's write, using an ack this client
// earned AFTER that peer's write (from an unrelated save, opened fresh post
// -refresh) — letting the stale session's PATCH sail past the version guard
// and silently overwrite the peer's edit with no 409. The fix only trusts an
// ack whose own `from` (what it was sent with) is `<=` the stale session's
// capture — i.e. the ack must descend from the SAME base — which this
// sequence's ack (`from: 6`) does not (the stale session captured `5`).
describe('T-047 — a stale session left open across a peer\'s write does not inherit a later, unrelated ack', () => {
  beforeEach(() => {
    __resetBoardSync();
    __resetOwnAckedVersion();
  });
  afterEach(() => vi.restoreAllMocks());

  it('409s the stale shipping save instead of overwriting the peer\'s phone correction', async () => {
    const calls: { patch: AitoProjectUpdate }[] = [];
    // Same stand-in server shape as the T-012 suite above: reject with 409
    // unless the sent expected_version matches the server's current version.
    // `serverProject` accumulates every accepted write (including B's, done
    // directly against server state below rather than through this client's
    // own mutation) so a later success response reflects the real row, not a
    // stale fixture snapshot.
    let serverProject: AitoProject;
    vi.spyOn(api, 'updateAitoProject').mockImplementation((_id, patch) => {
      calls.push({ patch: patch as AitoProjectUpdate });
      if (patch.expected_version !== undefined && patch.expected_version !== serverProject.version) {
        return Promise.reject(new ApiError('stale', 409, 'version_conflict'));
      }
      serverProject = { ...serverProject, ...patch, version: serverProject.version + 1 };
      return Promise.resolve(serverProject);
    });

    const project = makeProject({
      id: 9,
      version: 5,
      description: 'old text',
      shipping_island: 'rangiroa',
      shipping_service: 'tuamotu',
      shipping_service_name: 'Livraison Avion Tuamotu',
      shipping_first_name: 'Jean',
      shipping_last_name: 'Pierre',
      shipping_phone: '+689-89645864',
      shipping_price: 3200,
    });
    serverProject = project;
    const client = renderPanelReactive(project);

    // 1. Operator A opens the shipping editor — `editVersionRef.current`
    //    captures `project.version` = 5 right now, and stays 5 no matter what
    //    happens on the board while the editor stays open.
    await userEvent.click(screen.getByRole('button', { name: /edit shipping/i }));

    // 2. Operator B corrects the phone number elsewhere: server -> 6. A's
    //    board refetches on the `aito_changed` WS event exactly as
    //    `boardSync.resyncIfIdle` -> `invalidateQueries` would, rewriting the
    //    cache under A's still-open (and un-reseeded) shipping draft.
    serverProject = { ...serverProject, shipping_phone: '+689-00000000', version: 6 };
    act(() => {
      client.setQueryData(['aito-projects'], [serverProject]);
    });

    // 3. A saves something unrelated — the description — from a session
    //    opened just now, AFTER the refresh, so it correctly captures 6.
    await userEvent.click(screen.getByRole('button', { name: /edit description/i }));
    const box = getDescriptionTextarea();
    await userEvent.clear(box);
    await userEvent.type(box, 'A note');
    await userEvent.tab();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].patch.expected_version).toBe(6);
    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])?.[0].description).toBe('A note');
    });
    // This client's own ack is now {from: 6, to: 7} — a real, newer version,
    // but one that does not descend from the shipping session's base of 5.
    expect(serverProject.version).toBe(7);

    // 4. A finally clicks Save on the shipping editor that has been open
    //    since step 1. Its session capture is still 5.
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(calls).toHaveLength(2));
    // The value actually put on the wire is what this whole mechanism turns
    // on: it must stay 5 (the session's own capture), NOT be raised to 7 by
    // the unrelated ack from step 3.
    expect(calls[1].patch.expected_version).toBe(5);
    // 5 != the server's actual 7 -> the stand-in server 409s, same as the
    // real guard (routes/aito.py:1637) would.
    expect(serverProject.version).toBe(7);

    // The shipping editor must still be open (ShippingCard only closes it in
    // `onSuccess`) rather than having quietly saved.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
    });
    // B's phone correction must not have been clobbered by A's stale draft.
    expect(client.getQueryData<AitoProject[]>(['aito-projects'])?.[0].shipping_phone).toBe('+689-00000000');
  });

  // S1: the mirror image of the case above, and the exact gap a first
  // revision of this fix left open (caught by the blind verifier, not by
  // this suite): substituting `acked.to` outright instead of
  // `Math.max(patch.expected_version, acked.to)` behind the descent check.
  // This client's OWN save moves the server ahead (3 -> 4); a peer then
  // moves it further (-> 5); a session that opens FRESH, after that peer
  // write, correctly captures the already-current 5 — newer than this
  // client's own ack. The descent check (`acked.from` 3 `<=` 5) passes, so
  // outright substitution would send the ack's `to` (4) — OLDER than the
  // session's own fresh capture — and draw a false 409 against a save that
  // was never stale. `Math.max` is what keeps the capture from ever being
  // lowered.
  it('sends the freshly-captured version, not an older unrelated ack, for a session opened after a peer write', async () => {
    const calls: { patch: AitoProjectUpdate }[] = [];
    let serverProject: AitoProject;
    vi.spyOn(api, 'updateAitoProject').mockImplementation((_id, patch) => {
      calls.push({ patch: patch as AitoProjectUpdate });
      if (patch.expected_version !== undefined && patch.expected_version !== serverProject.version) {
        return Promise.reject(new ApiError('stale', 409, 'version_conflict'));
      }
      serverProject = { ...serverProject, ...patch, version: serverProject.version + 1 };
      return Promise.resolve(serverProject);
    });

    const project = makeProject({ id: 12, version: 3, description: 'd0' });
    serverProject = project;
    const client = renderPanelReactive(project);

    // 1. This client's OWN save: description session captured at 3, saved,
    //    succeeds -> server 4. `ownAckedVersion` now holds {from: 3, to: 4}.
    await userEvent.click(screen.getByRole('button', { name: /edit description/i }));
    let box = getDescriptionTextarea();
    await userEvent.clear(box);
    await userEvent.type(box, 'd1');
    await userEvent.tab();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].patch.expected_version).toBe(3);
    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])?.[0].description).toBe('d1');
    });
    expect(serverProject.version).toBe(4);

    // 2. A peer's write lands, moving the server further ahead than this
    //    client's own ack: server -> 5. The board refetches.
    serverProject = { ...serverProject, version: 5 };
    act(() => {
      client.setQueryData(['aito-projects'], [serverProject]);
    });

    // 3. A brand-new editor session opens AFTER that refresh, so it
    //    correctly captures the current version, 5.
    await userEvent.click(screen.getByRole('button', { name: /edit description/i }));
    box = getDescriptionTextarea();
    await userEvent.clear(box);
    await userEvent.type(box, 'd2');
    await userEvent.tab();

    await waitFor(() => expect(calls).toHaveLength(2));
    // The value actually put on the wire is what this whole mechanism turns
    // on: it must be 5 (this session's own fresh capture), not 4 (the older,
    // unrelated ack from step 1).
    expect(calls[1].patch.expected_version).toBe(5);

    // 5 matches the server's actual version -> succeeds, no false conflict.
    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])?.[0].description).toBe('d2');
    });
    expect(serverProject.version).toBe(6);
    // The editor must have closed on success, not reopened on a 409.
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
  });

  // S3: the same hazard as S1, reached by a different route — a no-op save
  // (unchanged shipping fields, still a real PATCH: `ShippingCard.save`
  // never skips a resend the way the description session's no-op guard
  // does) whose own ack happens to have `from === to` (the server did not
  // need to move the version for it). A fresh session opened after a peer's
  // write must still send ITS OWN captured version, not that unmoved ack.
  it('sends the freshly-captured version after a peer write even when this client\'s own last ack did not move the server', async () => {
    const calls: { patch: AitoProjectUpdate }[] = [];
    let serverProject: AitoProject;
    let noOpConsumed = false;
    vi.spyOn(api, 'updateAitoProject').mockImplementation((_id, patch) => {
      calls.push({ patch: patch as AitoProjectUpdate });
      if (patch.expected_version !== undefined && patch.expected_version !== serverProject.version) {
        return Promise.reject(new ApiError('stale', 409, 'version_conflict'));
      }
      if (!noOpConsumed) {
        // The first accepted write is a genuine no-op (unchanged shipping
        // fields) — models a server that does not bump the version when
        // nothing actually changed, so this client's own ack is
        // {from: 3, to: 3}.
        noOpConsumed = true;
        serverProject = { ...serverProject, ...patch };
        return Promise.resolve(serverProject);
      }
      serverProject = { ...serverProject, ...patch, version: serverProject.version + 1 };
      return Promise.resolve(serverProject);
    });

    const project = makeProject({
      id: 13,
      version: 3,
      shipping_island: 'rangiroa',
      shipping_service: 'tuamotu',
      shipping_service_name: 'Livraison Avion Tuamotu',
      shipping_first_name: 'Jean',
      shipping_last_name: 'Pierre',
      shipping_phone: '+689-89645864',
      shipping_price: 3200,
    });
    serverProject = project;
    const client = renderPanelReactive(project);

    // 1. This client saves the shipping editor unchanged, captured at 3 —
    //    a genuine no-op that the stand-in server accepts without moving
    //    the version. `ownAckedVersion` now holds {from: 3, to: 3}.
    await userEvent.click(screen.getByRole('button', { name: /edit shipping/i }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].patch.expected_version).toBe(3);
    expect(serverProject.version).toBe(3);
    // The editor closes on success.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /edit shipping/i })).toBeInTheDocument();
    });

    // 2. A peer's write lands: server -> 4. The board refetches.
    serverProject = { ...serverProject, shipping_phone: '+689-11111111', version: 4 };
    act(() => {
      client.setQueryData(['aito-projects'], [serverProject]);
    });

    // 3. A brand-new shipping session opens AFTER that refresh, correctly
    //    capturing 4.
    await userEvent.click(screen.getByRole('button', { name: /edit shipping/i }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(calls).toHaveLength(2));
    // Must be 4 (this session's own fresh capture), not 3 (the unmoved,
    // unrelated ack from step 1).
    expect(calls[1].patch.expected_version).toBe(4);

    // 4 matches the server's actual version -> succeeds, no false conflict.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /edit shipping/i })).toBeInTheDocument();
    });
    expect(serverProject.version).toBe(5);
  });
});
