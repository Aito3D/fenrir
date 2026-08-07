/**
 * The trash grid: the view that replaced the trash modal.
 *
 * `TrashCard` owns a restore mutation per project, so every render needs the
 * query client and toast providers `render` from `../utils` supplies. The rows
 * themselves are props — AitoPage owns the ['aito-trash'] query, because it
 * also has to resolve a trashed project for the detail panel.
 */

import { describe, it, expect, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { TrashGrid } from '../../components/aito/TrashGrid';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

const card = (over: Partial<AitoProject> = {}): AitoProject => ({
  id: 1,
  description: 'Support de caméra',
  column: 'print',
  position: 0,
  status: 'deleted',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: null,
  client_email: null,
  client_is_company: null,
  client_social_network: null,
  client_social_handle: null,
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
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
  ...over,
});

const show = (props: Partial<React.ComponentProps<typeof TrashGrid>> = {}) =>
  render(
    <TrashGrid
      projects={[card()]}
      query=""
      isLoading={false}
      isError={false}
      onRetry={vi.fn()}
      onExpandCard={vi.fn()}
      {...props}
    />,
  );

describe('TrashGrid', () => {
  it('orders the most recently deleted first', () => {
    show({
      projects: [
        card({ id: 1, description: 'Oldest', updated_at: '2026-07-01T10:00:00Z' }),
        card({ id: 2, description: 'Newest', updated_at: '2026-07-20T10:00:00Z' }),
        card({ id: 3, description: 'Middle', updated_at: '2026-07-10T10:00:00Z' }),
      ],
    });

    const shown = screen.getAllByTestId('aito-card-description').map((n) => n.textContent);
    expect(shown).toEqual(['Newest', 'Middle', 'Oldest']);
  });

  it('shows when each card was deleted, which the board cards do not', () => {
    show();
    expect(screen.getByText(/^Deleted /)).toBeInTheDocument();
  });

  it('shows a spinner rather than the empty state while the rows are still loading', () => {
    // The trash is the only view with a fetch of its own, so it really does
    // render before it has data — and "nothing in the trash" would be a lie
    // half a second long.
    show({ projects: [], isLoading: true });
    expect(screen.queryByText(/nothing in the trash|corbeille est vide/i)).not.toBeInTheDocument();
  });

  it('offers a retry when the fetch failed', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    show({ projects: [], isError: true, onRetry });
    await user.click(screen.getByRole('button', { name: /retry|réessayer/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows a no-results state, not the empty state, when a search hides everything', () => {
    show({ query: 'zzzz' });
    expect(screen.getByText(/no projects match|aucun projet ne correspond/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing in the trash|corbeille est vide/i)).not.toBeInTheDocument();
  });

  it('restores the project once the 500ms hold completes', async () => {
    // The mirror of the done grid's restore assertion. A plain click must not
    // restore: this is the same hold-to-confirm gesture the archive uses, and
    // the trash is the one place where an accidental press puts a deleted
    // project back into production.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'restoreAitoProject').mockImplementation(() => new Promise(() => {}));
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      show({ projects: [card({ id: 7 })] });
      const button = screen.getByRole('button', { name: /^restore$|^restaurer$/i });

      await user.pointer({ keys: '[MouseLeft>]', target: button });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(api.restoreAitoProject).not.toHaveBeenCalled();

      // Crossing 500ms fires the mutation, but React Query's `onMutate` awaits
      // `cancelQueries` before it reaches `mutationFn` — so the request is a
      // microtask behind the hold, and the flush has to be awaited.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(api.restoreAitoProject).toHaveBeenCalledWith(7);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('has no drag handle', () => {
    // `aito.dragHandle` is 'Drag to reorder' / 'Glisser pour réordonner'.
    show();
    expect(screen.queryByRole('button', { name: /drag|glisser/i })).not.toBeInTheDocument();
  });

  it('opens the detail panel from the card body', async () => {
    const onExpandCard = vi.fn();
    const user = userEvent.setup();
    show({ projects: [card({ id: 3 })], onExpandCard });

    await user.click(screen.getByRole('button', { name: /Support de caméra/ }));
    expect(onExpandCard).toHaveBeenCalledWith(3);
  });
});
