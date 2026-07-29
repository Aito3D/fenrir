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
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../utils';
import { DndContext } from '@dnd-kit/core';
import { BoardColumn } from '../../components/aito/BoardColumn';
import { COLUMNS } from '../../components/aito/columns';
import type { AitoProject } from '../../api/client';

// Vitest hoists `vi.mock` above module-level `const`s, so the factory below
// can only safely close over a variable named with the `mock` prefix — see
// https://vitest.dev/api/vi.html#vi-mock. A spy without that prefix is
// `undefined` inside the factory at call time, which silently produces a
// no-op ref with no error — confirmed the hard way while writing this test.
const mockSetActivatorNodeRef = vi.fn();

vi.mock('@dnd-kit/sortable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    useSortable: () => ({
      attributes: { 'data-dnd-mock-attr': 'grip-only' },
      listeners: {},
      setNodeRef: vi.fn(),
      setActivatorNodeRef: mockSetActivatorNodeRef,
      transform: null,
      transition: undefined,
      isDragging: false,
    }),
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
  quote_id: null,
  quote_number: null,
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
  quote_sync_state: 'idle',
  quote_sync_error: null,
  created_by: null,
  task_count: 0,
  tasks_total: 0,
  task_services: [],
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

function Harness() {
  return (
    <DndContext>
      <BoardColumn
        column={COLUMNS[0]}
        projects={[project]}
        isDropTarget={false}
        onDeleteCard={vi.fn()}
        onExpandCard={vi.fn()}
        transitionConfig={null}
        shouldAnimateIn={() => false}
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
