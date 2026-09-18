import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render } from '../utils';
import { QuoteStatusActions } from '../../components/aito/QuoteStatusActions';
import { ProjectDoneAction } from '../../components/aito/ProjectDoneAction';
import { ToastProvider } from '../../contexts/ToastContext';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';
import { flashRevert } from '../../hooks/useRevertFlash';
import { makeProject as makeBaseProject } from '../fixtures/aitoProject';

// `flashRevert` is imported as a direct binding by useOptimisticBoardMutation,
// so vi.spyOn on the module namespace would patch an object nobody reads.
// Mock the module instead, spreading the original so useIsReverting (which
// the card's revert-flash styling relies on) stays real.
vi.mock('../../hooks/useRevertFlash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useRevertFlash')>()),
  flashRevert: vi.fn(),
}));

const project = { id: 12, quote_id: 'EST-9', quote_status: 'draft' } as unknown as AitoProject;

// Wraps the shared `../fixtures/aitoProject` base: `task_pending` mirrors
// `task_services` unless a test says otherwise — a fresh fixture assumes
// nothing is done yet, which is what every caller below actually wants. The
// shared base itself applies overrides verbatim with no such fallback (see
// `AitoTrackingLinkControl.test.tsx`, which needs that plain behavior).
function makeProject(overrides: Partial<AitoProject> = {}): AitoProject {
  const project = makeBaseProject(overrides);
  return {
    ...project,
    task_pending: overrides.task_pending ?? overrides.task_services ?? project.task_pending,
  };
}

/** Renders QuoteStatusActions against a real QueryClient seeded with one
 *  project, and returns that client so a test can inspect the
 *  ['aito-projects'] cache directly — the custom `render` from '../utils'
 *  hides its client inside its own provider tree, which is no good for tests
 *  that need to assert on the cache mid-mutation. */
function renderWithBoard(project: AitoProject) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['aito-projects'], [project]);
  rtlRender(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <QuoteStatusActions project={project} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return client;
}

/** Holds a button through HoldButton's confirm delay under the suite's fake
 *  timers, mirroring the `[MouseLeft>]` + `advanceTimersByTime` pattern the
 *  rest of this file already uses for the 500ms hold. */
async function holdButton(button: HTMLElement) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.pointer({ keys: '[MouseLeft>]', target: button });
  vi.advanceTimersByTime(600);
}

