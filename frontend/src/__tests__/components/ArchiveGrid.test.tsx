/**
 * The scroller + grid shared by DoneGrid and TrashGrid. Covered directly so
 * a change to the wrapper's classes or the map's key strategy shows up here,
 * not just as an incidental snapshot of whichever archive noticed first.
 */

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { ArchiveGrid } from '../../components/aito/archives/ArchiveGrid';
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
  client_contacted_at: null,
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
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
  ...over,
});

describe('ArchiveGrid', () => {
  it('wraps the scroller and grid classes around each rendered card', () => {
    const { container } = render(
      <ArchiveGrid
        projects={[card({ id: 1, description: 'One' }), card({ id: 2, description: 'Two' })]}
        renderCard={(project) => <div>{project.description}</div>}
      />,
    );

    const scroller = container.firstElementChild;
    expect(scroller).toHaveClass('flex-1', 'min-h-0', 'overflow-y-auto', 'scrollbar-hide', 'pb-4');

    const grid = scroller?.firstElementChild;
    expect(grid).toHaveClass(
      'grid',
      'gap-3',
      'grid-cols-1',
      'sm:grid-cols-2',
      'lg:grid-cols-3',
      'xl:grid-cols-4',
      'stagger-parents',
    );

    expect(grid?.children).toHaveLength(2);
    expect(grid?.children[0]).toHaveClass('animate-rise-lg');
    expect(screen.getByText('One')).toBeInTheDocument();
    expect(screen.getByText('Two')).toBeInTheDocument();
  });

  it('renders nothing inside the grid when there are no projects', () => {
    const { container } = render(<ArchiveGrid projects={[]} renderCard={() => <div />} />);
    const grid = container.firstElementChild?.firstElementChild;
    expect(grid?.children).toHaveLength(0);
  });
});
