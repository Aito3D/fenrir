import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '../utils';
import { QuoteStatusActions } from '../../components/aito/QuoteStatusActions';
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

const project = { id: 12, quote_id: 'EST-9', quote_status: 'draft' } as unknown as AitoProject;

// A project with every field the board cache needs, defaulted so a test can
// override only what it cares about. `task_pending` mirrors `task_services`
// unless a test says otherwise — a fresh fixture assumes nothing is done yet,
// which is what every caller below actually wants.
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

  it('offers only Mark as sent on a quote the client has not seen', () => {
    // Superseded by the two "offers only Mark as sent" tests below, which
    // cover null and draft individually with the current expectation
    // (Accept/Decline hidden). Kept as a loop over both values for parity
    // with the suite's other status-sweep tests.
    for (const quote_status of [null, 'draft']) {
      const { unmount } = render(<QuoteStatusActions project={{ ...project, quote_status }} />);
      expect(screen.getByRole('button', { name: /mark as sent/i })).toBeEnabled();
      expect(screen.queryByRole('button', { name: /accept quote/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /decline quote/i })).not.toBeInTheDocument();
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
    const flash = vi.mocked(flashRevert); // see Task 7 Step 7 for the required vi.mock

    const project = makeProject({ id: 1, column: 'devis', quote_status: 'sent' });
    const client = renderWithBoard(project);

    await holdButton(screen.getByRole('button', { name: /accept/i }));

    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].column).toBe('devis');
    });
    expect(flash).toHaveBeenCalledWith(1);
  });
});