describe('QuoteStatusActions', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __resetBoardSync();
    vi.mocked(flashRevert).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('does not fire before the hold completes', async () => {
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<QuoteStatusActions project={{ ...project, quote_status: 'sent' }} />);

    const accept = screen.getByRole('button', { name: /accept quote/i });
    await user.pointer({ keys: '[MouseLeft>]', target: accept });
    vi.advanceTimersByTime(300);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fires once the 500ms hold completes', async () => {
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<QuoteStatusActions project={{ ...project, quote_status: 'sent' }} />);

    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: /accept quote/i }) });
    vi.advanceTimersByTime(600);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, { status: 'accepted' }));
  });

  it('shows hold progress as a bar, tinted to the action, not a ring', () => {
    // These are wide labelled pills. The ring's viewBox scales to the shorter
    // axis, so on a pill it lands as a small circle over the middle of the
    // label rather than as progress. Accept fills green and Decline red —
    // a red bar under "Accept quote" reads as the wrong outcome mid-gesture.
    render(<QuoteStatusActions project={{ ...project, quote_status: 'sent' }} />);

    const accept = screen.getByRole('button', { name: /accept quote/i });
    const decline = screen.getByRole('button', { name: /decline quote/i });

    // The ring is the only <circle> in the button — the ThumbsUp glyph shares
    // lucide's 0 0 24 24 viewBox, so selecting on that matches the icon too.
    expect(accept.querySelector('circle')).toBeNull();
    expect(accept.querySelector('[data-testid="hold-progress-bar"]')?.className).toContain('bg-bambu-green/25');
    expect(decline.querySelector('[data-testid="hold-progress-bar"]')?.className).toContain('bg-status-error/25');
  });

  it('renders nothing at all once the quote is accepted', () => {
    render(<QuoteStatusActions project={{ ...project, quote_status: 'accepted' }} />);
    expect(screen.queryByRole('button', { name: /accept quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /decline quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
  });

  it('keeps Accept, and only Accept, on a declined quote', () => {
    // The one way out of 'declined'. It is reachable without anyone choosing
    // it — trashing a project declines its estimate, and re-importing that
    // quote makes a card that is born declined — and nothing else can undo it:
    // the reconciler owns a local decline, so it pushes it back over a
    // Books-side reopen or records a permanent conflict. Deleting this
    // expectation makes 'declined' absorbing again.
    render(<QuoteStatusActions project={{ ...project, quote_status: 'declined' }} />);
    expect(screen.getByRole('button', { name: /accept quote/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /decline quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
  });

  it('sends the accepted transition from a declined quote', async () => {
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<QuoteStatusActions project={{ ...project, quote_status: 'declined' }} />);

    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: /accept quote/i }) });
    vi.advanceTimersByTime(600);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, { status: 'accepted' }));
    expect(await screen.findByText('Quote accepted')).toBeInTheDocument();
  });

  it('drops Mark as sent once the client already has the quote', () => {
    for (const quote_status of ['sent', 'viewed', 'expired']) {
      const { unmount } = render(<QuoteStatusActions project={{ ...project, quote_status }} />);
      expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /accept quote/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /decline quote/i })).toBeEnabled();
      unmount();
    }
  });

  it('sends the sent transition when its hold completes', async () => {
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<QuoteStatusActions project={project} />);

    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: /mark as sent/i }) });
    vi.advanceTimersByTime(600);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, { status: 'sent' }));
    expect(await screen.findByText('Quote marked as sent')).toBeInTheDocument();
  });

  it('offers only Mark as sent while the quote is still a draft', () => {
    // The Quote column IS quote_status null-or-draft: aito_board_rules.evaluate
    // derives the column from the status, so these are the same condition. A
    // quote the client has never received cannot be accepted or declined.
    render(<QuoteStatusActions project={{ ...project, quote_status: 'draft' }} />);
    expect(screen.getByRole('button', { name: /mark as sent/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /accept quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /decline quote/i })).not.toBeInTheDocument();
  });

  it('offers only Mark as sent on a hand-made card with no quote at all', () => {
    render(<QuoteStatusActions project={{ ...project, quote_id: null, quote_status: null }} />);
    expect(screen.getByRole('button', { name: /mark as sent/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /accept quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /decline quote/i })).not.toBeInTheDocument();
  });

  it('offers Accept and Decline, and not Mark as sent, once the quote is out', () => {
    for (const status of ['sent', 'viewed', 'expired'] as const) {
      const { unmount } = render(<QuoteStatusActions project={{ ...project, quote_status: status }} />);
      expect(screen.getByRole('button', { name: /accept quote/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /decline quote/i })).toBeEnabled();
      expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('warns that Zoho was not updated when the board saved but the push did not sync', async () => {
    // The success handler's second toast (useQuoteStatusMutation ~line 49):
    // the board's own write landed, so no rollback and the normal success
    // toast still fires — but a quote-backed project whose push to Books
    // failed gets the aito.zohoNotUpdated error toast on top of it.
    vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: false });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<QuoteStatusActions project={project} />);

    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: /mark as sent/i }) });
    vi.advanceTimersByTime(600);

    expect(await screen.findByText(/zoho was not updated/i)).toBeInTheDocument();
  });

  it('moves the card the moment accept is held, before the request resolves', async () => {
    // A quote already sent to the client (Accept is only offered once the
    // quote is out — see the "ACCEPT AND DECLINE ARE HIDDEN" note on
    // QuoteStatusActions) with one unticked step lands in its first pending
    // stage as soon as accept is optimistically applied.
    let release: (v: unknown) => void = () => {};
    vi.spyOn(api, 'setAitoQuoteStatus').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const project = makeProject({
      id: 1, column: 'devis', quote_status: 'sent',
      task_services: ['impression'], steps_total: 1, steps_done: 0,
    });
    const client = renderWithBoard(project);

    await holdButton(screen.getByRole('button', { name: /accept/i }));

    // The mutationFn above is deliberately still pending — `release` is not
    // called until after these assertions — so this is the optimistic write,
    // not a fluke of the request having already settled. `waitFor` here is
    // only absorbing React Query's internal microtask chain (onMutate awaits
    // `cancelQueries`), not the request itself.
    await waitFor(() => {
      const cached = client.getQueryData<AitoProject[]>(['aito-projects'])!;
      expect(cached[0].column).toBe('print');
      expect(cached[0].quote_status).toBe('accepted');
    });
    release(null);
  });

  it('puts the card back and flashes when the server refuses', async () => {
    vi.spyOn(api, 'setAitoQuoteStatus').mockRejectedValue(new Error('nope'));
    const flash = vi.mocked(flashRevert);

    const project = makeProject({ id: 1, column: 'devis', quote_status: 'sent' });
    const client = renderWithBoard(project);

    await holdButton(screen.getByRole('button', { name: /accept/i }));

    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].column).toBe('devis');
    });
    expect(flash).toHaveBeenCalledWith(1);
  });

  it('sends the declined transition when its hold completes', async () => {
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<QuoteStatusActions project={{ ...project, quote_status: 'sent' }} />);

    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: /decline quote/i }) });
    vi.advanceTimersByTime(600);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, { status: 'declined' }));
    expect(await screen.findByText('Quote declined')).toBeInTheDocument();
  });

  it('puts the card back and flashes when the server refuses a decline', async () => {
    vi.spyOn(api, 'setAitoQuoteStatus').mockRejectedValue(new Error('nope'));
    const flash = vi.mocked(flashRevert);

    const project = makeProject({ id: 1, column: 'waiting', quote_status: 'sent' });
    const client = renderWithBoard(project);

    await holdButton(screen.getByRole('button', { name: /decline quote/i }));

    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].column).toBe('waiting');
    });
    expect(flash).toHaveBeenCalledWith(1);
  });
});

