/**
 * The project page's Orders card: every Aito order with a task linked to this
 * project, grouped by order, each linking to its board card; and the
 * "New order" entry into the board's create drawer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { ProjectOrdersCard } from '../../../../components/projects/aito/ProjectOrdersCard';
import { api } from '../../../../api/client';
import type { ProjectOrderTask } from '../../../../api/client';

const granted = new Set<string>();
vi.mock('../../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => ({ hasPermission: (p: string) => granted.has(p) }) };
});

function order(overrides: Partial<ProjectOrderTask>): ProjectOrderTask {
  return {
    task_id: 1,
    task_title: 'Support',
    order_id: 41,
    order_description: 'Support GoPro',
    client_name: 'ACME SARL',
    board_column: 'print',
    created_at: '2026-09-12T09:14:00',
    deliveries: [],
    ...overrides,
  };
}

function serve(orders: ProjectOrderTask[]) {
  server.use(http.get('/api/v1/projects/7/orders', () => HttpResponse.json({ orders })));
}

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  granted.clear();
  ['projects:read', 'aito:read', 'aito:create'].forEach((p) => granted.add(p));
});

describe('ProjectOrdersCard', () => {
  it('groups tasks by order with client, column, task titles and delivery chips', async () => {
    serve([
      order({
        task_id: 1,
        task_title: 'Support',
        deliveries: [
          { id: 5, item_id: 2, item_name: 'Support', section: 'impression', number: 3, status: 'approved' },
          { id: 6, item_id: 3, item_name: 'Capot', section: 'modelisation', number: 1, status: 'approved' },
        ],
      }),
      order({ task_id: 2, task_title: 'Bras', deliveries: [] }),
      order({ task_id: 3, task_title: null, order_id: 52, client_name: 'Moana', board_column: 'devis', deliveries: [] }),
    ]);
    render(<ProjectOrdersCard projectId={7} />);

    const first = await screen.findByRole('link', { name: /Order #41/ });
    expect(first).toHaveAttribute('href', '/aito?card=41');
    const group41 = first.closest('[data-order-id]') as HTMLElement;
    expect(group41).toHaveTextContent('ACME SARL');
    expect(group41).toHaveTextContent('Printing');
    expect(within(group41).getByText('Support R3')).toBeInTheDocument();
    expect(within(group41).getByText('Capot R1')).toBeInTheDocument();
    expect(within(group41).getByText('Bras')).toBeInTheDocument();

    const second = screen.getByRole('link', { name: /Order #52/ });
    expect(second).toHaveAttribute('href', '/aito?card=52');
    const group52 = second.closest('[data-order-id]') as HTMLElement;
    expect(group52).toHaveTextContent('Moana');
    expect(group52).toHaveTextContent('Quote');
    expect(document.querySelectorAll('[data-order-id]')).toHaveLength(2);
  });

  it('shows the empty state when no order uses the project', async () => {
    serve([]);
    render(<ProjectOrdersCard projectId={7} />);
    expect(await screen.findByText('No order uses this project yet')).toBeInTheDocument();
  });

  it('"New order" points at the board with the project as seed', async () => {
    serve([]);
    render(<ProjectOrdersCard projectId={7} />);
    expect(await screen.findByRole('link', { name: /New order/ })).toHaveAttribute('href', '/aito?newFromProject=7');
  });

  it('hides "New order" without aito:create', async () => {
    granted.delete('aito:create');
    serve([]);
    render(<ProjectOrdersCard projectId={7} />);
    await screen.findByText('No order uses this project yet');
    expect(screen.queryByRole('link', { name: /New order/ })).not.toBeInTheDocument();
  });

  it('renders nothing and fetches nothing without aito:read', async () => {
    granted.delete('aito:read');
    const hit = vi.fn();
    server.use(http.get('/api/v1/projects/7/orders', () => { hit(); return HttpResponse.json({ orders: [] }); }));
    const fetchOrders = vi.spyOn(api, 'getProjectOrders');
    const { rerender } = render(<ProjectOrdersCard projectId={7} />);
    // An enabled query calls its fetcher as the card mounts (inside render's act), so the
    // spy is decisive here; flush once more anyway.
    await act(async () => {});
    expect(fetchOrders).not.toHaveBeenCalled();
    expect(hit).not.toHaveBeenCalled();
    expect(screen.queryByText('Orders')).not.toBeInTheDocument();
    // Positive control: granted the permission, the same card fetches through the same spy.
    granted.add('aito:read');
    rerender(<ProjectOrdersCard projectId={7} />);
    await waitFor(() => expect(hit).toHaveBeenCalledTimes(1));
    expect(fetchOrders).toHaveBeenCalledTimes(1);
  });
});
