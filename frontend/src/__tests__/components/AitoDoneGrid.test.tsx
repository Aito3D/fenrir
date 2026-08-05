/**
 * The done grid: the archive view that replaced the Done column.
 *
 * `DoneCard` owns a `useColumnMoveMutation` per project, so every render needs
 * the query client and toast providers that `render` from `../utils` supplies.
 * No `DndContext` — nothing in the grid drags.
 */

import { describe, it, expect, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { DoneGrid } from '../../components/aito/DoneGrid';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

const card = (over: Partial<AitoProject> = {}): AitoProject => ({
  id: 1,
  description: 'Support de caméra',
  column: 'done',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: null,
  client_email: null,
  client_is_company: null,
  quote_id: null,
  quote_number: null,
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
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
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
  ...over,
});

describe('DoneGrid', () => {
  it('orders the newest completion first', () => {
    render(
      <DoneGrid
        projects={[
          card({ id: 1, description: 'Oldest', updated_at: '2026-07-01T10:00:00Z' }),
          card({ id: 2, description: 'Newest', updated_at: '2026-07-20T10:00:00Z' }),
          card({ id: 3, description: 'Middle', updated_at: '2026-07-10T10:00:00Z' }),
        ]}
        query=""
        onExpandCard={vi.fn()}
      />,
    );
    const rendered = screen.getAllByText(/Oldest|Newest|Middle/).map((el) => el.textContent);
    expect(rendered).toEqual(['Newest', 'Middle', 'Oldest']);
  });

  it('treats a bare timestamp and a Z-suffixed one as the same instant', () => {
    // The board's rows are inconsistently suffixed, and `parseUTCDate` appends
    // the missing 'Z' — so these two texts denote the SAME moment and the id
    // tie-break decides, newest id first.
    //
    // The suffix is the ONLY thing that differs, which is what makes this test
    // falsifying. Any fixture whose dates differ elsewhere sorts identically
    // under a lexical string compare and under a real date compare, so it
    // would pass against exactly the bug it claims to catch. Here a string
    // compare ranks 'Z' above the bare string and yields ['First', 'Second'].
    render(
      <DoneGrid
        projects={[
          card({ id: 1, description: 'First', updated_at: '2026-07-20T10:00:00Z' }),
          card({ id: 2, description: 'Second', updated_at: '2026-07-20T10:00:00' }),
        ]}
        query=""
        onExpandCard={vi.fn()}
      />,
    );
    const rendered = screen.getAllByText(/First|Second/).map((el) => el.textContent);
    expect(rendered).toEqual(['Second', 'First']);
  });

  it('filters on the query', () => {
    render(
      <DoneGrid
        projects={[card({ id: 1, description: 'Support GoPro' }), card({ id: 2, description: 'Boîtier' })]}
        query="gopro"
        onExpandCard={vi.fn()}
      />,
    );
    expect(screen.getByText('Support GoPro')).toBeInTheDocument();
    expect(screen.queryByText('Boîtier')).not.toBeInTheDocument();
  });

  it('shows the empty state when there is nothing done', () => {
    render(<DoneGrid projects={[]} query="" onExpandCard={vi.fn()} />);
    expect(screen.getByText(/no finished projects|aucun projet terminé/i)).toBeInTheDocument();
  });

  it('shows a no-results state, not the empty state, when a search hides everything', () => {
    render(<DoneGrid projects={[card()]} query="zzzz" onExpandCard={vi.fn()} />);
    expect(screen.getByText(/no projects match|aucun projet ne correspond/i)).toBeInTheDocument();
    expect(screen.queryByText(/no finished projects|aucun projet terminé/i)).not.toBeInTheDocument();
  });

  it('offers restore on a released card', () => {
    render(<DoneGrid projects={[card({ move_lock: null })]} query="" onExpandCard={vi.fn()} />);
    expect(screen.getByRole('button', { name: /move back to finish|renvoyer en finition/i })).toBeEnabled();
  });

  it('sends the card back to Finish once the 500ms hold completes', async () => {
    // The mirror of AitoBoardCardActions' mark-done assertion, and it exists
    // for the same reason: the destination column literal in DoneGrid.tsx is
    // otherwise unasserted anywhere, so swapping it for 'done' would re-archive
    // the card the user just asked to restore — with a fully green suite.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Left deliberately unresolved: MSW has no handler for this endpoint, and
    // the unmocked call bypasses to the real network, which refuses fast
    // enough to settle the mutation before the assertions below run.
    vi.spyOn(api, 'moveAitoProject').mockImplementation(() => new Promise(() => {}));
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<DoneGrid projects={[card({ id: 4, move_lock: null })]} query="" onExpandCard={vi.fn()} />);
      const button = screen.getByRole('button', { name: /move back to finish|renvoyer en finition/i });

      await user.pointer({ keys: '[MouseLeft>]', target: button });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(api.moveAitoProject).not.toHaveBeenCalled();

      // Crossing 500ms fires `restore.mutate`, but React Query's `onMutate`
      // awaits `cancelQueries` before it reaches `mutationFn` — so the request
      // is a microtask behind the hold, and the flush has to be awaited.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(api.moveAitoProject).toHaveBeenCalledWith(4, { column: 'finish', position: 0 });
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('offers no restore on a declined card the rules pin to Done', () => {
    render(<DoneGrid projects={[card({ move_lock: 'declined' })]} query="" onExpandCard={vi.fn()} />);
    expect(
      screen.queryByRole('button', { name: /move back to finish|renvoyer en finition/i }),
    ).not.toBeInTheDocument();
  });

  it('has no drag handle', () => {
    // `aito.dragHandle` is 'Drag to reorder' / 'Glisser pour réordonner'.
    render(<DoneGrid projects={[card()]} query="" onExpandCard={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /drag|glisser/i })).not.toBeInTheDocument();
  });

  it('opens the detail panel from the card body', async () => {
    const onExpandCard = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<DoneGrid projects={[card({ id: 7 })]} query="" onExpandCard={onExpandCard} />);
    await user.click(screen.getByRole('button', { name: /Support de caméra/ }));
    expect(onExpandCard).toHaveBeenCalledWith(7);
  });
});
