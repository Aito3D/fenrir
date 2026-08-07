/**
 * Regression coverage for the Aito drag system's only untested failure path
 * (review finding, Task 3): `useBoardDrag.ts`'s `moveMutation.onError`
 * (:108-113) restores the pre-drag cache snapshot and toasts when the move
 * PATCH fails, and `onDragCancel` (Escape mid-drag) resets drag state and
 * resyncs without ever issuing a PATCH. Neither had a test — `grep
 * moveFailed src/__tests__` was empty before this file.
 *
 * Harness copied from `AitoPageDragLock.test.tsx`: `@dnd-kit/core`'s
 * `DndContext` is mocked to capture the `onDragStart`/`onDragEnd`/
 * `onDragCancel` callbacks `AitoPage` wires to it, which the test then calls
 * directly with synthetic event shapes — see that file's own header comment
 * for why a real pointer drag cannot be dispatched in jsdom. `CapturedHandlers`
 * is extended here with `onDragCancel`, which the drag-lock file never needed.
 *
 * New sibling file rather than extending `AitoPageDragLock.test.tsx`: that
 * file's fixtures and describe block are about the cross-column drop lock
 * specifically; this one is about the move mutation's failure/cancel paths,
 * a different concern that deserves its own fixtures and doesn't need the
 * locked/unlocked card pairing the lock suite is built around.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';
import { __resetBoardSync } from '../../hooks/useBoardSync';

interface CapturedHandlers {
  onDragStart?: (e: { active: { id: number } }) => void;
  onDragEnd?: (e: { active: { id: number }; over: { id: number | string } | null }) => void;
  onDragCancel?: () => void;
}

// Vitest hoists `vi.mock` above module-level `const`s, so the factory below
// can only safely close over a variable named with the `mock` prefix — see
// https://vitest.dev/api/vi.html#vi-mock.
const mockCapturedHandlers: CapturedHandlers = {};

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: {
      children: React.ReactNode;
      onDragStart?: CapturedHandlers['onDragStart'];
      onDragEnd?: CapturedHandlers['onDragEnd'];
      onDragCancel?: CapturedHandlers['onDragCancel'];
    }) => {
      mockCapturedHandlers.onDragStart = props.onDragStart;
      mockCapturedHandlers.onDragEnd = props.onDragEnd;
      mockCapturedHandlers.onDragCancel = props.onDragCancel;
      return props.children;
    },
  };
});

// Three unlocked cards, all in the same column. Same-column reorder is the
// ONLY drag that ever reaches the move mutation now: `allowedColumns()`
// (utils/aitoBoard.ts) returns just `[project.column]`, so a cross-column
// drop is refused before `handleDragEnd` ever calls `mutate()` — see
// AitoPageDragLock.test.tsx for that gate's own coverage.
const firstProject = {
  id: 12,
  description: 'Support GoPro',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: null,
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
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-02T10:00:00Z',
};

const secondProject = {
  id: 34,
  description: 'Etui manette',
  column: 'devis',
  position: 1,
  status: 'active',
  client_id: 'z2',
  client_name: 'Client Deux',
  client_phone: null,
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
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-02T10:00:00Z',
};

const thirdProject = {
  id: 56,
  description: 'Coque manette',
  column: 'devis',
  position: 2,
  status: 'active',
  client_id: 'z3',
  client_name: 'Client Trois',
  client_phone: null,
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
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-02T10:00:00Z',
};

/** Locates the column element (header + card list) by its visible label. */
function findColumnContainer(labelText: string): HTMLElement {
  const heading = screen.getByText(labelText);
  return heading.closest('div')!.parentElement as HTMLElement;
}

/** DOM order of cards inside a column, read off the stable `data-aito-card-id`
 *  marker `CardView` puts on its own root. */
function cardOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-aito-card-id]')).map((el) =>
    el.getAttribute('data-aito-card-id'),
  ) as string[];
}

beforeEach(() => {
  mockCapturedHandlers.onDragStart = undefined;
  mockCapturedHandlers.onDragEnd = undefined;
  mockCapturedHandlers.onDragCancel = undefined;

  // useBoardSync's pending-write counters are module-level and survive
  // between tests in this file — a prior test's move settling late (or
  // failing before settle) would otherwise leak into the next one.
  __resetBoardSync();

  server.use(
    http.get('/api/v1/aito/', () => HttpResponse.json([firstProject, secondProject, thirdProject])),
    http.get('/api/v1/zoho/status', () => HttpResponse.json({ configured: true, reachable: true })),
  );
});

