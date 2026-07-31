/**
 * The done grid: the archive view that replaced the Done column.
 *
 * `DoneCard` owns a `useColumnMoveMutation` per project, so every render needs
 * the query client and toast providers that `render` from `../utils` supplies.
 * No `DndContext` — nothing in the grid drags.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { DoneGrid } from '../../components/aito/DoneGrid';
import type { AitoProject } from '../../api/client';

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
  move_lock: null,
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
  ...over,
});

describe('DoneGrid', () => {
  it('orders the newest completion first', () => {
    render(
      <DoneGrid
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

  it('orders correctly across mixed Z-suffixed and bare timestamps', () => {
    // The board's rows are inconsistently suffixed. A lexical string compare
    // puts the bare timestamp first regardless of the actual instant.
    render(
      <DoneGrid
        projects={[
          card({ id: 1, description: 'Older', updated_at: '2026-07-01T10:00:00' }),
          card({ id: 2, description: 'Newer', updated_at: '2026-07-20T10:00:00Z' }),
        ]}
        query=""
        onExpandCard={vi.fn()}
      />,
    );
    const rendered = screen.getAllByText(/Older|Newer/).map((el) => el.textContent);
    expect(rendered).toEqual(['Newer', 'Older']);
  });

  it('filters on the query', () => {
    render(
      <DoneGrid
        projects={[card({ id: 1, description: 'Support GoPro' }), card({ id: 2, description: 'Boîtier' })]}
        query="gopro"
        onExpandCard={vi.fn()}
      />,
    );
    expect(screen.getByText('Support GoPro')).toBeInTheDocument();
    expect(screen.queryByText('Boîtier')).not.toBeInTheDocument();
  });

  it('shows the empty state when there is nothing done', () => {
    render(<DoneGrid projects={[]} query="" onExpandCard={vi.fn()} />);
    expect(screen.getByText(/no finished projects|aucun projet terminé/i)).toBeInTheDocument();
  });

  it('shows a no-results state, not the empty state, when a search hides everything', () => {
    render(<DoneGrid projects={[card()]} query="zzzz" onExpandCard={vi.fn()} />);
    expect(screen.getByText(/no projects match|aucun projet ne correspond/i)).toBeInTheDocument();
    expect(screen.queryByText(/no finished projects|aucun projet terminé/i)).not.toBeInTheDocument();
  });

  it('offers restore on a released card', () => {
    render(<DoneGrid projects={[card({ move_lock: null })]} query="" onExpandCard={vi.fn()} />);
    expect(screen.getByRole('button', { name: /move back to finish|renvoyer en finition/i })).toBeEnabled();
  });

  it('offers no restore on a declined card the rules pin to Done', () => {
    render(<DoneGrid projects={[card({ move_lock: 'declined' })]} query="" onExpandCard={vi.fn()} />);
    expect(
      screen.queryByRole('button', { name: /move back to finish|renvoyer en finition/i }),
    ).not.toBeInTheDocument();
  });

  it('has no drag handle', () => {
    // `aito.dragHandle` is 'Drag to reorder' / 'Glisser pour réordonner'.
    render(<DoneGrid projects={[card()]} query="" onExpandCard={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /drag|glisser/i })).not.toBeInTheDocument();
  });

  it('opens the detail panel from the card body', async () => {
    const onExpandCard = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<DoneGrid projects={[card({ id: 7 })]} query="" onExpandCard={onExpandCard} />);
    await user.click(screen.getByRole('button', { name: /Support de caméra/ }));
    expect(onExpandCard).toHaveBeenCalledWith(7);
  });
});
