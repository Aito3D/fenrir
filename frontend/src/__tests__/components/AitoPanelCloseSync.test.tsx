import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ProjectDetailPanel } from '../../components/aito/ProjectDetailPanel';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

/** Closing an edited card asks the backend for a Zoho push.
 *
 *  The backend's edit window is fixed — later edits do not extend it — so the
 *  push a card owes Books can fire while the operator is still filling a task
 *  in, and the one that would carry the finished content then waits out the
 *  full poll interval. The panel closing is the moment the card is known to be
 *  finished, so that is when it asks. */

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
  client_is_company: true,
  client_social_network: null,
  client_social_handle: null,
  quote_id: 'E1',
  quote_number: 'DEV26-1',
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
  quote_accepted_at: null,
  quote_sync_state: 'idle',
  quote_invoiced: false,
  flag: null,
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

let syncAitoProject: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  syncAitoProject = vi.spyOn(api, 'syncAitoProject').mockResolvedValue({ ...project, quote_sync_state: 'pending' });
  vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
  vi.spyOn(api, 'getAitoTasks').mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProjectDetailPanel close sync', () => {
  it('asks for a push when a card whose description was edited closes', async () => {
    vi.spyOn(api, 'updateAitoProject').mockResolvedValue({ ...project, description: 'Changed', version: 2 });
    const user = userEvent.setup();
    const { unmount } = render(
      <ProjectDetailPanel canCreate canUpdate canDelete project={project} onClose={vi.fn()} onDelete={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: /edit description/i }));
    const box = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA')!;
    await user.clear(box);
    await user.type(box, 'Changed');
    await user.tab();
    await waitFor(() => expect(api.updateAitoProject).toHaveBeenCalled());

    unmount();

    await waitFor(() => expect(syncAitoProject).toHaveBeenCalledWith(12));
  });

  it('costs nothing when a card is opened and closed without an edit', async () => {
    // A push spends a Books call, and the poll interval exists because that
    // quota is small. Reading a card must be free.
    const { unmount } = render(
      <ProjectDetailPanel canCreate canUpdate canDelete project={project} onClose={vi.fn()} onDelete={vi.fn()} />,
    );
    await screen.findByRole('region', { name: /activity/i });

    unmount();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(syncAitoProject).not.toHaveBeenCalled();
  });

  it('never leaves the card stuck open when the push request fails', async () => {
    // Fire-and-forget: the close already happened, and a failed queue attempt
    // is recoverable (the next edit re-queues the card, and the 300s sweep
    // reconciles it anyway). What it must NOT do is reject unhandled.
    vi.spyOn(api, 'updateAitoProject').mockResolvedValue({ ...project, description: 'Changed', version: 2 });
    syncAitoProject.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    const { unmount } = render(
      <ProjectDetailPanel canCreate canUpdate canDelete project={project} onClose={vi.fn()} onDelete={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: /edit description/i }));
    const box = screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA')!;
    await user.clear(box);
    await user.type(box, 'Changed');
    await user.tab();
    await waitFor(() => expect(api.updateAitoProject).toHaveBeenCalled());

    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => {
      rejections.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener('unhandledrejection', onRejection);
    unmount();

    await waitFor(() => expect(syncAitoProject).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    window.removeEventListener('unhandledrejection', onRejection);
    expect(rejections).toEqual([]);
  });
});
