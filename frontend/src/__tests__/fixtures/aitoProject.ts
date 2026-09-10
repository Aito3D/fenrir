import type { AitoProject } from '../../api/client';

/**
 * A project with every field the board cache needs, defaulted so a test can
 * override only what it cares about.
 *
 * This is the shared base used by `AitoQuoteStatusActions.test.tsx` and
 * `AitoTrackingLinkControl.test.tsx`. `AitoQuoteStatusActions.test.tsx` wraps
 * this with its own `task_pending` defaulting (see that file) — this base
 * form applies overrides verbatim, with no such fallback.
 */
export function makeProject(overrides: Partial<AitoProject> = {}): AitoProject {
  const base: AitoProject = {
    id: 1,
    description: 'Support de caméra',
    column: 'devis',
    position: 0,
    status: 'active',
    client_id: 'z1',
    client_name: 'ACME SARL',
    client_phone: '+689-87123456',
    client_email: 'hi@acme.pf',
    client_is_company: null,
    client_social_network: null,
    client_social_handle: null,
    quote_id: 'EST-1',
    quote_number: null,
    quote_date: null,
    quote_total: null,
    quote_url: null,
    quote_salesperson: null,
    quote_status: 'draft',
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
    version: 1,
    created_at: '2026-07-27T00:00:00',
    updated_at: '2026-07-27T00:00:00',
  };
  return { ...base, ...overrides };
}