/** Renders QuoteStatusActions from the LIVE cache row, the way the panel
 *  does (its `project` is derived from the board query), so the optimistic
 *  write re-renders the block with the new status. A static prop would never
 *  flip, and the settle window under test would have nothing to hold back. */
function LiveActions({ id }: { id: number }) {
  const { data } = useQuery<AitoProject[]>({
    queryKey: ['aito-projects'],
    queryFn: () => Promise.reject(new Error('seeded, never fetched')),
    enabled: false,
  });
  const project = data?.find((p) => p.id === id);
  return project ? <QuoteStatusActions project={project} /> : null;
}

function renderLive(project: AitoProject) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['aito-projects'], [project]);
  rtlRender(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <LiveActions id={project.id} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return client;
}

/** Points the reduced-motion query at `matches` for one test. The setup's
 *  matchMedia is a plain function rather than a vi.fn, so it is swapped
 *  wholesale and put back. */
function withReducedMotion(matches: boolean) {
  const original = window.matchMedia;
  window.matchMedia = (query: string) => ({
    ...original(query),
    matches: query.includes('prefers-reduced-motion') ? matches : false,
  });
  return () => {
    window.matchMedia = original;
  };
}

describe('QuoteStatusActions settle window', () => {
  // The mutation is optimistic, so `quote_status` flips on the tick the hold
  // fires. Rendering straight from it unmounted the held button on that
  // frame — before HoldButton's completion bounce and bar fade, started on
  // the same tick, had drawn anything. The block now keeps drawing from the
  // status it was held ON for HoldButton's 700ms `completed` window, inert,
  // then fades the leaving buttons out over 150ms. The mutation itself is
  // never delayed — the cache assertions below run before any timer moves.
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __resetBoardSync();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the held buttons on screen, inert, through the completion choreography, then fades them out', async () => {
    const row = makeProject({ id: 1, column: 'waiting', quote_status: 'sent' });
    vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({
      project: { ...row, quote_status: 'accepted', column: 'print' },
      zoho_synced: true,
      no_op: false,
    });
    const client = renderLive(row);

    await holdButton(screen.getByRole('button', { name: /accept quote/i }));
    await waitFor(() =>
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].quote_status).toBe('accepted'),
    );

    // The status has flipped and both buttons are still here, inert and not
    // yet leaving: this is the window the bounce plays in.
    const accept = screen.getByRole('button', { name: /accept quote/i });
    expect(accept).toBeDisabled();
    expect(screen.getByRole('button', { name: /decline quote/i })).toBeDisabled();
    expect(accept.className).not.toContain('animate-fade-out-sm');

    act(() => vi.advanceTimersByTime(700));
    expect(screen.getByRole('button', { name: /accept quote/i }).className).toContain('animate-fade-out-sm');
    expect(screen.getByRole('button', { name: /decline quote/i }).className).toContain('animate-fade-out-sm');

    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByRole('button', { name: /accept quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /decline quote/i })).not.toBeInTheDocument();
  });

  it('fades out only the button that is going: Mark sent leaves, Accept and Decline arrive after it', async () => {
    const row = makeProject({ id: 1, column: 'devis', quote_status: 'draft' });
    vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({
      project: { ...row, quote_status: 'sent', column: 'waiting' },
      zoho_synced: true,
      no_op: false,
    });
    const client = renderLive(row);

    await holdButton(screen.getByRole('button', { name: /mark as sent/i }));
    await waitFor(() =>
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].quote_status).toBe('sent'),
    );

    // Still drawing the draft's one action; the new pair waits its turn.
    expect(screen.getByRole('button', { name: /mark as sent/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /accept quote/i })).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(700));
    expect(screen.getByRole('button', { name: /mark as sent/i }).className).toContain('animate-fade-out-sm');

    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accept quote/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /decline quote/i })).toBeEnabled();
  });

  it('skips the settle under reduced motion, where there is no bounce to wait for', async () => {
    const restore = withReducedMotion(true);
    try {
      const row = makeProject({ id: 1, column: 'waiting', quote_status: 'sent' });
      vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({
        project: { ...row, quote_status: 'accepted', column: 'print' },
        zoho_synced: true,
        no_op: false,
      });
      const client = renderLive(row);

      await holdButton(screen.getByRole('button', { name: /accept quote/i }));
      await waitFor(() =>
        expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].quote_status).toBe('accepted'),
      );
      expect(screen.queryByRole('button', { name: /accept quote/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /decline quote/i })).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });
});