describe('AitoPage — drag failure paths (moveMutation.onError, onDragCancel)', () => {
  it('restores the pre-drag order and shows the failure toast when the move PATCH fails', async () => {
    server.use(http.patch('/api/v1/aito/:id/move', () => HttpResponse.json({ message: 'nope' }, { status: 500 })));

    render(<AitoPage />);
    await screen.findByText('Support GoPro');

    const column = findColumnContainer('Quote');
    expect(cardOrder(column)).toEqual(['12', '34', '56']);

    // The failed PATCH's `onSettled` invalidates `['aito-projects']`, which
    // triggers a background GET. That GET's mock fixture is never mutated by
    // the failing PATCH, so if it were left free to resolve, it would
    // eventually restore the original order all on its own — masking whether
    // `onError`'s manual `queryClient.setQueryData` rollback (useBoardDrag.ts
    // :108-113) actually ran. Hanging it forever, AFTER the initial load
    // above, makes the assertion below depend on nothing but that rollback.
    server.use(http.get('/api/v1/aito/', () => new Promise(() => {})));

    act(() => {
      mockCapturedHandlers.onDragStart?.({ active: { id: 12 } });
    });
    act(() => {
      // Drag the first card onto the last: reorders to [34, 56, 12] and
      // fires the PATCH this test makes fail.
      mockCapturedHandlers.onDragEnd?.({ active: { id: 12 }, over: { id: 56 } });
    });

    // Wait on the failure toast, not a fixed sleep: useBoardDrag.ts's
    // moveMutation.onError (:108-113) sets the cache rollback via
    // queryClient.setQueryData BEFORE calling showToast, so by the time this
    // toast is in the DOM the rollback has already run — proving it without
    // racing a timer.
    await waitFor(() => expect(screen.getByText('Could not move the project. Please try again.')).toBeInTheDocument());

    // Cache rollback restored the original order — not just "some" order.
    expect(cardOrder(column)).toEqual(['12', '34', '56']);
  });

  it('onDragCancel (Escape mid-drag) restores drag state and issues no PATCH', async () => {
    let moveRequestCount = 0;
    server.use(
      http.patch('/api/v1/aito/:id/move', () => {
        moveRequestCount += 1;
        return HttpResponse.json({ ...firstProject, position: 1 });
      }),
    );

    render(<AitoPage />);
    await screen.findByText('Support GoPro');

    const quoteColumn = findColumnContainer('Quote');
    const waitingColumn = findColumnContainer('Waiting');
    expect(cardOrder(quoteColumn)).toEqual(['12', '34', '56']);
    // No drag in progress: every column accepts drops.
    expect(waitingColumn.className).not.toContain('opacity-40');

    act(() => {
      mockCapturedHandlers.onDragStart?.({ active: { id: 12 } });
    });

    // `handleDragStart` sets `allowedDropColumns` to the dragged card's own
    // column only (`allowedColumns()`, utils/aitoBoard.ts — cross-column drop
    // is refused entirely now), which AitoPage feeds into every OTHER
    // column's `dropDisabled` prop. Waiting dimming to opacity-40 here is a
    // real, AitoPage-owned consequence of the drag being "in progress" — not
    // a dnd-kit internal, and not dependent on the real `DndContext` this
    // file's mock replaces (`DragOverlay`'s own child rendering IS gated on
    // that real context, confirmed the hard way: an earlier version of this
    // test asserted a `DragOverlay` clone and never saw one appear).
    expect(waitingColumn.className).toContain('opacity-40');

    act(() => {
      mockCapturedHandlers.onDragCancel?.();
    });

    // Wait on the drag lock clearing, not a fixed sleep: `resyncIfIdle`
    // invalidates the query, and the sync effect that rebuilds `board` from
    // the refetch needs a tick to run.
    await waitFor(() => expect(waitingColumn.className).not.toContain('opacity-40'));
    // The board is exactly where it started.
    expect(cardOrder(quoteColumn)).toEqual(['12', '34', '56']);
    // And no move was ever attempted.
    expect(moveRequestCount).toBe(0);
  });
});
