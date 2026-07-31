import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { CardView } from '../../components/aito/CardView';
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
  task_pending: [],
  steps_total: 0,
  steps_done: 0,
  task_steps: [],
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

  it('shows a step row per task and the total, and no task count', async () => {
    render(
      <CardView
        project={{
          ...project,
          task_count: 2,
          tasks_total: 20200,
          task_services: ['modelisation', 'impression'],
          task_steps: [
            { services: ['modelisation', 'impression'], done: ['modelisation'] },
            { services: ['impression'], done: [] },
          ],
        }}
        onExpand={vi.fn()}
      />,
    );
    expect(await screen.findAllByTestId('aito-step-row')).toHaveLength(2);
    // The count line is gone: the rows themselves say how many tasks there are.
    expect(screen.queryByText(/2 tasks|2 tâches/i)).not.toBeInTheDocument();
    // Matched on the digits, not the whole formatted string: the currency and
    // separators come from formatMoney and the settings stub, and pinning them
    // here would make this a test of formatMoney.
    expect(screen.getByText(/20[,\s.]?200/)).toBeInTheDocument();
  });

  it('renders no step rows and no total for a project with no tasks', () => {
    render(
      <CardView
        project={{ ...project, task_count: 0, tasks_total: 0, task_services: [], task_steps: [] }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('aito-step-row')).not.toBeInTheDocument();
    expect(screen.queryByText('Scan')).not.toBeInTheDocument();
  });

  it('survives a response that predates task_steps instead of blanking the board', () => {
    // A server older than this bundle sends no `task_steps` at all. That is a
    // real window, not a hypothetical: `npm run build` writes into ../static/
    // for the same FastAPI process to serve, so a cached bundle newer than the
    // running server — or a dev frontend pointed at a stale backend — sends
    // `undefined` here. Dereferencing it unmounts EVERY card, because one
    // card's throw takes the whole board's render with it. Degrading to "no
    // step rows" costs one card its pills; not degrading costs the operator
    // the board.
    const legacy = { ...project } as Record<string, unknown>;
    delete legacy.task_steps;

    expect(() =>
      render(<CardView project={legacy as unknown as AitoProject} onExpand={vi.fn()} />),
    ).not.toThrow();
    expect(screen.getByText('Support de caméra')).toBeInTheDocument();
    expect(screen.queryByTestId('aito-step-row')).not.toBeInTheDocument();
  });

  it('shows the same step rows in the drag overlay, which has no buttons', async () => {
    // The overlay clone gets no `onExpand`. Without this test that branch
    // could lose its grid and the suite would stay green while a dragged card
    // visibly lost its pills.
    render(
      <CardView
        project={{
          ...project,
          task_count: 1,
          tasks_total: 20200,
          task_steps: [{ services: ['modelisation', 'impression'], done: ['modelisation'] }],
        }}
        overlay
      />,
    );
    expect(await screen.findByText('Modeling')).toBeInTheDocument();
    expect(screen.getByText(/20[,\s.]?200/)).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('keeps the step grid inside the click target, so a pill opens the panel', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(
      <CardView
        project={{ ...project, task_count: 1, tasks_total: 4000, task_steps: [{ services: ['scan'], done: [] }] }}
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

  it('does not repeat the quote status the column already states', () => {
    // The card's column is derived from quote_status by the board's rule
    // engine (aito_board_rules.evaluate), so a badge restating the status
    // would just echo the column. The detail panel is the only place that
    // still shows the exact status.
    render(
      <CardView
        project={{ ...project, quote_number: 'DEV26-2462', quote_status: 'sent', column: 'waiting' }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.getByText('DEV26-2462')).toBeInTheDocument();
    expect(screen.queryByText(/sent/i)).not.toBeInTheDocument();
  });

  it('draws no lock badge, whatever the rules say about this card', () => {
    // Done left the board, so `finish <-> done` — the only cross-column drag
    // the rules ever allowed — is unreachable and EVERY card is pinned to its
    // column. A badge that applies without exception explains nothing.
    // `move_lock` itself is untouched: allowedColumns still reads it, the
    // server still enforces it, and DoneGrid still gates Restore on it.
    for (const lock of ['quote', 'waiting', 'declined', 'steps'] as const) {
      const { unmount } = render(<CardView project={{ ...project, move_lock: lock }} onExpand={vi.fn()} />);
      expect(screen.queryByTitle(/Locked|set by its task steps|declined|Waiting on/i)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('keeps the grip on a locked card, because reordering is still allowed', () => {
    render(<CardView project={{ ...project, move_lock: 'quote' }} onExpand={vi.fn()} dragHandleProps={{}} />);
    expect(screen.getByRole('button', { name: /drag|glisser/i })).toBeInTheDocument();
  });

  it('keeps the grip on an unlocked card', () => {
    render(
      <CardView project={{ ...project, move_lock: null }} onExpand={vi.fn()} dragHandleProps={{}} />,
    );
    expect(screen.getByRole('button', { name: /drag|glisser/i })).toBeInTheDocument();
  });

  it('renders whatever actions the parent injects', () => {
    render(
      <CardView project={project} onExpand={vi.fn()} actions={<button type="button">Do the thing</button>} />,
    );
    expect(screen.getByRole('button', { name: 'Do the thing' })).toBeInTheDocument();
  });

  it('omits injected actions from the drag overlay clone', () => {
    // Same rule delete follows: the overlay is a picture of the card being
    // dragged, and its buttons would be unreachable anyway.
    render(<CardView project={project} overlay actions={<button type="button">Do the thing</button>} />);
    expect(screen.queryByRole('button', { name: 'Do the thing' })).not.toBeInTheDocument();
  });

  it('omits injected actions on a placeholder card', () => {
    render(
      <CardView
        project={project}
        placeholder
        onExpand={vi.fn()}
        actions={<button type="button">Do the thing</button>}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Do the thing' })).not.toBeInTheDocument();
  });

  it('does not offer delete on the board card', () => {
    // Delete moved to the expanded card: a destructive action belongs on the
    // surface that shows you what you are destroying, not on a three-line
    // summary one mis-hold away from it.
    render(<CardView project={project} onExpand={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('shows the progress bar once the project has steps', () => {
    render(<CardView project={{ ...project, steps_total: 4, steps_done: 1 }} onExpand={vi.fn()} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  });

  it('shows no bar on an unpriced project', () => {
    render(<CardView project={{ ...project, steps_total: 0, steps_done: 0 }} onExpand={vi.fn()} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('lets the card clip the progress bar instead of the bar rounding itself', () => {
    // The bar sits INSIDE the card's 1px border, so its own `rounded-b-xl` is
    // a different radius than the card's inner corner and the fill squares off
    // against it. The card clips it now, so the only curve involved is the
    // card's own.
    render(<CardView project={{ ...project, steps_total: 4, steps_done: 1 }} onExpand={vi.fn()} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.className).not.toMatch(/rounded/);
    expect(bar).toHaveClass('h-1.5');
    expect(document.querySelector('[data-aito-card]')).toHaveClass('overflow-hidden');
  });

  it('opens the panel from the footer, not just from the description', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(
      <CardView project={{ ...project, quote_number: 'DEV26-2462' }} onExpand={onExpand} />,
    );
    await user.click(screen.getByText('DEV26-2462'));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('lets an injected action take its own click without opening the panel', async () => {
    const onExpand = vi.fn();
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(
      <CardView
        project={project}
        onExpand={onExpand}
        actions={
          <button type="button" onClick={onAction}>
            Do the thing
          </button>
        }
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Do the thing' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('offers exactly one target for the whole card body', () => {
    // One <button>, not one per zone: a card that announced "description",
    // "steps" and "footer" as three separate controls would be worse to
    // navigate than the single dead region it replaced.
    render(<CardView project={project} onExpand={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /Support de caméra/ })).toHaveLength(1);
  });

  it('opens from the keyboard through the same handler as the pointer', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(<CardView project={project} onExpand={onExpand} />);
    const target = screen.getByRole('button', { name: /Support de caméra/ });
    target.focus();
    await user.keyboard('{Enter}');
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});

describe('CardView — hover to read a clamped description', () => {
  // jsdom lays nothing out, so scrollHeight and clientHeight are both 0 and
  // the "is it actually clamped?" guard would refuse every card. Stub them
  // per test to state which case is being exercised.
  function setClamped(node: HTMLElement, clamped: boolean) {
    Object.defineProperty(node, 'scrollHeight', { value: clamped ? 240 : 60, configurable: true });
    Object.defineProperty(node, 'clientHeight', { value: 60, configurable: true });
  }

  // jsdom never lays anything out, so the card's real `offsetHeight` is
  // always 0. Stubbed the same way `setClamped` stubs the description, so the
  // pinned-height assertion below checks a real, non-zero value rather than
  // jsdom's default.
  function setCardHeight(node: HTMLElement, height: number) {
    Object.defineProperty(node, 'offsetHeight', { value: height, configurable: true });
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('un-clamps the description after a full second of hover', () => {
    render(<CardView project={project} onExpand={vi.fn()} />);
    const description = screen.getByTestId('aito-card-description');
    setClamped(description, true);
    const card = document.querySelector('[data-aito-card]') as HTMLElement;
    setCardHeight(card, 180);

    fireEvent.mouseEnter(screen.getByTestId('aito-card-shell'));
    act(() => vi.advanceTimersByTime(1000));

    expect(description).not.toHaveClass('line-clamp-3');

    // The invariant the whole design exists for: the shell pins the
    // collapsed height inline so the column does not reflow, and the card
    // itself floats free of the document flow to cover its neighbours.
    const shell = screen.getByTestId('aito-card-shell');
    expect(shell).toHaveStyle({ height: '180px' });
    expect(card).toHaveClass('absolute');
    expect(card).toHaveClass('z-30');
  });

  it('does not expand on a hover shorter than a second', () => {
    render(<CardView project={project} onExpand={vi.fn()} />);
    const description = screen.getByTestId('aito-card-description');
    setClamped(description, true);
    const shell = screen.getByTestId('aito-card-shell');

    fireEvent.mouseEnter(shell);
    act(() => vi.advanceTimersByTime(800));
    fireEvent.mouseLeave(shell);
    act(() => vi.advanceTimersByTime(1000));

    expect(description).toHaveClass('line-clamp-3');
  });

  it('collapses again when the pointer leaves', () => {
    render(<CardView project={project} onExpand={vi.fn()} />);
    const description = screen.getByTestId('aito-card-description');
    setClamped(description, true);
    const shell = screen.getByTestId('aito-card-shell');

    fireEvent.mouseEnter(shell);
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.mouseLeave(shell);

    expect(description).toHaveClass('line-clamp-3');
  });

  it('does not move a card whose description is not clamped', () => {
    // Nothing hidden means nothing to reveal, and a card that jumps for no
    // visible reason is worse than one that never jumps.
    render(<CardView project={project} onExpand={vi.fn()} />);
    const description = screen.getByTestId('aito-card-description');
    setClamped(description, false);

    fireEvent.mouseEnter(screen.getByTestId('aito-card-shell'));
    act(() => vi.advanceTimersByTime(1000));

    expect(description).toHaveClass('line-clamp-3');
    // Not "did not pin 0px" — jsdom's unmocked offsetHeight happens to BE 0,
    // which happens to stringify to '0px'; asserting against that is coupled
    // to a test-environment artifact, not to the invariant. The real
    // invariant is that no inline height was applied at all.
    const shell = screen.getByTestId('aito-card-shell');
    expect(shell.style.height).toBe('');
  });

  it('never expands the drag overlay clone', () => {
    render(<CardView project={project} overlay />);
    const description = screen.getByTestId('aito-card-description');
    setClamped(description, true);

    fireEvent.mouseEnter(screen.getByTestId('aito-card-shell'));
    act(() => vi.advanceTimersByTime(1000));

    expect(description).toHaveClass('line-clamp-3');
  });

  it('never expands a placeholder card', () => {
    // `startHoverIntent` returns early for `overlay || placeholder`; only the
    // `overlay` half had a test until now. Placeholder is typically paired with
    // `onExpand` by its parent (BoardColumn), so render that shape too.
    render(<CardView project={project} placeholder onExpand={vi.fn()} />);
    const description = screen.getByTestId('aito-card-description');
    setClamped(description, true);

    fireEvent.mouseEnter(screen.getByTestId('aito-card-shell'));
    act(() => vi.advanceTimersByTime(1000));

    expect(description).toHaveClass('line-clamp-3');
  });

  it('keeps the morph anchor on the card, not on the shell', () => {
    // useCardMorph queries [data-aito-card-id] and assigns viewTransitionName
    // to whatever it finds. On the shell that would morph an invisible
    // spacer into the detail panel.
    render(<CardView project={project} onExpand={vi.fn()} />);
    const shell = screen.getByTestId('aito-card-shell');
    expect(shell).not.toHaveAttribute('data-aito-card-id');
    expect(shell.querySelector('[data-aito-card-id="12"]')).not.toBeNull();
  });
});
