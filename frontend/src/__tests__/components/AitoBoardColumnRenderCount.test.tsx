/**
 * The board re-renders on every WebSocket invalidation, search keystroke and
 * presence update; with structural sharing the `project` objects of unchanged
 * cards keep their identity, so a card has no reason to render again. This
 * counts `useTranslation` calls (one per render of every component that
 * translates: BoardColumn, CardView, BoardCardActions…) across a parent
 * re-render that changes nothing the column receives. Only the column itself
 * may render.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../utils';
import { DndContext } from '@dnd-kit/core';
import { BoardColumn } from '../../components/aito/BoardColumn';
import { COLUMNS } from '../../components/aito/columns';
import type { AitoProject } from '../../api/client';

let translationCalls = 0;
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: (...args: Parameters<typeof actual.useTranslation>) => {
      translationCalls += 1;
      return actual.useTranslation(...args);
    },
  };
});

// Real dnd-kit memoises `attributes` and `listeners` across renders; the mock
// must too, or the test would measure the mock rather than the column.
const STABLE_SORTABLE = {
  attributes: { role: 'button' },
  listeners: {},
  setNodeRef: () => {},
  setActivatorNodeRef: () => {},
  transform: null,
  transition: undefined,
  isDragging: false,
};
vi.mock('@dnd-kit/sortable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/sortable')>();
  return { ...actual, useSortable: () => STABLE_SORTABLE };
});

const base: AitoProject = {
  id: 1,
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
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

const CARDS = 20;
const projects = Array.from({ length: CARDS }, (_, i) => ({ ...base, id: i + 1, position: i }));
const noop = () => {};
const never = () => false;

function Harness() {
  const [tick, setTick] = useState(0);
  return (
    <DndContext>
      <button type="button" onClick={() => setTick((t) => t + 1)}>
        tick {tick}
      </button>
      <BoardColumn
        column={COLUMNS[0]}
        projects={projects}
        isDropTarget={false}
        onExpandCard={noop}
        transitionConfig={null}
        shouldAnimateIn={never}
      />
    </DndContext>
  );
}

describe('BoardColumn render cost', () => {
  it('does not re-render the cards when the column re-renders with the same projects', async () => {
    render(<Harness />);
    await waitFor(() => expect(document.querySelectorAll('[data-aito-card]')).toHaveLength(CARDS));

    const before = translationCalls;
    fireEvent.click(screen.getByText('tick 0'));
    await waitFor(() => expect(screen.getByText('tick 1')).toBeInTheDocument());
    const rendersPerTick = translationCalls - before;

    // The column translates its own header (1). Twenty cards would add at
    // least twenty.
    expect(rendersPerTick).toBeLessThan(CARDS);
  });
});
