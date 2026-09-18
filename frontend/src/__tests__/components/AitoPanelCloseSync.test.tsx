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
  quote_sent_at: null,
  invoice_status: null,
  invoice_balance: null,
  invoice_due_date: null,
  invoice_checked_at: null,
  quote_sync_state: 'idle',
  quote_invoiced: false,
  flag: null,
  client_contacted_at: null,
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
    // Settled on the tasks fetch, which the panel always issues; the Activity
    // rail sits behind a tab and is not mounted on open.
    await waitFor(() => expect(api.getAitoTasks).toHaveBeenCalled());

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

/** The same route, reached the other way: the Force sync control the Billing
 *  card offers on a card the worker REFUSED to push.
 *
 *  A refusal locks the card (today: a tax-exclusive estimate, which Aito's
 *  tax-inclusive costs cannot be written onto without inflating the total by
 *  the tax rate), and a locked card leaves the 300s sweep permanently — so
 *  once the estimate has been fixed in Books there is nothing left running
 *  that would ever look at it again. This control is how the app is told to
 *  look. It forces the ATTEMPT, not the write: the route only marks the card
 *  pending, and every guard the worker owns still decides what that means. */
const TAX_EXCLUSIVE =
  'This quote is tax-exclusive; Aito costs are tax-inclusive and cannot be pushed without inflating the total';

const blocked: AitoProject = {
  ...project,
  quote_sync_state: 'locked',
  quote_invoiced: false,
  quote_sync_error: TAX_EXCLUSIVE,
};

describe('ProjectDetailPanel force sync', () => {
  it('queues the card for a push, through the sync route and nothing else', async () => {
    // Not a PATCH: re-saving the unchanged description would be the only
    // "edit" available here, and it records a project.updated for a write the
    // operator never made — plus it carries a version guard that can 409
    // against a peer for no reason at all.
    const updateAitoProject = vi.spyOn(api, 'updateAitoProject');
    const user = userEvent.setup();
    render(
      <ProjectDetailPanel canCreate canUpdate canDelete project={blocked} onClose={vi.fn()} onDelete={vi.fn()} />,
    );

    await user.click(await screen.findByRole('button', { name: 'Force sync' }));

    await waitFor(() => expect(syncAitoProject).toHaveBeenCalledWith(12));
    expect(syncAitoProject).toHaveBeenCalledTimes(1);
    expect(updateAitoProject).not.toHaveBeenCalled();
  });

  it('offers nothing to press on an invoiced card, which no re-attempt can clear', async () => {
    render(
      <ProjectDetailPanel
        canCreate
        canUpdate
        canDelete
        project={{ ...project, quote_sync_state: 'locked', quote_invoiced: true, quote_sync_error: null }}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(await screen.findByText('Quote invoiced')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Force sync' })).not.toBeInTheDocument();
  });

  it('says so when the queue request fails, rather than looking like it worked', async () => {
    // The close-sync above is fire-and-forget on purpose — the card is already
    // gone and the next edit or sweep recovers it. This one is a button
    // someone pressed, so a failure that changed nothing has to reach them.
    syncAitoProject.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(
      <ProjectDetailPanel canCreate canUpdate canDelete project={blocked} onClose={vi.fn()} onDelete={vi.fn()} />,
    );

    await user.click(await screen.findByRole('button', { name: 'Force sync' }));

    expect(await screen.findByText('Sync failed')).toBeInTheDocument();
  });
});
