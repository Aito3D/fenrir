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
import { act, fireEvent, screen } from '@testing-library/react';
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
  task_steps: [],
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

  it('does not also open the card when a real action button completes its hold', async () => {
    // AitoCardView.test.tsx only ever injects a plain <button> to prove the
    // actions wrapper's stopPropagation works. Production injects HoldButton
    // (see BoardColumn.tsx), which drives itself from pointerdown/pointerup
    // and a timer rather than a click — a different event path a plain
    // button's user.click() never exercises. This asserts the two are wired
    // together at the layer that actually does it: BoardColumn + CardView +
    // the real HoldButton, mounted together.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'setAitoQuoteStatus').mockImplementation(() => new Promise(() => {}));
    try {
      const onExpandCard = vi.fn();
      const meta = COLUMNS.find((c) => c.id === 'devis') ?? COLUMNS[0];
      render(
        <DndContext>
          <BoardColumn
            column={meta}
            projects={[card({ column: 'devis' })]}
            isDropTarget={false}
            onExpandCard={onExpandCard}
            transitionConfig={null}
            shouldAnimateIn={() => false}
          />
        </DndContext>,
      );
      const button = screen.getByRole('button', { name: /mark as sent/i });

      // Drive HoldButton through its own event contract — pointerdown, the
      // 500ms timer completing (which fires `onHold`), then the native
      // `click` a browser dispatches after the matching pointerup/mouseup on
      // the same element. `fireEvent` (not `user.pointer`) dispatches that
      // click directly rather than modelling "browsers suppress click on a
      // disabled control" — the button IS disabled by this point
      // (`markSent.isPending`), and a higher-fidelity click would be
      // suppressed by that alone, which would pass for the wrong reason and
      // hide a real regression in the propagation-stopping this test exists
      // to cover.
      fireEvent.pointerDown(button);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      fireEvent.click(button);

      expect(onExpandCard).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

describe('board card actions — mark as done', () => {
  it('offers mark-as-done on a released card in Finish', () => {
    renderColumn(card({ column: 'finish', move_lock: null }));
    expect(screen.getByRole('button', { name: /mark as done/i })).toBeEnabled();
  });

  it('does not offer mark-as-done in any other column', () => {
    for (const column of ['devis', 'waiting', 'scan', 'model', 'print'] as const) {
      const { unmount } = renderColumn(card({ column, move_lock: null }));
      expect(screen.queryByRole('button', { name: /mark as done/i })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('does not offer mark-as-done while the rules still hold the card', () => {
    // move_lock is the server's own derived value. A card the rules have not
    // released cannot leave its column, and the move endpoint would 409.
    renderColumn(card({ column: 'finish', move_lock: 'steps' }));
    expect(screen.queryByRole('button', { name: /mark as done/i })).not.toBeInTheDocument();
  });

  it('offers no mark-as-done on a placeholder card', () => {
    renderColumn(card({ id: -1, column: 'finish', move_lock: null }));
    expect(screen.queryByRole('button', { name: /mark as done/i })).not.toBeInTheDocument();
  });

  it('fires the move only once the 500ms hold completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Same reasoning as the mark-as-sent equivalent above: MSW has no handler
    // for this endpoint either, and the unmocked call bypasses to the real
    // network, which refuses fast enough to settle the mutation before the
    // assertion below runs. Held open by hand so "still pending" is actually
    // observable.
    vi.spyOn(api, 'moveAitoProject').mockImplementation(() => new Promise(() => {}));
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderColumn(card({ column: 'finish', move_lock: null }));
      const button = screen.getByRole('button', { name: /mark as done/i });

      await user.pointer({ keys: '[MouseLeft>]', target: button });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(button).toBeEnabled();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(button).toBeDisabled();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
