/**
 * The Finish card's action slot after a "mark contacted" hold.
 *
 * The contact write is optimistic, so `client_contacted_at` lands on the
 * tick the hold fires — and unlike mark-sent on the Quote card nothing flies
 * afterwards: the card stays in Finish and the slot simply advances Phone ->
 * (invoice) -> Done. Rendered straight from the cache, that unmounted the
 * Phone button on the very frame its completion bounce started. The slot now
 * holds the Phone button through HoldButton's 700ms `completed` window,
 * fades it out over 150ms, and only then mounts the next control, which
 * rises in. See useHoldSettle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { DndContext } from '@dnd-kit/core';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { BoardColumn } from '../../components/aito/BoardColumn';
import { COLUMNS } from '../../components/aito/columns';
import { AuthProvider } from '../../contexts/AuthContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';
import { makeProject } from '../fixtures/aitoProject';

const FINISH = COLUMNS.find((column) => column.id === 'finish')!;

/** The column fed from the LIVE cache, the way AitoPage feeds it, so the
 *  optimistic write re-renders the card with the contact recorded. */
function LiveColumn() {
  const { data } = useQuery<AitoProject[]>({
    queryKey: ['aito-projects'],
    queryFn: () => Promise.reject(new Error('seeded, never fetched')),
    enabled: false,
  });
  return (
    <DndContext>
      <BoardColumn
        column={FINISH}
        projects={(data ?? []).filter((project) => project.column === 'finish')}
        isDropTarget={false}
        onExpandCard={vi.fn()}
        transitionConfig={null}
        shouldAnimateIn={() => false}
      />
    </DndContext>
  );
}

function renderLive(project: AitoProject) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['aito-projects'], [project]);
  rtlRender(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <LiveColumn />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
  return client;
}

/** A Finish card with no quote: once the client is told, the slot goes
 *  straight to Done (canMarkDone — nothing to invoice). */
const untold = () =>
  makeProject({ id: 1, column: 'finish', quote_id: null, quote_invoiced: false, client_contacted_at: null, move_lock: null });

async function holdButton(button: HTMLElement) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.pointer({ keys: '[MouseLeft>]', target: button });
  vi.advanceTimersByTime(600);
}

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

describe('BoardColumn — the contact hold settles before the slot advances', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __resetBoardSync();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the Phone button through the bounce, fades it, then rises Done into the slot', async () => {
    const row = untold();
    vi.spyOn(api, 'setAitoProjectContacted').mockResolvedValue({ ...row, client_contacted_at: '2026-09-18T10:00:00Z' });
    const client = renderLive(row);

    await holdButton(screen.getByRole('button', { name: 'Mark client as contacted' }));
    await waitFor(() =>
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].client_contacted_at).not.toBeNull(),
    );

    // The cache says contacted; the slot still says Phone, inert, and Done
    // has not been let in yet.
    const phone = screen.getByRole('button', { name: 'Mark client as contacted' });
    expect(phone).toBeDisabled();
    expect(phone.className).not.toContain('animate-fade-out-sm');
    expect(screen.queryByRole('button', { name: 'Mark project as done' })).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(700));
    expect(screen.getByRole('button', { name: 'Mark client as contacted' }).className).toContain('animate-fade-out-sm');

    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByRole('button', { name: 'Mark client as contacted' })).not.toBeInTheDocument();
    const done = screen.getByRole('button', { name: 'Mark project as done' });
    expect(done).toBeEnabled();
    // The arriving control rides a wrapper that only becomes a box to carry
    // the rise — see `arrivalCls`.
    expect(done.closest('.animate-rise-sm')).not.toBeNull();
  });

  it('does not wrap the slot in a rising box on the card\'s own first paint', () => {
    renderLive(makeProject({ id: 1, column: 'finish', quote_id: null, client_contacted_at: '2026-09-18T10:00:00Z', move_lock: null }));
    const done = screen.getByRole('button', { name: 'Mark project as done' });
    expect(done.closest('.animate-rise-sm')).toBeNull();
  });

  it('advances the slot on the tick under reduced motion, where there is no bounce to wait for', async () => {
    const restore = withReducedMotion(true);
    try {
      const row = untold();
      vi.spyOn(api, 'setAitoProjectContacted').mockResolvedValue({ ...row, client_contacted_at: '2026-09-18T10:00:00Z' });
      const client = renderLive(row);

      await holdButton(screen.getByRole('button', { name: 'Mark client as contacted' }));
      await waitFor(() =>
        expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].client_contacted_at).not.toBeNull(),
      );
      expect(screen.queryByRole('button', { name: 'Mark client as contacted' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Mark project as done' })).toBeEnabled();
    } finally {
      restore();
    }
  });
});
