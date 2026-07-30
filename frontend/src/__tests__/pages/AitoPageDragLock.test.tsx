/**
 * Regression coverage for the cross-column drag lock (Task 9, finding 1):
 * `BoardColumn`'s `dropDisabled` only disables the COLUMN's own droppable —
 * it opens a slot in an empty column, but every card inside a column is its
 * own `useSortable` droppable and stays collidable no matter which column
 * it lives in. `handleDragOver` in `AitoPage.tsx` resolves `over.id` through
 * `findColumn`, which matches a card id just as happily as a column id, so
 * dragging a locked card onto an existing card in a disallowed column used
 * to live-relocate it locally with no `allowedColumns` check anywhere on
 * that path — only a completely empty target column was actually blocked.
 *
 * `AitoBoardColumnDrag.test.tsx` documents why a real pointer drag cannot be
 * dispatched and observed in jsdom (no global `PointerEvent`). The gate this
 * file covers lives in `AitoPage.tsx`'s `onDragStart`/`onDragOver`/
 * `onDragEnd` callbacks, which dnd-kit's `DndContext` invokes internally in
 * response to a real drag — so `@dnd-kit/core`'s `DndContext` is mocked here
 * to capture exactly those callbacks and expose them to the test, which then
 * calls them directly with synthetic `{ active, over }` event shapes (the
 * same shape dnd-kit hands them at runtime). This drives AitoPage's actual
 * production closures — `board`, `allowedDropColumns`, `applyCrossColumnMove`
 * — with no dnd-kit sensor/collision-detection involved.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';

interface CapturedHandlers {
  onDragStart?: (e: { active: { id: number } }) => void;
  onDragOver?: (e: { active: { id: number }; over: { id: number | string } | null }) => void;
  onDragEnd?: (e: { active: { id: number }; over: { id: number | string } | null }) => void;
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
      onDragOver?: CapturedHandlers['onDragOver'];
      onDragEnd?: CapturedHandlers['onDragEnd'];
    }) => {
      mockCapturedHandlers.onDragStart = props.onDragStart;
      mockCapturedHandlers.onDragOver = props.onDragOver;
      mockCapturedHandlers.onDragEnd = props.onDragEnd;
      return props.children;
    },
  };
});

// Locked to its own column ('devis') — allowedColumns() returns ['devis']
// only, so it may reorder inside Quote but must not cross into any other
// column.
const lockedProject = {
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
  move_lock: 'quote',
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-02T10:00:00Z',
};

const waitingProject = {
  id: 34,
  description: 'Etui manette',
  column: 'waiting',
  position: 0,
  status: 'active',
  client_id: 'z2',
  client_name: 'Client Deux',
  client_phone: null,
  task_count: 0,
  tasks_total: 0,
  task_services: [],
  move_lock: 'waiting',
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-02T10:00:00Z',
};

// A second card in the SAME column as the locked card, to prove reordering
// within a locked card's own column keeps working — the fix must gate on
// the resolved DESTINATION COLUMN, not on "is this over.id a card at all".
const secondQuoteProject = {
  id: 56,
  description: 'Coque manette',
  column: 'devis',
  position: 1,
  status: 'active',
  client_id: 'z3',
  client_name: 'Client Trois',
  client_phone: null,
  task_count: 0,
  tasks_total: 0,
  task_services: [],
  move_lock: 'quote',
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-02T10:00:00Z',
};

/** Locates the column element (header + card list) by its visible label. */
function findColumnContainer(labelText: string): HTMLElement {
  const heading = screen.getByText(labelText);
  // heading (<h2>) -> header <div> -> BoardColumn's own outer <div>, which
  // also wraps the SortableContext's card-list <div>.
  return heading.closest('div')!.parentElement as HTMLElement;
}

beforeEach(() => {
  mockCapturedHandlers.onDragStart = undefined;
  mockCapturedHandlers.onDragOver = undefined;
  mockCapturedHandlers.onDragEnd = undefined;

  server.use(
    http.get('/api/v1/aito/', () => HttpResponse.json([lockedProject, waitingProject, secondQuoteProject])),
    http.get('/api/v1/zoho/status', () => HttpResponse.json({ configured: true, reachable: true })),
  );
});

