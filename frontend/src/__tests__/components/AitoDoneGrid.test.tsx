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
import { useState } from 'react';
import { render } from '../utils';
import { DoneGrid } from '../../components/aito/DoneGrid';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';
import type { DoneFilter, DoneSort } from '../../utils/aitoDoneArchive';

/** The grid is controlled — filter and sort are the page's (useAitoViewParams)
 *  — so the tests own that state here, the way the page would. */
function Grid({
  filter: initialFilter = 'all',
  sort: initialSort = 'finishedDesc',
  ...props
}: Omit<React.ComponentProps<typeof DoneGrid>, 'filter' | 'onFilter' | 'sort' | 'onSort'> & {
  filter?: DoneFilter;
  sort?: DoneSort;
}) {
  const [filter, setFilter] = useState<DoneFilter>(initialFilter);
  const [sort, setSort] = useState<DoneSort>(initialSort);
  return <DoneGrid {...props} filter={filter} onFilter={setFilter} sort={sort} onSort={setSort} />;
}

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
  client_social_network: null,
  client_social_handle: null,
  client_contact_person_id: null,
  client_contact_name: null,
  quote_id: null,
  quote_number: null,
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
  quote_accepted_at: null,
  quote_sent_at: null,
  invoice_status: null,
  invoice_balance: null,
  invoice_due_date: null,
  invoice_checked_at: null,
  quote_sync_state: 'idle',
  quote_invoiced: false,
  flag: null,
  client_contacted_at: null,
  done_at: null,
  due_date: null,
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
  print_minutes_pending: 0,
  task_steps: [],
  move_lock: null,
  shipping_island: null,
  shipping_service: null,
  shipping_first_name: null,
  shipping_last_name: null,
  shipping_phone: null,
  shipping_price: null,
  shipping_lta: null,
  shipping_service_name: null,
  tracking_configured: false,
  quote_expiry_date: null,
  retainer_paid_total: null,
  customer_credit_total: null,
  payment_link: null,
  version: 1,
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
  ...over,
});

