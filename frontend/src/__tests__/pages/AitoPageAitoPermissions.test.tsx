/**
 * AitoPage gates its board WRITE controls on aito:* permissions (T-019).
 *
 * The page itself carried zero permission checks: New project, Import quote
 * and the panel's delete control were always rendered, even for a signed-in
 * user the backend would 403 the moment they clicked (routes/aito.py enforces
 * Permission.AITO_CREATE / AITO_DELETE). This mirrors CalculatorPage's own
 * gating philosophy (`hasPermission` from useAuth) and only that: the board
 * itself (and its trash/done archives) stay ungated, matching how sibling
 * pages leave read access alone and only hide what the user could not
 * actually use.
 *
 * `hasPermission` returns true for everything when auth is disabled (see
 * AuthContext), so the first case below pins that a default single-user
 * install sees no difference at all.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockUseAuth = {
  user: { id: 1, username: 'operator', permissions: [] as string[] },
  authEnabled: true,
  requiresSetup: false,
  loading: false,
  isAdmin: false,
  login: vi.fn(),
  loginWithToken: vi.fn(),
  logout: vi.fn(),
  refreshUser: vi.fn(),
  refreshAuth: vi.fn(),
  hasPermission: vi.fn((_permission: string) => true),
  hasAnyPermission: vi.fn(() => true),
  hasAllPermissions: vi.fn(() => true),
  canModify: vi.fn(() => true),
};

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => mockUseAuth };
});

import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';

const project = {
  id: 12,
  description: 'Support GoPro',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: '+33 6 12 34 56 78',
  // Explicit, not left undefined: `quote_status: null` is what makes
  // QuoteStatusActions render its "Mark as sent" button, and `quote_id` +
  // `quote_number` together are what make the Quote card (and, inside it,
  // SendQuoteButton) render at all — see ProjectDetailPanel.tsx's own gate
  // on `project.quote_number`. Both are needed for this file's T-048 tests
  // to actually find a control to assert against.
  quote_id: 555,
  quote_number: 'QT-2026-001',
  quote_status: null,
  flag: null,
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

// A released Done-column card (move_lock: null), for the restore-button gate.
const doneProject = {
  ...project,
  id: 30,
  description: 'Finished bracket',
  column: 'done',
  status: 'active',
  quote_status: 'accepted',
};

// A trashed card, for the same gate in the other archive.
const trashProject = {
  ...project,
  id: 31,
  description: 'Deleted bracket',
  status: 'deleted',
};

// A billed variant of `project`, for the Send-invoice permission gate below
// (T-051). `quote_invoiced: true` is what flips InvoiceCard's own
// `mayHaveInvoice` gate to true — without it the card's query stays disabled
// and it self-hides, which is exactly why the read-only assertions elsewhere
// in this file never had to think about the invoice card at all.
const invoicedProject = {
  ...project,
  quote_invoiced: true,
  quote_sync_state: 'idle' as const,
};

const invoice = {
  id: 'INV-7',
  number: 'INV-00087',
  date: '2026-08-18',
  due_date: '2026-09-18',
  total: 45000,
  balance: 0,
  currency_code: 'XPF',
  status: 'paid',
  url: 'https://books.zoho.com/app#/invoices/INV-7',
  invoice_count: 1,
};

// One task, for the task-edit (add/remove) matrix below.
const task = {
  id: 101,
  project_id: 12,
  position: 0,
  title: 'Bracket mount',
  scan_description: null,
  scan_cost: 500,
  modelisation_cost: null,
  usinage_cost: null,
  impression_printer_id: null,
  impression_filament_id: null,
  impression_weight_g: null,
  impression_time_min: null,
  impression_quantity: 1,
  impression_color: null,
  impression_cost: null,
  scan_done: false,
  modelisation_done: false,
  impression_done: false,
  usinage_done: false,
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
};

const openCard = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole('button', { name: /Support GoPro/ }));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  mockUseAuth.hasPermission.mockReset();

  server.use(
    http.get('/api/v1/aito/', () => HttpResponse.json([project])),
    http.delete('/api/v1/aito/:id', () => new HttpResponse(null, { status: 204 })),
    http.get('/api/v1/aito/12/tasks', () => HttpResponse.json([task])),
  );
});

describe('AitoPage — aito:* permission gating (T-019)', () => {
  it('auth disabled: shows New project, Import quote and the delete control', async () => {
    mockUseAuth.authEnabled = false;
    mockUseAuth.hasPermission.mockImplementation(() => true); // AuthContext semantics: auth disabled = allow all

    const user = userEvent.setup();
    render(<AitoPage />);

    expect(await screen.findByRole('button', { name: 'Project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();

    await openCard(user);
    expect(await screen.findByLabelText('Move to trash')).toBeInTheDocument();
  });

  it('auth enabled + every aito permission granted: shows New project, Import quote and the delete control', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) =>
      ['aito:read', 'aito:create', 'aito:update', 'aito:delete'].includes(permission),
    );

    const user = userEvent.setup();
    render(<AitoPage />);

    expect(await screen.findByRole('button', { name: 'Project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();

    await openCard(user);
    expect(await screen.findByLabelText('Move to trash')).toBeInTheDocument();
  });

  it('auth enabled + read-only (aito:read only): hides New project, Import quote and the delete control', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) => permission === 'aito:read');

    const user = userEvent.setup();
    render(<AitoPage />);

    // The board itself is not gated — a read-only user still sees their work,
    // just none of the controls that would only 403.
    expect(await screen.findByRole('button', { name: /Support GoPro/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();

    await openCard(user);
    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.queryByLabelText('Move to trash')).not.toBeInTheDocument());
  });
});

/**
 * T-048: the rest of the board's write surface — dragging a card, and the
 * detail panel's flag/quote-status/send-quote/task-edit/restore controls —
 * carried no permission check at all. Every one of those fires
 * Permission.AITO_UPDATE on the backend (see AitoPage.tsx's own doc), except
 * adding/removing a task, which fire AITO_CREATE/AITO_DELETE respectively —
 * the two independence tests below pin that these three permissions are
 * checked separately, not folded into one.
 */