describe('ProjectDoneAction — glyph swap in the panel footer', () => {
  // The fixture's project is quoted (`quote_id: 'EST-1'`), so it has to be
  // invoiced before the pill exists at all — see the gate tests below.
  const archivable = (over: Partial<AitoProject> = {}) =>
    makeProject({
      column: 'finish',
      move_lock: null,
      client_contacted_at: '2026-08-20T09:00:00Z',
      quote_invoiced: true,
      ...over,
    });

  it('shows a check on a Finish card with no shipping', () => {
    render(<ProjectDoneAction project={archivable({ shipping_island: null })} />);
    const done = screen.getByRole('button', { name: /mark project as done/i });
    expect(done.querySelector('.lucide-check')).toBeTruthy();
    expect(done.querySelector('.lucide-plane')).toBeFalsy();
  });

  it('shows a plane on a Finish card that has shipping', () => {
    render(<ProjectDoneAction project={archivable({ shipping_island: 'rangiroa' })} />);
    const done = screen.getByRole('button', { name: /mark project as done/i });
    expect(done.querySelector('.lucide-plane')).toBeTruthy();
    expect(done.querySelector('.lucide-check')).toBeFalsy();
  });
});

describe('ProjectDoneAction — the job has to be billed before it is closed', () => {
  // Same gate as the board card's Done icon (BoardColumn), read through the
  // one shared helper: the server refuses Finish -> Done on a quoted project
  // with no invoice, so the pill would be a button that can only fail.
  const contacted = (over: Partial<AitoProject> = {}) =>
    makeProject({ column: 'finish', move_lock: null, client_contacted_at: '2026-08-20T09:00:00Z', ...over });

  it('renders nothing on a quoted project whose quote is not invoiced', () => {
    render(<ProjectDoneAction project={contacted({ quote_invoiced: false })} />);
    expect(screen.queryByRole('button', { name: /mark project as done/i })).not.toBeInTheDocument();
  });

  it('renders the pill once the quote is invoiced', () => {
    render(<ProjectDoneAction project={contacted({ quote_invoiced: true })} />);
    expect(screen.getByRole('button', { name: /mark project as done/i })).toBeEnabled();
  });

  it('renders the pill for a project with no quote — nothing to invoice', () => {
    render(<ProjectDoneAction project={contacted({ quote_id: null, quote_invoiced: false })} />);
    expect(screen.getByRole('button', { name: /mark project as done/i })).toBeEnabled();
  });
});
