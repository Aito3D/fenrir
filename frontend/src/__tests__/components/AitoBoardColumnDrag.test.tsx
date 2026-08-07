/**
 * `AitoCardView.test.tsx` renders `CardView` bare, with `dragHandleProps={{}}`
 * — it never mounts a `DndContext`, so `BoardColumn.tsx`'s wiring of
 * `setActivatorNodeRef` onto the grip (via `dragHandleRef`) and
 * `{...attributes, ...listeners}` (via `dragHandleProps`) has no coverage.
 * Drop `dragHandleRef`, or spread `attributes` onto the card wrapper instead
 * of the grip, and the board silently becomes undraggable — by keyboard, by
 * pointer, or both — with a fully green suite.
 *
 * `jsdom` here has no global `PointerEvent` (confirmed experimentally: even
 * `new PointerEvent(...)` throws `ReferenceError: PointerEvent is not
 * defined`), so a real pointer drag cannot be dispatched and observed via
 * `onDragStart`. Per the task, falling back to structural assertions instead
 * of faking a drag.
 *
 * Plain attribute assertions against the *real* `useSortable` are not
 * sufficient on their own, though: dnd-kit's sensors bind their activation
 * listeners wherever `dragHandleProps` (`attributes` + `listeners`) is
 * spread — which stays correctly on the grip even if
 * `dragHandleRef={setActivatorNodeRef}` is dropped, because that prop feeds
 * a *separate* ref callback that real dnd-kit only consults for a keyboard
 * guard and post-drag focus restoration, neither of which is easy to
 * observe from outside in jsdom. So a dropped `dragHandleRef` would not move
 * any rendered ARIA attribute and would slip past an attribute-only test
 * (confirmed the hard way while writing this: an attribute-only version of
 * this test kept passing after deleting `dragHandleRef={setActivatorNodeRef}`
 * from BoardColumn.tsx).
 *
 * `useSortable` is therefore mocked so the test can see its ref callback
 * directly: `setActivatorNodeRef` is a spy, and the mocked `attributes`
 * carry a marker (`data-dnd-mock-attr`) so we can also assert *where*
 * `BoardColumn` spreads them. Together these two assertions catch both
 * variants named above — dropping `dragHandleRef` (spy never called) and
 * spreading `attributes` onto the wrong element (marker on the wrong node).
 *
 * The second describe block below (`BoardColumn — dropDisabled`) covers
 * Task 9's `dropDisabled` prop: `useDroppable` is mocked the same way, as a
 * spy, so the test can see the `disabled` option BoardColumn actually passes
 * rather than inferring it from a side effect. `DndContext` is left real
 * (via `importOriginal`) since BoardColumn's `useDroppable` call needs to run
 * inside a real drag context provider to not throw.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../utils';
import { DndContext } from '@dnd-kit/core';
import { BoardColumn } from '../../components/aito/BoardColumn';
import { COLUMNS } from '../../components/aito/columns';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

// Vitest hoists `vi.mock` above module-level `const`s, so the factory below
// can only safely close over a variable named with the `mock` prefix — see
// https://vitest.dev/api/vi.html#vi-mock. A spy without that prefix is
// `undefined` inside the factory at call time, which silently produces a
// no-op ref with no error — confirmed the hard way while writing this test.
const mockSetActivatorNodeRef = vi.fn();
const mockUseDroppable = vi.fn();
const mockUseSortable = vi.fn();

vi.mock('@dnd-kit/sortable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    useSortable: (args: Parameters<typeof actual.useSortable>[0]) => {
      // Recorded rather than forwarded: `disabled` is the whole of what makes
      // a locked card undraggable, and it is invisible in the rendered output.
      mockUseSortable(args);
      return {
        attributes: { 'data-dnd-mock-attr': 'grip-only' },
        listeners: {},
        setNodeRef: vi.fn(),
        setActivatorNodeRef: mockSetActivatorNodeRef,
        transform: null,
        transition: undefined,
        isDragging: false,
      };
    },
  };
});

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    useDroppable: (args: Parameters<typeof actual.useDroppable>[0]) => {
      mockUseDroppable(args);
      return actual.useDroppable(args);
    },
  };
});

const project: AitoProject = {
  id: 42,
  description: 'Support de caméra pour drone',
  column: 'devis',
  position: 0,
  status: 'active',
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
  version: 1,
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

function Harness({
  dropDisabled,
  dragDisabled,
  moveLock = null,
}: {
  dropDisabled?: boolean;
  dragDisabled?: boolean;
  moveLock?: AitoProject['move_lock'];
} = {}) {
  return (
    <DndContext>
      <BoardColumn
        column={COLUMNS[0]}
        projects={[{ ...project, move_lock: moveLock }]}
        isDropTarget={false}
        onExpandCard={vi.fn()}
        transitionConfig={null}
        shouldAnimateIn={() => false}
        dropDisabled={dropDisabled}
        dragDisabled={dragDisabled}
      />
    </DndContext>
  );
}

describe('BoardColumn — drag handle wiring', () => {
  beforeEach(() => {
    mockSetActivatorNodeRef.mockClear();
  });

  it('wires setActivatorNodeRef and the sortable attributes to the grip, and only the grip', () => {
    render(<Harness />);

    const grip = screen.getByRole('button', { name: /drag|glisser/i });
    const cardWrapper = document.querySelector('[data-aito-card]');
    const body = screen.getByRole('button', { name: /Support de caméra/ });

    expect(cardWrapper).not.toBeNull();
    // Sanity check these really are three distinct elements, not the same
    // node queried three ways.
    expect(grip).not.toBe(body);
    expect(cardWrapper).not.toBe(grip);
    expect(cardWrapper).not.toBe(body);

    // dnd-kit's `setActivatorNodeRef` must have been attached as a ref
    // somewhere, and specifically to the grip.
    expect(mockSetActivatorNodeRef).toHaveBeenCalledWith(grip);

    // The `attributes` spread (role/tabIndex/aria-* in real dnd-kit) lands
    // only on the grip.
    expect(grip).toHaveAttribute('data-dnd-mock-attr', 'grip-only');
    expect(cardWrapper).not.toHaveAttribute('data-dnd-mock-attr');
    expect(body).not.toHaveAttribute('data-dnd-mock-attr');
  });
});

describe('BoardColumn — a locked card is grabbable for reordering', () => {
  beforeEach(() => {
    mockUseSortable.mockClear();
    mockSetActivatorNodeRef.mockClear();
  });

  it('leaves the sortable enabled and renders a grip when the rules lock the card', () => {
    render(<Harness moveLock="quote" />);

    // Reordering inside a column is always allowed — it changes priority, not
    // state — so the sortable must not be disabled. `useBoardDrag`'s
    // `isDropAllowed` is what refuses the cross-column drop.
    expect(mockUseSortable).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }));
    expect(mockUseSortable).not.toHaveBeenCalledWith(expect.objectContaining({ disabled: true }));
    const grip = screen.getByRole('button', { name: /drag|glisser/i });
    expect(grip).toBeInTheDocument();
    // The activator is wired to the grip, exactly as on an unlocked card.
    expect(mockSetActivatorNodeRef).toHaveBeenCalledWith(grip);
  });

  it('draws no lock badge on a locked card, even though the grip stays', () => {
    // CardView no longer draws a lock badge at all (Done left the board, so
    // every card is pinned to its column without exception — see CardView's
    // own test for the full reasoning). Covered here too because BoardColumn
    // is what actually wraps CardView in a column, and a regression that
    // reintroduced the badge only at this layer would slip past CardView's
    // suite.
    render(<Harness moveLock="quote" />);

    expect(screen.queryByRole('img', { name: /locked/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /drag|glisser/i })).toBeInTheDocument();
  });

  it('leaves an unlocked card draggable', () => {
    render(<Harness />);
    expect(mockUseSortable).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }));
    expect(mockUseSortable).not.toHaveBeenCalledWith(expect.objectContaining({ disabled: true }));
    expect(screen.getByRole('button', { name: /drag|glisser/i })).toBeInTheDocument();
  });
});

describe('BoardColumn — dropDisabled', () => {
  beforeEach(() => {
    mockUseDroppable.mockClear();
  });

  it('passes dropDisabled through to useDroppable as the disabled option, for a disallowed column', () => {
    render(<Harness dropDisabled />);
    expect(mockUseDroppable).toHaveBeenCalledWith({ id: COLUMNS[0].id, disabled: true });
  });

  it('leaves an allowed column — including the locked card\'s own column — enabled', () => {
    render(<Harness dropDisabled={false} />);
    expect(mockUseDroppable).toHaveBeenCalledWith({ id: COLUMNS[0].id, disabled: false });
  });

  it('defaults to enabled when dropDisabled is omitted (no drag in progress)', () => {
    render(<Harness />);
    expect(mockUseDroppable).toHaveBeenCalledWith({ id: COLUMNS[0].id, disabled: undefined });
  });

  it('refuses drops while the board is filtered', () => {
    render(<Harness dragDisabled />);
    expect(mockUseDroppable).toHaveBeenCalledWith({ id: COLUMNS[0].id, disabled: true });
  });

  /** BoardColumn's own outer div, reached from its <h2>: heading -> header
   *  div -> the wrapper that carries the drop styling. Anchored on the
   *  heading rather than `container.firstElementChild` because the shared
   *  `render` from '../utils' wraps every tree in providers, one of which
   *  (ToastProvider) can render DOM of its own. */
  function columnWrapper(): HTMLElement {
    return screen.getByRole('heading', { level: 2 }).closest('div')!.parentElement as HTMLElement;
  }

  it('dims a column that is refusing drops, so the drag shows where it may land', () => {
    render(<Harness dropDisabled />);
    expect(columnWrapper().className).toContain('opacity-40');
  });

  it('leaves an accepting column at full opacity', () => {
    render(<Harness dropDisabled={false} />);
    expect(columnWrapper().className).not.toContain('opacity-40');
  });
});