describe('AitoPage — aito:update permission gating (T-048)', () => {
  it('read-only (aito:read only): disables drag on the board', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) => permission === 'aito:read');

    render(<AitoPage />);

    await screen.findByRole('button', { name: /Support GoPro/ });
    expect(screen.queryByRole('button', { name: /drag to reorder/i })).not.toBeInTheDocument();
  });

  it('auth enabled + every aito permission granted: keeps drag enabled on the board', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) =>
      ['aito:read', 'aito:create', 'aito:update', 'aito:delete'].includes(permission),
    );

    render(<AitoPage />);

    expect(await screen.findByRole('button', { name: /drag to reorder/i })).toBeInTheDocument();
  });

  it('read-only (aito:read only): hides flag, quote-status, send-quote and add-task in the detail panel', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) => permission === 'aito:read');

    const user = userEvent.setup();
    render(<AitoPage />);

    await openCard(user);
    const dialog = await screen.findByRole('dialog');

    // Scoped to the dialog: the card's own board-level quick action (visible
    // in the devis column regardless of aito:update — out of scope for this
    // task, see AitoPage.tsx's doc) shares the exact same "Mark as sent"
    // accessible name as the panel's QuoteStatusActions button.
    expect(within(dialog).queryByTestId('flag-control')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /send quote/i })).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: /add task/i })).not.toBeInTheDocument());
    await waitFor(() => expect(within(dialog).queryByLabelText('Remove task')).not.toBeInTheDocument());
  });

  it('read-only (aito:read only): hides send-invoice but keeps print-invoice in the detail panel (T-051)', async () => {
    // The Quote card's Send button self-hides for a read-only user via the
    // fixture above having no invoice at all — that proves nothing about the
    // Invoice card, whose own query is gated on `quote_invoiced` rather than
    // on any prop. This is the one case in the file where the card is made
    // to actually render, so the gate on its own Send button has something
    // to hide.
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) => permission === 'aito:read');
    server.use(
      http.get('/api/v1/aito/', () => HttpResponse.json([invoicedProject])),
      http.get('/api/v1/aito/12/invoice', () => HttpResponse.json(invoice)),
    );

    const user = userEvent.setup();
    render(<AitoPage />);

    await openCard(user);
    const dialog = await screen.findByRole('dialog');

    // Print needs no permission gate (see InvoicePrintButton) and must still
    // be there once the invoice loads — a Send-only regression that also
    // swallowed Print would be a worse bug than the one this test exists for.
    expect(await within(dialog).findByRole('button', { name: /print invoice/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /send invoice/i })).not.toBeInTheDocument();
  });

  it('auth enabled + every aito permission granted: shows flag, quote-status, send-quote, add-task and remove-task in the detail panel', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) =>
      ['aito:read', 'aito:create', 'aito:update', 'aito:delete'].includes(permission),
    );

    const user = userEvent.setup();
    render(<AitoPage />);

    await openCard(user);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByTestId('flag-control')).toBeInTheDocument();
    expect(await within(dialog).findByRole('button', { name: /mark as sent/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /send quote/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /add task/i })).toBeInTheDocument();
    expect(await within(dialog).findByLabelText('Remove task')).toBeInTheDocument();
  });

  it('aito:create/aito:delete granted, aito:update denied: keeps add-task and remove-task, still hides flag/quote-status/send-quote', async () => {
    // Proves canUpdate is read INDEPENDENTLY of canCreate/canDelete: a user
    // who can create and delete tasks but not update the project must still
    // lose every aito:update-gated control.
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) =>
      ['aito:read', 'aito:create', 'aito:delete'].includes(permission),
    );

    const user = userEvent.setup();
    render(<AitoPage />);

    await openCard(user);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByTestId('flag-control')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /send quote/i })).not.toBeInTheDocument();
    expect(await within(dialog).findByRole('button', { name: /add task/i })).toBeInTheDocument();
    expect(await within(dialog).findByLabelText('Remove task')).toBeInTheDocument();
  });

  it('aito:update granted, aito:create/aito:delete denied: keeps flag/quote-status/send-quote, hides add-task and remove-task', async () => {
    // The other half of the same independence proof: aito:update alone must
    // not also unlock the task create/delete routes, which enforce their own
    // permissions (AITO_CREATE / AITO_DELETE — routes/aito.py:1503/1636).
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) => ['aito:read', 'aito:update'].includes(permission));

    const user = userEvent.setup();
    render(<AitoPage />);

    await openCard(user);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByTestId('flag-control')).toBeInTheDocument();
    expect(await within(dialog).findByRole('button', { name: /mark as sent/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /send quote/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /add task/i })).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).queryByLabelText('Remove task')).not.toBeInTheDocument());
  });

  it('read-only (aito:read only): hides restore in the Done archive', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) => permission === 'aito:read');
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json([project, doneProject])));

    const user = userEvent.setup();
    render(<AitoPage />);

    await user.click(await screen.findByRole('button', { name: /show done/i }));
    expect(await screen.findByText('Finished bracket')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /move back to finish/i })).not.toBeInTheDocument();
  });

  it('auth enabled + every aito permission granted: shows restore in the Done archive', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) =>
      ['aito:read', 'aito:create', 'aito:update', 'aito:delete'].includes(permission),
    );
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json([project, doneProject])));

    const user = userEvent.setup();
    render(<AitoPage />);

    await user.click(await screen.findByRole('button', { name: /show done/i }));
    expect(await screen.findByText('Finished bracket')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /move back to finish/i })).toBeInTheDocument();
  });

  it('read-only (aito:read only): hides restore in the Trash archive', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) => permission === 'aito:read');
    server.use(http.get('/api/v1/aito/trash', () => HttpResponse.json([trashProject])));

    const user = userEvent.setup();
    render(<AitoPage />);

    await user.click(await screen.findByRole('button', { name: 'Trash' }));
    expect(await screen.findByText('Deleted bracket')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });

  it('auth enabled + every aito permission granted: shows restore in the Trash archive', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) =>
      ['aito:read', 'aito:create', 'aito:update', 'aito:delete'].includes(permission),
    );
    server.use(http.get('/api/v1/aito/trash', () => HttpResponse.json([trashProject])));

    const user = userEvent.setup();
    render(<AitoPage />);

    await user.click(await screen.findByRole('button', { name: 'Trash' }));
    expect(await screen.findByText('Deleted bracket')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('auth disabled: keeps drag enabled and every detail-panel/restore control visible', async () => {
    // Same AuthContext semantics `hasPermission` relies on everywhere else in
    // this file: auth disabled means allow-all, so a default single-user
    // install must see no difference at all from this task.
    mockUseAuth.authEnabled = false;
    mockUseAuth.hasPermission.mockImplementation(() => true);
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json([project, doneProject])));

    const user = userEvent.setup();
    render(<AitoPage />);

    expect(await screen.findByRole('button', { name: /drag to reorder/i })).toBeInTheDocument();

    await openCard(user);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('flag-control')).toBeInTheDocument();
    expect(await within(dialog).findByRole('button', { name: /mark as sent/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /send quote/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /add task/i })).toBeInTheDocument();
    expect(await within(dialog).findByLabelText('Remove task')).toBeInTheDocument();
  });
});
