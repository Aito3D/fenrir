import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, within, cleanup, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { render } from '../utils';
import { ActivityRail } from '../../components/aito/history/ActivityRail';
import { ToastProvider } from '../../contexts/ToastContext';
import { api } from '../../api/client';
import type { AitoEvent, AitoEventPage } from '../../api/client';
import i18n from '../../i18n';

// A second render helper, used only by the depth-race regression test below,
// which needs a handle on the QueryClient to inspect BOTH depths' caches
// directly rather than through the DOM. `ActivityRail` touches no context
// besides React Query, the router, and toasts, so this is the full set —
// `AuthProvider`/`ThemeProvider`/`FullscreenProvider` from the shared `render`
// in `../utils` are not needed here.
function renderWithClient(ui: React.ReactElement) {
  // Deliberately NOT `gcTime: 0` (unlike the shared `createTestQueryClient`
  // in `../utils`, which uses it for test-to-test isolation): the bug this
  // test guards only shows up because a query the depth control has moved
  // away from stays in the cache for a while, exactly as it does in
  // production (`App.tsx`'s real QueryClient sets no `gcTime`, so it keeps
  // the default 5 minutes). A gcTime of 0 would evict the DETAIL cache the
  // instant the control moves to STORY, which would hide the very race this
  // test exists to catch.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const utils = rtlRender(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>{ui}</ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

const event = (over: Partial<AitoEvent>): AitoEvent => ({
  id: 1,
  occurred_at: '2026-07-29T12:00:00',
  occurred_until: null,
  kind: 'task.updated',
  actor_class: 'user',
  actor_name: 'paul',
  subject_type: 'task',
  subject_id: 3,
  subject_label: 'Socle',
  changes: null,
  detail: null,
  note: null,
  ...over,
});

describe('ActivityRail', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the actor and what they did', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({
      events: [event({ actor_name: 'paul', kind: 'task.added', subject_label: 'Socle' })],
      has_more: false,
    });
    render(<ActivityRail projectId={12} />);

    expect(await screen.findByText(/paul/)).toBeInTheDocument();
    expect(screen.getByText(/added a task/i)).toBeInTheDocument();
  });

  it('sits the depth control on the title\'s row, not underneath it', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    render(<ActivityRail projectId={12} />);

    // The heading and the control that decides what the heading lists share
    // one flex row. Stacking them spent a whole line of a 22rem column on a
    // 166px control, and put the two two rows apart.
    const title = await screen.findByText(/^activity$/i);
    const depthButton = screen.getByRole('button', { name: /story/i });
    const row = title.parentElement!;

    expect(row.className).toContain('flex');
    expect(row.className).toContain('justify-between');
    expect(row.contains(depthButton)).toBe(true);
  });

  it('defaults to detail depth and refetches when the depth changes', async () => {
    const spy = vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(12, expect.objectContaining({ depth: 'detail' })),
    );

    await user.click(screen.getByRole('button', { name: /story/i }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(12, expect.objectContaining({ depth: 'story' })),
    );
  });

  it('shows an inline diff for a single change', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({
      events: [
        event({ changes: [{ field: 'impression_cost', from: 4200, to: 5600 }] }),
      ],
      has_more: false,
    });
    render(<ActivityRail projectId={12} />);

    expect(await screen.findByText(/4200/)).toBeInTheDocument();
    expect(screen.getByText(/5600/)).toBeInTheDocument();
  });

  it('collapses several changes behind a count', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({
      events: [
        event({
          changes: [
            { field: 'title', from: 'Socle', to: 'Socle v2' },
            { field: 'impression_cost', from: 4200, to: 5600 },
            { field: 'impression_quantity', from: 1, to: 12 },
          ],
        }),
      ],
      has_more: false,
    });
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    const toggle = await screen.findByRole('button', { name: /3 changes/i });
    expect(screen.queryByText(/impression_quantity|quantity/i)).not.toBeInTheDocument();

    await user.click(toggle);
    // Match the expanded change row itself ("1 → 12"), not a bare /12/: on a
    // UTC runner the fixture's noon timestamp renders as "12:00:00 PM" too,
    // and getByText throws on multiple matches (CI-only failure).
    await waitFor(() => expect(screen.getByText(/1\s*→\s*12/)).toBeInTheDocument());
  });

  it('submits a note and clears the box', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    const add = vi.spyOn(api, 'addAitoNote').mockResolvedValue(event({ kind: 'note.added', note: 'Called client' }));
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    const box = await screen.findByPlaceholderText(/add a note/i);
    await user.type(box, 'Called client');
    await user.click(screen.getByRole('button', { name: /add note/i }));

    await waitFor(() => expect(add).toHaveBeenCalledWith(12, 'Called client'));
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('shows the note and clears the box before the POST resolves', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    let release: (value: AitoEvent) => void = () => {};
    vi.spyOn(api, 'addAitoNote').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    const box = await screen.findByPlaceholderText(/add a note/i);
    await user.type(box, 'called the client');
    await user.click(screen.getByRole('button', { name: /add note/i }));

    expect(screen.getByText('called the client')).toBeInTheDocument();
    expect(box).toHaveValue('');

    release(event({ id: 99, kind: 'note.added', note: 'called the client' }));
  });

  it('caps the note input at the server\'s 2000-character limit, and still accepts exactly 2000', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    const longNote = 'a'.repeat(2000);
    const add = vi.spyOn(api, 'addAitoNote').mockResolvedValue(event({ kind: 'note.added', note: longNote }));
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    const box = await screen.findByPlaceholderText(/add a note/i);
    expect(box).toHaveAttribute('maxLength', '2000');

    // fireEvent bypasses maxLength enforcement (unlike a real paste/keystroke
    // via userEvent), so this exercises the submit path with a note that is
    // exactly at the server's cap rather than the DOM's truncation of it.
    fireEvent.change(box, { target: { value: longNote } });
    await user.click(screen.getByRole('button', { name: /add note/i }));

    await waitFor(() => expect(add).toHaveBeenCalledWith(12, longNote));
  });

  it('removes the note and restores the text when the POST fails', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    vi.spyOn(api, 'addAitoNote').mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    const box = await screen.findByPlaceholderText(/add a note/i);
    await user.type(box, 'called the client');
    await user.click(screen.getByRole('button', { name: /add note/i }));

    await waitFor(() => expect(screen.queryByText('called the client')).not.toBeInTheDocument());
    // The text comes back so the user does not have to retype it.
    expect(box).toHaveValue('called the client');
  });

  it('rolls back a failed note from the depth it was WRITTEN to, even if the depth control moved on while the POST was in flight', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    let reject: (error: unknown) => void = () => {};
    vi.spyOn(api, 'addAitoNote').mockImplementation(
      () => new Promise((_resolve, rej) => { reject = rej; }),
    );
    const user = userEvent.setup();
    const { queryClient } = renderWithClient(<ActivityRail projectId={12} />);

    // Default depth is 'detail' (confirmed by the sibling test above).
    await waitFor(() => expect(queryClient.getQueryData(['aito-events', 12, 'detail'])).toBeTruthy());

    const box = await screen.findByPlaceholderText(/add a note/i);
    await user.type(box, 'called the client');
    await user.click(screen.getByRole('button', { name: /add note/i }));

    // The optimistic row lands in the DETAIL cache — the depth in effect
    // when the mutation was fired.
    await waitFor(() => {
      const detailCache = queryClient.getQueryData<{ pages: AitoEventPage[] }>(['aito-events', 12, 'detail']);
      expect(detailCache?.pages[0]?.events.some((e) => e.note === 'called the client')).toBe(true);
    });

    // Move the depth control while the POST is still pending. This is the
    // race: query-core refreshes the pending mutation's `onError` closure on
    // every re-render, so without the fix the rollback below would target
    // the STORY cache instead of the one the placeholder actually lives in.
    await user.click(screen.getByRole('button', { name: /story/i }));
    await waitFor(() => expect(queryClient.getQueryData(['aito-events', 12, 'story'])).toBeTruthy());
    const storyCacheBeforeFailure = queryClient.getQueryData<{ pages: AitoEventPage[] }>(['aito-events', 12, 'story']);
    expect(storyCacheBeforeFailure?.pages[0]?.events ?? []).toEqual([]);

    // Now fail the POST.
    reject(new Error('nope'));
    await waitFor(() => expect(box).toHaveValue('called the client'));

    // The placeholder must be gone from the cache it was written to (detail)...
    await waitFor(() => {
      const detailCache = queryClient.getQueryData<{ pages: AitoEventPage[] }>(['aito-events', 12, 'detail']);
      expect(detailCache?.pages[0]?.events.some((e) => e.note === 'called the client')).toBe(false);
    });
    // ...and the cache the control had moved to (story) must never have been
    // touched by the rollback — it stays exactly as the server returned it.
    const storyCacheAfterFailure = queryClient.getQueryData<{ pages: AitoEventPage[] }>(['aito-events', 12, 'story']);
    expect(storyCacheAfterFailure?.pages[0]?.events ?? []).toEqual([]);

    // Switching the rail back to Detail must not resurrect the failed note
    // as a real timeline entry — this is the user-visible face of the bug.
    await user.click(screen.getByRole('button', { name: /detail/i }));
    expect(screen.queryByText('called the client')).not.toBeInTheDocument();
  });

  it('renders the verbatim Books text for an unrecognised zoho.comment', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({
      events: [
        event({
          kind: 'zoho.comment',
          actor_class: 'system',
          actor_name: null,
          subject_type: null,
          subject_id: null,
          subject_label: null,
          detail: { text: 'La mise à jour du champ set expiration est exécutée' },
        }),
      ],
      has_more: false,
    });
    render(<ActivityRail projectId={12} />);

    expect(await screen.findByText(/set expiration est exécutée/)).toBeInTheDocument();
  });

  it('renders the reason for a sync.failed event', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({
      events: [
        event({
          kind: 'sync.failed',
          actor_class: 'system',
          actor_name: null,
          subject_type: null,
          subject_id: null,
          subject_label: null,
          detail: { error: 'Zoho rejected the request: duplicate reference number', failures: 3 },
        }),
      ],
      has_more: false,
    });
    render(<ActivityRail projectId={12} />);

    expect(await screen.findByText(/duplicate reference number/)).toBeInTheDocument();
  });

  it('says so when there is nothing to show', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    render(<ActivityRail projectId={12} />);
    expect(await screen.findByText(/nothing recorded yet/i)).toBeInTheDocument();
  });

  it('shows a load-failed message with a working retry, not an empty timeline, when the fetch fails', async () => {
    const spy = vi.spyOn(api, 'getAitoEvents')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ events: [event({})], has_more: false });
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    expect(await screen.findByText(/could not load the board/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing recorded yet/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/paul/)).toBeInTheDocument();
    expect(screen.queryByText(/could not load the board/i)).not.toBeInTheDocument();
  });

  it('offers load-more only when the server says there is more', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [event({})], has_more: false });
    render(<ActivityRail projectId={12} />);
    await screen.findByText(/paul/);
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('pages with the (id, occurredAt) cursor pair taken from the last event of the page', async () => {
    const spy = vi.spyOn(api, 'getAitoEvents');
    spy.mockResolvedValueOnce({
      events: [
        event({ id: 99, occurred_at: '2026-07-29T12:00:00', actor_name: 'first-event' }),
        event({ id: 5, occurred_at: '2020-01-01T00:00:00', actor_name: 'oldest-event' }),
      ],
      has_more: true,
    });
    spy.mockResolvedValueOnce({
      events: [event({ id: 4, occurred_at: '2019-12-31T00:00:00', actor_name: 'second-page-event' })],
      has_more: false,
    });
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    await screen.findByText(/oldest-event/);

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    // The cursor must be the pair from the LAST event of the first page (id 5),
    // not the first event's (id 99), and not a bare id.
    expect(spy).toHaveBeenNthCalledWith(
      2,
      12,
      expect.objectContaining({
        cursor: { id: 5, occurredAt: '2020-01-01T00:00:00' },
      }),
    );
  });

  it('keeps the already-rendered timeline on screen, and Load more retryable, when fetchNextPage fails', async () => {
    const spy = vi.spyOn(api, 'getAitoEvents');
    spy.mockResolvedValueOnce({
      events: [event({ id: 99, actor_name: 'first-event' })],
      has_more: true,
    });
    spy.mockRejectedValueOnce(new Error('network down'));
    spy.mockResolvedValueOnce({
      events: [event({ id: 4, occurred_at: '2019-12-31T00:00:00', actor_name: 'second-page-event' })],
      has_more: false,
    });
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    await screen.findByText(/first-event/);

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    // `useInfiniteQuery`'s `isError` covers a failed `fetchNextPage` too, but
    // `data` (and so the already-rendered page) is retained — the timeline
    // must stay up rather than being replaced by the load-failed panel.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/first-event/)).toBeInTheDocument();
    expect(screen.queryByText(/could not load the board/i)).not.toBeInTheDocument();

    // The failed page is retryable from the same Load-more button.
    const loadMore = screen.getByRole('button', { name: 'Load more' });
    expect(loadMore).not.toBeDisabled();
    await user.click(loadMore);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/second-page-event/)).toBeInTheDocument();
    expect(screen.getByText(/first-event/)).toBeInTheDocument();
  });

  it('appends the next page instead of replacing the first one', async () => {
    const spy = vi.spyOn(api, 'getAitoEvents');
    spy.mockResolvedValueOnce({
      events: [
        event({ id: 99, occurred_at: '2026-07-29T12:00:00', actor_name: 'first-event' }),
        event({ id: 5, occurred_at: '2020-01-01T00:00:00', actor_name: 'oldest-event' }),
      ],
      has_more: true,
    });
    spy.mockResolvedValueOnce({
      events: [event({ id: 4, occurred_at: '2019-12-31T00:00:00', actor_name: 'second-page-event' })],
      has_more: false,
    });
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    await screen.findByText(/oldest-event/);

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByText(/second-page-event/);
    expect(screen.getByText(/first-event/)).toBeInTheDocument();
    expect(screen.getByText(/oldest-event/)).toBeInTheDocument();
  });

  // ElapsedGutter (EventItem.tsx) only renders at Story depth, between an
  // event and the next-older one. `elapsedBucket` (eventKinds.ts) buckets the
  // gap into null (<60s, no row), minute, hour, or day — largest whole unit
  // that fits, rounded. These tests pin those boundaries directly, plus the
  // deliberately-positive sign documented above ElapsedGutter: the list runs
  // newest-first, so the gutter sits under the NEWER of the pair and reads
  // "in N days" measured forward from the older entry, not "N days ago".
  //
  // The expected text is built from `Intl.RelativeTimeFormat` with a value
  // and unit chosen by hand from reading `elapsedBucket`'s thresholds — never
  // by calling `elapsedBucket` itself — so a sign flip or threshold change in
  // production actually disagrees with what the test expects, rather than
  // both sides drifting together. The language passed to it is whatever this
  // suite's `i18n.language` already is (matching the rest of this file's
  // locale-sensitive assertions, e.g. the depth/timestamp tests above) rather
  // than a hardcoded 'en', so the test does not depend on the runner's
  // default locale either. Runs of Unicode whitespace are matched loosely for
  // the same reason `AitoShippingFields.test.tsx`'s French-grouping test
  // does: some locales separate the parts with a narrow no-break space.
  describe('elapsed gutter (Story depth only)', () => {
    function relativePattern(value: number, unit: Intl.RelativeTimeFormatUnit): RegExp {
      const formatted = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'always' }).format(value, unit);
      const escaped = formatted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/gu, '\\s+');
      return new RegExp(escaped);
    }

    // occurred_at strings match the fixture's own format (no 'Z' — parseUTCDate
    // appends one), built from a fixed UTC instant so the gap between the two
    // events is an exact number of seconds rather than something derived from
    // wall-clock month/day arithmetic.
    const isoNoZ = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, '');

    const BASE_EPOCH = Date.parse('2026-07-29T12:00:00Z') / 1000;

    async function renderAtStoryDepth(gapSeconds: number) {
      // Some tests below call this twice (once on each side of a boundary)
      // to compare the two renders. `render()` mounts into a fresh container
      // appended to `document.body` without unmounting a prior one, so
      // without this, a second call would leave two "Story" buttons live at
      // once and every `screen`-scoped query would find both.
      cleanup();
      const newer = event({ id: 2, occurred_at: isoNoZ(BASE_EPOCH), actor_name: 'newer-row' });
      const older = event({ id: 1, occurred_at: isoNoZ(BASE_EPOCH - gapSeconds), actor_name: 'older-row' });
      const spy = vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [newer, older], has_more: false });
      const user = userEvent.setup();
      const { container } = render(<ActivityRail projectId={12} />);

      await waitFor(() => expect(spy).toHaveBeenCalledWith(12, expect.objectContaining({ depth: 'detail' })));
      await user.click(screen.getByRole('button', { name: /story/i }));
      await waitFor(() => expect(spy).toHaveBeenCalledWith(12, expect.objectContaining({ depth: 'story' })));
      await screen.findByText(/newer-row/);
      await screen.findByText(/older-row/);

      // The first <li> is the newer event (the list runs newest-first, and
      // the mock hands the events back in that order) — the gutter for the
      // gap to the older one renders inside IT, not the older row's own <li>.
      const rows = container.querySelectorAll('li');
      return rows[0] as HTMLElement;
    }

    it('renders "in 3 days" — a POSITIVE value — for two Story-depth events 3 days apart, not "3 days ago"', async () => {
      const newerRow = await renderAtStoryDepth(3 * 86_400);
      // A negative value here (a sign-flip regression) would format as "3
      // days ago" in English and the equivalent past-tense phrasing in any
      // other locale — this pattern, built from a hardcoded POSITIVE 3,
      // would then no longer match what actually rendered.
      expect(within(newerRow).getByText(relativePattern(3, 'day'))).toBeInTheDocument();
    });

    it('renders no gutter at all when the gap is under a minute (elapsedBucket returns null)', async () => {
      const newerRow = await renderAtStoryDepth(30);
      // No note, no detail, no changes on this fixture, so the ONLY <p> a
      // rendered row can have is its own timestamp line — a second <p> would
      // be the gutter, which must not exist when the bucket short-circuits.
      expect(newerRow.querySelectorAll('p')).toHaveLength(1);
    });

    it('pins the null/minute boundary at exactly 60 seconds', async () => {
      const justUnder = await renderAtStoryDepth(59);
      expect(justUnder.querySelectorAll('p')).toHaveLength(1);

      const atBoundary = await renderAtStoryDepth(60);
      expect(within(atBoundary).getByText(relativePattern(1, 'minute'))).toBeInTheDocument();
    });

    it('pins the minute/hour boundary at exactly 3600 seconds', async () => {
      // Just under the hour boundary is still the minute bucket —
      // round(3599 / 60) = 60, i.e. "in 60 minutes", not "in 1 hour".
      const justUnder = await renderAtStoryDepth(3_599);
      expect(within(justUnder).getByText(relativePattern(60, 'minute'))).toBeInTheDocument();

      const atBoundary = await renderAtStoryDepth(3_600);
      expect(within(atBoundary).getByText(relativePattern(1, 'hour'))).toBeInTheDocument();
    });

    it('pins the hour/day boundary at exactly 86400 seconds', async () => {
      // Just under the day boundary is still the hour bucket —
      // round(86399 / 3600) = 24, i.e. "in 24 hours", not "in 1 day".
      const justUnder = await renderAtStoryDepth(86_399);
      expect(within(justUnder).getByText(relativePattern(24, 'hour'))).toBeInTheDocument();

      const atBoundary = await renderAtStoryDepth(86_400);
      expect(within(atBoundary).getByText(relativePattern(1, 'day'))).toBeInTheDocument();
    });
  });
});