describe('DoneGrid', () => {
  it('orders the newest completion first', () => {
    render(
      <Grid
        canUpdate
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
      <Grid
        canUpdate
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
      <Grid
        canUpdate
        projects={[card({ id: 1, description: 'Support GoPro' }), card({ id: 2, description: 'Boîtier' })]}
        query="gopro"
        onExpandCard={vi.fn()}
      />,
    );
    expect(screen.getByText('Support GoPro')).toBeInTheDocument();
    expect(screen.queryByText('Boîtier')).not.toBeInTheDocument();
  });

  it('shows the empty state when there is nothing done', () => {
    render(<Grid canUpdate projects={[]} query="" onExpandCard={vi.fn()} />);
    expect(screen.getByText(/no finished projects|aucun projet terminé/i)).toBeInTheDocument();
  });

  it('shows a no-results state, not the empty state, when a search hides everything', () => {
    render(<Grid canUpdate projects={[card()]} query="zzzz" onExpandCard={vi.fn()} />);
    expect(screen.getByText(/no projects match|aucun projet ne correspond/i)).toBeInTheDocument();
    expect(screen.queryByText(/no finished projects|aucun projet terminé/i)).not.toBeInTheDocument();
  });

  it('offers restore on a released card', () => {
    render(<Grid canUpdate projects={[card({ move_lock: null })]} query="" onExpandCard={vi.fn()} />);
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
      render(<Grid canUpdate projects={[card({ id: 4, move_lock: null })]} query="" onExpandCard={vi.fn()} />);
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
    render(<Grid canUpdate projects={[card({ move_lock: 'declined' })]} query="" onExpandCard={vi.fn()} />);
    expect(
      screen.queryByRole('button', { name: /move back to finish|renvoyer en finition/i }),
    ).not.toBeInTheDocument();
  });

  it('has no drag handle', () => {
    // `aito.dragHandle` is 'Drag to reorder' / 'Glisser pour réordonner'.
    render(<Grid canUpdate projects={[card()]} query="" onExpandCard={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /drag|glisser/i })).not.toBeInTheDocument();
  });

  it('opens the detail panel from the card body', async () => {
    const onExpandCard = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<Grid canUpdate projects={[card({ id: 7 })]} query="" onExpandCard={onExpandCard} />);
    await user.click(screen.getByRole('button', { name: /Support de caméra/ }));
    expect(onExpandCard).toHaveBeenCalledWith(7);
  });

  describe('filter and sort', () => {
    const archive = [
      card({ id: 1, description: 'Déclinée', quote_status: 'declined', move_lock: 'declined', updated_at: '2026-07-05T10:00:00Z' }),
      card({ id: 2, description: 'Expédiée', shipping_lta: 'LTA-1', updated_at: '2026-07-10T10:00:00Z' }),
      card({ id: 3, description: 'Impayée', invoice_balance: 40, updated_at: '2026-07-20T10:00:00Z' }),
    ];
    const titles = () => screen.getAllByTestId('aito-card-description').map((el) => el.textContent);

    it('shows only the declined cards once the Declined pill is pressed, and all of them again once released', async () => {
      const user = userEvent.setup();
      render(<Grid canUpdate projects={archive} query="" onExpandCard={vi.fn()} />);
      expect(titles()).toEqual(['Impayée', 'Expédiée', 'Déclinée']);
      const declined = screen.getByTestId('aito-done-filter-declined');
      await user.click(declined);
      expect(declined).toHaveAttribute('aria-pressed', 'true');
      expect(titles()).toEqual(['Déclinée']);
      await user.click(declined);
      expect(titles()).toEqual(['Impayée', 'Expédiée', 'Déclinée']);
    });

    it('one pill at a time: pressing Shipped releases Declined', async () => {
      const user = userEvent.setup();
      render(<Grid canUpdate projects={archive} query="" onExpandCard={vi.fn()} />);
      await user.click(screen.getByTestId('aito-done-filter-declined'));
      await user.click(screen.getByTestId('aito-done-filter-shipped'));
      expect(screen.getByTestId('aito-done-filter-declined')).toHaveAttribute('aria-pressed', 'false');
      expect(titles()).toEqual(['Expédiée']);
    });

    it('counts on the pills follow the search, so they read "of these"', () => {
      render(<Grid canUpdate projects={archive} query="impay" onExpandCard={vi.fn()} />);
      expect(screen.getByTestId('aito-done-filter-all')).toHaveTextContent('1');
      expect(screen.getByTestId('aito-done-filter-unpaid')).toHaveTextContent('1');
      expect(screen.getByTestId('aito-done-filter-declined')).toHaveTextContent('0');
      expect(screen.getByTestId('aito-done-filter-declined')).toBeDisabled();
    });

    it('says the filter matched nothing — not the search, not an empty archive', async () => {
      // A pill with a count of 0 is disabled, so the only way into this state
      // is a search typed AFTER the pill was pressed that leaves the filter
      // with nothing: the search still matches something, the filter does not.
      const user = userEvent.setup();
      const { rerender } = render(<Grid canUpdate projects={archive} query="" onExpandCard={vi.fn()} />);
      await user.click(screen.getByTestId('aito-done-filter-unpaid'));
      rerender(<Grid canUpdate projects={archive} query="expédiée" onExpandCard={vi.fn()} />);
      expect(screen.getByText(/match this filter|correspond à ce filtre/i)).toBeInTheDocument();
      expect(screen.queryByText(/no projects match|aucun projet ne correspond/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/no finished projects yet|aucun projet terminé pour/i)).not.toBeInTheDocument();
      // The pill stays pressed and pressable, or there would be no way to
      // release the filter.
      const unpaid = screen.getByTestId('aito-done-filter-unpaid');
      expect(unpaid).toHaveAttribute('aria-pressed', 'true');
      expect(unpaid).toBeEnabled();
      await user.click(unpaid);
      expect(titles()).toEqual(['Expédiée']);
    });

    it('the sort menu reorders the grid', async () => {
      const user = userEvent.setup();
      render(<Grid canUpdate projects={archive} query="" onExpandCard={vi.fn()} />);
      await user.selectOptions(screen.getByTestId('aito-done-sort'), 'finishedAsc');
      expect(titles()).toEqual(['Déclinée', 'Expédiée', 'Impayée']);
    });

    it('groups a date sort under month headers, newest month first, and drops them for the amount sort', async () => {
      const user = userEvent.setup();
      render(
        <Grid
          canUpdate
          projects={[
            card({ id: 1, description: 'Juin', done_at: '2026-06-03T10:00:00Z', updated_at: '2026-07-30T10:00:00Z' }),
            card({ id: 2, description: 'Juillet A', done_at: '2026-07-10T10:00:00Z' }),
            card({ id: 3, description: 'Juillet B', done_at: '2026-07-20T10:00:00Z' }),
          ]}
          query=""
          onExpandCard={vi.fn()}
        />,
      );
      const headers = screen.getAllByTestId('aito-archive-group');
      expect(headers.map((h) => h.dataset.groupKey)).toEqual(['2026-07', '2026-06']);
      expect(headers[0]).toHaveTextContent(/July 2026|juillet 2026/i);
      expect(headers[0]).toHaveTextContent('2');
      // done_at, not updated_at: the June card was touched in July.
      expect(titles()).toEqual(['Juillet B', 'Juillet A', 'Juin']);

      await user.selectOptions(screen.getByTestId('aito-done-sort'), 'amountDesc');
      expect(screen.queryByTestId('aito-archive-group')).not.toBeInTheDocument();
    });

    it('shows the win/loss figure over the pills\' set, and nothing when no quote was decided', () => {
      const { unmount } = render(<Grid canUpdate projects={archive} query="" onExpandCard={vi.fn()} />);
      // 2 accepted (shipped + unpaid) against 1 declined.
      expect(screen.getByTestId('aito-done-winloss')).toHaveTextContent('2');
      expect(screen.getByTestId('aito-done-winloss')).toHaveTextContent('1');
      expect(screen.getByTestId('aito-done-winloss')).toHaveTextContent('67 %');
      unmount();
      render(<Grid canUpdate projects={archive} query="zzzz" onExpandCard={vi.fn()} />);
      expect(screen.queryByTestId('aito-done-winloss')).not.toBeInTheDocument();
    });

    it('offers no controls over an empty archive', () => {
      render(<Grid canUpdate projects={[]} query="" onExpandCard={vi.fn()} />);
      expect(screen.queryByTestId('aito-done-sort')).not.toBeInTheDocument();
      expect(screen.queryByTestId('aito-done-filter-all')).not.toBeInTheDocument();
    });
  });
});