describe('BoardColumn — revert flash', () => {
  // Regression for the review finding that every failure-path test mocks
  // `flashRevert` and asserts it was called, and `useIsReverting` is only
  // tested in isolation — so nothing ever asserted the actual DOM
  // consequence. Deleting `animate-revert-flash` from SortableCard's wrapper
  // below would leave every one of those tests green while the whole
  // revert-signal feature silently stopped rendering. `useRevertFlash` is
  // deliberately left real here (unlike AitoPage.test.tsx and friends, which
  // mock it to assert the call) so this test observes the actual class.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('puts animate-revert-flash on the card wrapper when a board write is rejected', async () => {
    vi.spyOn(api, 'setAitoQuoteStatus').mockRejectedValue(new Error('nope'));
    render(<Harness />);

    // "Mark as sent" (CardView's HoldButton, devis-only) drives
    // useQuoteStatusMutation, one of useOptimisticBoardMutation's real
    // callers — a 500ms hold, per CardView's own `durationMs={500}`.
    const markSent = screen.getByRole('button', { name: 'Mark as sent' });
    fireEvent.pointerDown(markSent);
    await waitFor(() => expect(api.setAitoQuoteStatus).toHaveBeenCalled(), { timeout: 2000 });

    // CardView's own root carries `data-aito-card`; its parent is the
    // hover-reveal shell, anchored here by its own `data-testid` rather than a
    // hop count — a DOM-depth magic number drifts the moment another wrapper
    // is added, as it already did once this branch when the shell itself
    // showed up. The shell's parent is SortableCard's wrapper, the element
    // that actually holds the conditional class under test.
    const wrapper = screen.getByTestId('aito-card-shell').parentElement!;
    await waitFor(() => expect(wrapper.className).toContain('animate-revert-flash'));

    // `useRevertFlash`'s flagged id is module-level state with its own
    // 600ms timer, with no test-only reset (unlike useBoardSync's
    // `__resetBoardSync`) — wait it out so it cannot bleed into whatever
    // test runs next in this file.
    await waitFor(() => expect(wrapper.className).not.toContain('animate-revert-flash'), { timeout: 2000 });
  });

  it('leaves the class off an idle card', () => {
    render(<Harness />);
    const wrapper = screen.getByTestId('aito-card-shell').parentElement!;
    expect(wrapper.className).not.toContain('animate-revert-flash');
  });
});
