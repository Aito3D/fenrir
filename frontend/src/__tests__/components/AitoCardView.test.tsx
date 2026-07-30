import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { CardView } from '../../components/aito/CardView';
import { QUOTE_STATUS_NEUTRAL } from '../../components/aito/quoteStatus';
import type { AitoProject } from '../../api/client';

const project: AitoProject = {
  id: 12,
  description: 'Support de caméra',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: '+689-87123456',
  client_email: 'hi@acme.pf',
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
  move_lock: null,
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

describe('CardView', () => {
  it('puts the client name in the header and never renders phone or email', () => {
    render(<CardView project={project} onExpand={vi.fn()} />);
    expect(screen.getByText('ACME SARL')).toBeInTheDocument();
    expect(screen.queryByText(/87123456/)).not.toBeInTheDocument();
    expect(screen.queryByText(/hi@acme\.pf/)).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('falls back to the no-client label when the card has no client', () => {
    render(<CardView project={{ ...project, client_name: null }} onExpand={vi.fn()} />);
    expect(screen.getByText(/no client|sans client/i)).toBeInTheDocument();
  });

  it('opens from the body, and the body is reachable by keyboard', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(<CardView project={project} onExpand={onExpand} />);
    const body = screen.getByRole('button', { name: /Support de caméra/ });
    await user.click(body);
    expect(onExpand).toHaveBeenCalledTimes(1);

    body.focus();
    await user.keyboard('{Enter}');
    expect(onExpand).toHaveBeenCalledTimes(2);
  });

  it('does not open when the header or the grip is clicked', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(
      <CardView
        project={project}
        onExpand={onExpand}
        dragHandleRef={vi.fn()}
        dragHandleProps={{}}
      />,
    );
    await user.click(screen.getByText('ACME SARL'));
    await user.click(screen.getByRole('button', { name: /drag|glisser/i }));
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('renders a static grip with no button in the drag overlay', () => {
    render(<CardView project={project} overlay />);
    expect(screen.queryByRole('button', { name: /drag|glisser/i })).not.toBeInTheDocument();
  });

  it('shows a badge per enabled service, the task count and the total', async () => {
    render(
      <CardView
        project={{ ...project, task_count: 2, tasks_total: 20200, task_services: ['modelisation', 'impression'] }}
        onExpand={vi.fn()}
      />,
    );
    expect(await screen.findByText('Modeling')).toBeInTheDocument();
    expect(screen.getByText('Printing')).toBeInTheDocument();
    expect(screen.queryByText('Scan')).not.toBeInTheDocument();
    expect(screen.getByText(/2 tasks|2 tâches/i)).toBeInTheDocument();
    // Matched on the digits, not the whole formatted string: the currency and
    // separators come from formatMoney and the settings stub, and pinning them
    // here would make this a test of formatMoney.
    expect(screen.getByText(/20[,\s.]?200/)).toBeInTheDocument();
  });

  it('renders no summary row at all for a project with no tasks', () => {
    render(
      <CardView
        project={{ ...project, task_count: 0, tasks_total: 0, task_services: [] }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.queryByText(/0 tasks|0 tâches/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Scan')).not.toBeInTheDocument();
    expect(screen.queryByText('Printing')).not.toBeInTheDocument();
  });

  it('shows the same summary in the drag overlay, which has no body button', async () => {
    // CardView inserts the summary at two points — inside the body <button>
    // when `onExpand` is passed, and inside a plain <div> for the DragOverlay
    // clone, which gets no `onExpand` at all. Every other summary
    // test above passes `onExpand`, so without this one the overlay's
    // insertion point could be dropped and the suite would stay green while a
    // dragged card visibly lost its badges, count and total.
    render(
      <CardView
        project={{ ...project, task_count: 2, tasks_total: 20200, task_services: ['modelisation', 'impression'] }}
        overlay
      />,
    );
    expect(await screen.findByText('Modeling')).toBeInTheDocument();
    expect(screen.getByText('Printing')).toBeInTheDocument();
    expect(screen.getByText(/2 tasks|2 tâches/i)).toBeInTheDocument();
    expect(screen.getByText(/20[,\s.]?200/)).toBeInTheDocument();
    // The overlay clone really is the no-onExpand branch: nothing here is a
    // button, so this cannot have been the body-button path in disguise.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('keeps the summary inside the body button, so it opens the panel', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(
      <CardView
        project={{ ...project, task_count: 1, tasks_total: 4000, task_services: ['scan'] }}
        onExpand={onExpand}
      />,
    );
    await user.click(await screen.findByText('Scan'));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('shows the quote number in the footer for an imported card', () => {
    render(
      <CardView
        project={{ ...project, quote_number: 'DEV26-2462', quote_id: 'e2' }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.getByText('DEV26-2462')).toBeInTheDocument();
    // The chip is not a link — the card body is a <button> and the footer
    // already carries hold-to-delete.
    expect(document.querySelector('a[href*="zoho"]')).toBeNull();
  });

  it('shows no quote chip on a manually created card', () => {
    render(<CardView project={project} onExpand={vi.fn()} />);
    expect(screen.queryByText(/DEV26-/)).not.toBeInTheDocument();
  });

  it('shows a placeholder chip while the quote is being created', () => {
    render(
      <CardView
        project={{ ...project, quote_number: null, quote_sync_state: 'pending' }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.getByText(/devis…|quote…/i)).toBeInTheDocument();
  });

  it('shows no pending placeholder once the quote exists', () => {
    // 'pending' also covers an EDIT to an already-imported card mid-push —
    // the card must keep showing the real quote number, not fall back to
    // the "quote is coming" placeholder meant for brand-new cards.
    render(
      <CardView
        project={{ ...project, quote_number: 'DEV26-2462', quote_sync_state: 'pending' }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.getByText('DEV26-2462')).toBeInTheDocument();
    expect(screen.queryByText(/devis en cours|quote…/i)).not.toBeInTheDocument();
  });

  it('shows the error state when the push failed', () => {
    render(
      <CardView
        project={{ ...project, quote_number: 'DEV26-2471', quote_sync_state: 'error', quote_sync_error: 'boom' }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/sync/i)).toBeInTheDocument();
  });

  it('shows a lock indicator once the quote is invoiced', () => {
    render(
      <CardView
        project={{ ...project, quote_number: 'DEV26-2471', quote_sync_state: 'locked' }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.getByText('DEV26-2471')).toBeInTheDocument();
    expect(screen.getByLabelText(/facturé|invoiced|locked/i)).toBeInTheDocument();
  });

  it('shows neither error nor lock indicator when the sync state is idle', () => {
    render(
      <CardView
        project={{ ...project, quote_number: 'DEV26-2462', quote_sync_state: 'idle' }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/sync|facturé|invoiced|locked/i)).not.toBeInTheDocument();
  });

  it('shows the quote status next to the quote number', () => {
    render(
      <CardView
        project={{ ...project, quote_number: 'DEV26-2462', quote_status: 'accepted' }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.getByText('DEV26-2462')).toBeInTheDocument();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
  });

  it('renders an unrecognised status verbatim rather than dropping it', () => {
    // Zoho can add statuses. A card that silently drops one is worse than a
    // card showing a word we have no translation for — same fallback rule
    // ServiceBadges uses for an unknown service id.
    render(
      <CardView
        project={{ ...project, quote_number: 'DEV26-2462', quote_status: 'partially_invoiced' }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.getByText('partially_invoiced')).toBeInTheDocument();
  });

  it('renders a status named after an Object.prototype member verbatim, in the neutral style', () => {
    // `quote_status` is a free string up to 30 chars accepted from the client
    // (POST /aito/), so an unguarded object-literal lookup — `map[status]` —
    // would resolve 'toString' to Object.prototype.toString instead of
    // falling through to the neutral default. Same fallback path as any
    // other unrecognised status; this pins that the guard is actually there.
    render(
      <CardView
        project={{ ...project, quote_number: 'DEV26-2462', quote_status: 'toString' }}
        onExpand={vi.fn()}
      />,
    );
    const chip = screen.getByText('toString');
    expect(chip).toBeInTheDocument();
    for (const cls of QUOTE_STATUS_NEUTRAL.split(' ')) {
      expect(chip.className).toContain(cls);
    }
  });

  it('shows no status chip on a card with no quote status', () => {
    render(
      <CardView
        project={{ ...project, quote_number: 'DEV26-2462', quote_status: null }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.getByText('DEV26-2462')).toBeInTheDocument();
    expect(screen.queryByText('Accepted')).not.toBeInTheDocument();
  });

  it('marks a quote-locked card with a lock and says why', () => {
    render(<CardView project={{ ...project, move_lock: 'quote' }} onExpand={vi.fn()} />);
    expect(screen.getByTitle('Locked to Quote until the quote is accepted')).toBeInTheDocument();
  });

  it('says a waiting card is stalled on the client, not on us', () => {
    render(<CardView project={{ ...project, move_lock: 'waiting' }} onExpand={vi.fn()} />);
    expect(screen.getByTitle('Waiting on the client to answer the quote')).toBeInTheDocument();
  });

  it('names the step rule on a card the checkboxes are driving', () => {
    render(<CardView project={{ ...project, move_lock: 'steps' }} onExpand={vi.fn()} />);
    expect(screen.getByTitle("This card's column is set by its task steps")).toBeInTheDocument();
  });

  it('shows both the lock and the grip on a locked card', () => {
    render(
      <CardView
        project={{ ...project, move_lock: 'quote' }}
        onExpand={vi.fn()}
        dragHandleProps={{}}
      />,
    );
    // The grip is for reordering inside the column, which the rules allow;
    // the lock badge explains why the card cannot leave that column.
    expect(screen.getByRole('button', { name: /drag|glisser/i })).toBeInTheDocument();
    expect(screen.getByTitle('Locked to Quote until the quote is accepted')).toBeInTheDocument();
  });

  it('keeps the grip on an unlocked card', () => {
    render(
      <CardView project={{ ...project, move_lock: null }} onExpand={vi.fn()} dragHandleProps={{}} />,
    );
    expect(screen.getByRole('button', { name: /drag|glisser/i })).toBeInTheDocument();
  });

  it('shows no lock on a card free to move between Finish and Done', () => {
    render(<CardView project={{ ...project, move_lock: null }} onExpand={vi.fn()} />);
    expect(screen.queryByTitle(/Locked|set by its task steps|declined/)).not.toBeInTheDocument();
  });

  it('offers mark-as-sent on a card in the Quote column', () => {
    render(
      <CardView
        project={{ ...project, column: 'devis' }}
        onExpand={vi.fn()}
        onMarkSent={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /mark as sent/i })).toBeEnabled();
  });

  it('does not offer mark-as-sent outside the Quote column', () => {
    for (const column of ['waiting', 'scan', 'model', 'print', 'finish', 'done'] as const) {
      const { unmount } = render(
        <CardView project={{ ...project, column }} onExpand={vi.fn()} onMarkSent={vi.fn()} />,
      );
      expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('omits mark-as-sent from the drag overlay clone', () => {
    // Same rule delete follows: the overlay is a picture of the card being
    // dragged, and its buttons would be unreachable anyway.
    render(<CardView project={{ ...project, column: 'devis' }} overlay />);
    expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
  });

  it('disables mark-as-sent while the request is in flight, rather than removing it', () => {
    // HoldButton fires on a timer, not on pointer release, so the mutation
    // starts with the user's finger still down. A button that vanishes at that
    // moment vanishes from under them.
    render(
      <CardView
        project={{ ...project, column: 'devis' }}
        onExpand={vi.fn()}
        onMarkSent={vi.fn()}
        markSentPending
      />,
    );
    expect(screen.getByRole('button', { name: /mark as sent/i })).toBeDisabled();
  });

  it('fires mark-as-sent only once the 500ms hold completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onMarkSent = vi.fn();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <CardView
          project={{ ...project, column: 'devis' }}
          onExpand={vi.fn()}
          onMarkSent={onMarkSent}
        />,
      );

      const button = screen.getByRole('button', { name: /mark as sent/i });
      await user.pointer({ keys: '[MouseLeft>]', target: button });
      vi.advanceTimersByTime(300);
      expect(onMarkSent).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300);
      expect(onMarkSent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not offer delete on the board card', () => {
    // Delete moved to the expanded card: a destructive action belongs on the
    // surface that shows you what you are destroying, not on a three-line
    // summary one mis-hold away from it.
    render(<CardView project={project} onExpand={vi.fn()} onMarkSent={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });
});
