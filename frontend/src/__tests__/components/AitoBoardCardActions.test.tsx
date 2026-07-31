/**
 * Card footer actions, mounted through the real `BoardColumn`.
 *
 * These gates used to live inside `CardView` and were tested against it
 * directly. They now live in `SortableCard`, which owns the mutations they
 * fire — so the meaningful test is the one that mounts the column and asks
 * what a card in it actually offers. `BoardColumn` calls `useDroppable` and
 * `useSortable`, both of which throw outside a drag context, so every render
 * here wraps it in a real `DndContext`.
 */

import { describe, it, expect, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndContext } from '@dnd-kit/core';
import { render } from '../utils';
import { BoardColumn } from '../../components/aito/BoardColumn';
import { COLUMNS } from '../../components/aito/columns';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

const card = (over: Partial<AitoProject> = {}): AitoProject => ({
  id: 12,
  description: 'Support de caméra',
  column: 'devis',
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
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
  ...over,
});

function renderColumn(project: AitoProject) {
  const meta = COLUMNS.find((c) => c.id === project.column) ?? COLUMNS[0];
  return render(
    <DndContext>
      <BoardColumn
        column={meta}
        projects={[project]}
        isDropTarget={false}
        onExpandCard={vi.fn()}
        transitionConfig={null}
        shouldAnimateIn={() => false}
      />
    </DndContext>,
  );
}

describe('board card actions — mark as sent', () => {
  it('offers mark-as-sent on a card in the Quote column', () => {
    renderColumn(card({ column: 'devis' }));
    expect(screen.getByRole('button', { name: /mark as sent/i })).toBeEnabled();
  });

  it('does not offer mark-as-sent outside the Quote column', () => {
    for (const column of ['waiting', 'scan', 'model', 'print', 'finish'] as const) {
      const { unmount } = renderColumn(card({ column, move_lock: 'steps' }));
      expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('fires mark-as-sent only once the 500ms hold completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Left deliberately unresolved: MSW's default handler for this endpoint
    // is unconfigured and bypasses to the real network, which refuses fast
    // enough to settle the mutation before the assertion below runs — making
    // "still pending" indistinguishable from "already done". Same reasoning
    // as AitoPage.test.tsx's equivalent assertion: hold the promise open by
    // hand so the pending state is actually observable.
    vi.spyOn(api, 'setAitoQuoteStatus').mockImplementation(() => new Promise(() => {}));
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderColumn(card({ column: 'devis' }));
      const button = screen.getByRole('button', { name: /mark as sent/i });

      await user.pointer({ keys: '[MouseLeft>]', target: button });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(button).toBeEnabled();

      // Crosses the 500ms hold threshold, which fires `markSent.mutate` and
      // flips `isPending` — a state update from a raw timer callback, not a
      // testing-library-wrapped event, so it must be wrapped in `act` for the
      // DOM to reflect it before the assertion below runs.
      act(() => {
        vi.advanceTimersByTime(300);
      });
      // The mutation is now in flight, and HoldButton's caller disables rather
      // than unmounts precisely because the finger is still down.
      expect(button).toBeDisabled();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('offers no actions on a placeholder card the server has not acknowledged', () => {
    renderColumn(card({ id: -1, column: 'devis' }));
    expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
  });
});
