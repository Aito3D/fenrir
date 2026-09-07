import { describe, it, expect } from 'vitest';
import { followups, daysSince, FOLLOWUP_KEYS } from '../../utils/aitoFollowups';
import type { AitoProject } from '../../api/client';

const NOW = Date.parse('2026-09-10T12:00:00Z');
const TODAY = '2026-09-10';
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString().replace('Z', '');

let nextId = 1;
function project(overrides: Partial<AitoProject>): AitoProject {
  return {
    id: nextId++,
    description: 'x',
    column: 'devis',
    position: 0,
    status: 'active',
    client_id: 'z1',
    client_name: 'ACME',
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
    tracking_url: null,
    tracking_configured: false,
    version: 1,
    created_at: ago(30),
    updated_at: ago(1),
    ...overrides,
  };
}

const T = { quoteDays: 5, pickupDays: 7 };
const run = (projects: AitoProject[]) => followups(projects, T, NOW, TODAY);

describe('daysSince', () => {
  it('floors whole days and never goes negative', () => {
    expect(daysSince(ago(2.9), NOW)).toBe(2);
    expect(daysSince(ago(-1), NOW)).toBe(0);
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince('nope', NOW)).toBeNull();
  });
});

describe('quoteOut', () => {
  it('counts sent and viewed quotes at the threshold, not a day earlier', () => {
    const inside = project({ quote_status: 'sent', quote_sent_at: ago(5) });
    const early = project({ quote_status: 'viewed', quote_sent_at: ago(4.5) });
    const r = run([inside, early]);
    expect(r.quoteOut.ids).toEqual([inside.id]);
    expect(r.quoteOut.maxDays).toBe(5);
  });
  it('counts an expired quote from day zero and ignores decided or unstamped ones', () => {
    const expired = project({ quote_status: 'expired', quote_sent_at: ago(0.2) });
    const accepted = project({ quote_status: 'accepted', quote_sent_at: ago(20) });
    const unstamped = project({ quote_status: 'sent', quote_sent_at: null });
    const unstampedExpired = project({ quote_status: 'expired', quote_sent_at: null });
    expect(run([expired, accepted, unstamped, unstampedExpired]).quoteOut.ids).toEqual([expired.id]);
  });
});

describe('notTold', () => {
  it('is every Finish card with no contact, aged from its anchor', () => {
    const a = project({ column: 'finish', client_contacted_at: null, created_at: ago(9) });
    const b = project({ column: 'finish', client_contacted_at: null, quote_status: 'accepted', quote_accepted_at: ago(3), created_at: ago(40) });
    const told = project({ column: 'finish', client_contacted_at: ago(1) });
    const r = run([a, b, told]);
    expect(r.notTold.ids).toEqual([a.id, b.id]);
    expect(r.notTold.maxDays).toBe(9);
  });
});

describe('notCollected', () => {
  it('needs Finish, a contact at least N days old, and no shipment', () => {
    const inside = project({ column: 'finish', client_contacted_at: ago(7) });
    const fresh = project({ column: 'finish', client_contacted_at: ago(6.9) });
    const shipped = project({ column: 'finish', client_contacted_at: ago(20), shipping_island: 'tahiti' });
    const printing = project({ column: 'print', client_contacted_at: ago(20) });
    expect(run([inside, fresh, shipped, printing]).notCollected.ids).toEqual([inside.id]);
  });
});

describe('unpaid', () => {
  it('needs a balance and a due date strictly before today; partial payments count', () => {
    const overdue = project({ invoice_balance: 40, invoice_due_date: '2026-09-09' });
    const dueToday = project({ invoice_balance: 40, invoice_due_date: '2026-09-10' });
    const paid = project({ invoice_balance: 0, invoice_due_date: '2026-01-01' });
    const unread = project({ invoice_balance: null, invoice_due_date: null });
    expect(run([overdue, dueToday, paid, unread]).unpaid.ids).toEqual([overdue.id]);
    expect(run([overdue]).unpaid.maxDays).toBe(1);
  });
  it('counts a calendar-day span for an older due date', () => {
    const wayOverdue = project({ invoice_balance: 40, invoice_due_date: '2026-09-01' });
    expect(run([wayOverdue]).unpaid.maxDays).toBe(9);
  });
  it('drops a non-ISO due date instead of always treating it as overdue', () => {
    const nonIso = project({ invoice_balance: 40, invoice_due_date: '10/02/2026' });
    const r = run([nonIso]);
    expect(r.unpaid.ids).toEqual([]);
    expect(r.unpaid.maxDays).toBe(0);
    expect(Number.isNaN(r.unpaid.maxDays)).toBe(false);
  });
  it('drops an empty-string due date', () => {
    const blank = project({ invoice_balance: 40, invoice_due_date: '' });
    expect(run([blank]).unpaid.ids).toEqual([]);
  });
  it('still counts an ISO overdue date with the right day span alongside a non-ISO one', () => {
    const overdue = project({ invoice_balance: 40, invoice_due_date: '2026-09-01' });
    const nonIso = project({ invoice_balance: 40, invoice_due_date: '10/02/2026' });
    const r = run([overdue, nonIso]);
    expect(r.unpaid.ids).toEqual([overdue.id]);
    expect(r.unpaid.maxDays).toBe(9);
  });
});

describe('scope and order', () => {
  it('ignores trashed and Done cards, sorts longest first, and keeps the key order', () => {
    const late = project({ quote_status: 'sent', quote_sent_at: ago(20) });
    const later = project({ quote_status: 'sent', quote_sent_at: ago(8) });
    const done = project({ column: 'done', quote_status: 'sent', quote_sent_at: ago(40) });
    const trashed = project({ status: 'deleted', quote_status: 'sent', quote_sent_at: ago(40) });
    const r = run([later, late, done, trashed]);
    expect(r.quoteOut.ids).toEqual([late.id, later.id]);
    expect(Object.keys(r)).toEqual(FOLLOWUP_KEYS);
    expect(r.unpaid.ids).toEqual([]);
    expect(r.unpaid.maxDays).toBe(0);
  });
});