describe('AitoPage — cross-column drag lock (over a card, not just an empty column)', () => {
  it('does not relocate a locked card dragged over a CARD that lives in a disallowed column', async () => {
    render(<AitoPage />);
    await screen.findByText('Support GoPro');

    act(() => {
      mockCapturedHandlers.onDragStart?.({ active: { id: 12 } });
    });
    // over.id here is a CARD id (34), not the 'waiting' column id — this is
    // exactly the path `dropDisabled` on the column droppable cannot cover.
    act(() => {
      mockCapturedHandlers.onDragOver?.({ active: { id: 12 }, over: { id: 34 } });
    });

    const quoteColumn = findColumnContainer('Quote');
    const waitingColumn = findColumnContainer('Waiting');

    expect(within(quoteColumn).getByText('Support GoPro')).toBeInTheDocument();
    expect(within(waitingColumn).queryByText('Support GoPro')).not.toBeInTheDocument();
  });

  it('does not relocate a locked card dragged over a disallowed column\'s own (empty-area) id either', async () => {
    render(<AitoPage />);
    await screen.findByText('Support GoPro');

    act(() => {
      mockCapturedHandlers.onDragStart?.({ active: { id: 12 } });
    });
    act(() => {
      mockCapturedHandlers.onDragOver?.({ active: { id: 12 }, over: { id: 'waiting' } });
    });

    const quoteColumn = findColumnContainer('Quote');
    const waitingColumn = findColumnContainer('Waiting');

    expect(within(quoteColumn).getByText('Support GoPro')).toBeInTheDocument();
    expect(within(waitingColumn).queryByText('Support GoPro')).not.toBeInTheDocument();
  });

  // A locked card IS grabbable — the grip came back so the Quote column can be
  // re-prioritised while its cards wait on acceptance (see
  // AitoBoardColumnDrag.test.tsx). This is that path end to end: the lock gate
  // must not treat the card's own column as a forbidden destination, and the
  // reorder must reach the server.
  it('reorders a locked card inside its own column and persists it', async () => {
    let moveRequestBody: { id: string; body: unknown } | null = null;
    server.use(
      http.patch('/api/v1/aito/:id/move', async ({ request, params }) => {
        moveRequestBody = { id: params.id as string, body: await request.json() };
        return HttpResponse.json({ ...lockedProject, position: 1 });
      }),
    );

    render(<AitoPage />);
    await screen.findByText('Support GoPro');

    act(() => {
      mockCapturedHandlers.onDragStart?.({ active: { id: 12 } });
    });
    // Drag the first Quote card (id 12, position 0) onto the second (id 56,
    // position 1) — same column, and allowed even though both are locked.
    await act(async () => {
      mockCapturedHandlers.onDragEnd?.({ active: { id: 12 }, over: { id: 56 } });
      // Real time, not fake timers: gives the mutation's fetch room to
      // round-trip instead of racing a synchronous assertion.
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // Both cards are still in Quote — the reorder must not have relocated
    // anything across columns.
    const quoteColumn = findColumnContainer('Quote');
    expect(within(quoteColumn).getByText('Support GoPro')).toBeInTheDocument();
    expect(within(quoteColumn).getByText('Coque manette')).toBeInTheDocument();

    // And the new priority reached the server.
    expect(moveRequestBody).toEqual({ id: '12', body: { column: 'devis', position: 1 } });
  });

  it('does not PATCH a move when a locked card is dropped onto a card in a disallowed column, even without a prior dragOver', async () => {
    // dnd-kit can deliver a drop whose final `over` never appeared in a
    // dragOver call (e.g. a very fast drag). handleDragEnd has its own
    // `computeMoveTarget` call, independent of handleDragOver's — this pins
    // that the lock guard covers that path too, not just the live-relocate
    // one covered above.
    let moveRequestBody: unknown = null;
    server.use(
      http.patch('/api/v1/aito/:id/move', async ({ request, params }) => {
        moveRequestBody = { id: params.id, body: await request.json() };
        return HttpResponse.json({ ...lockedProject, column: 'waiting' });
      }),
    );

    render(<AitoPage />);
    await screen.findByText('Support GoPro');

    act(() => {
      mockCapturedHandlers.onDragStart?.({ active: { id: 12 } });
    });
    // Real time, not fake timers: gives the mutation's fetch (mocked by msw)
    // room to actually round-trip if the guard fails to stop it, instead of
    // racing a synchronous assertion against an in-flight promise chain.
    await act(async () => {
      mockCapturedHandlers.onDragEnd?.({ active: { id: 12 }, over: { id: 34 } });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const quoteColumn = findColumnContainer('Quote');
    const waitingColumn = findColumnContainer('Waiting');
    expect(within(quoteColumn).getByText('Support GoPro')).toBeInTheDocument();
    expect(within(waitingColumn).queryByText('Support GoPro')).not.toBeInTheDocument();
    expect(moveRequestBody).toBeNull();
  });
});
