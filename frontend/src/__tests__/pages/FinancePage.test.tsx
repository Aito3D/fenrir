/**
 * Tests for FinancePage (T-010).
 *
 * Covers the pieces the audit flagged as completely uncovered:
 *  - editing a wallet transaction (amount / description / cost-center
 *    "unchanged" semantics via omitted PATCH keys)
 *  - deleting a transaction (confirm modal + real DELETE + list refetch)
 *  - parseBudgetValue(): exercised only through the real <input type="number">
 *    in the "Create cost center" modal, never by calling the (unexported)
 *    helper directly
 *  - parsePrintChargeDescription(): the [aborted:]/[failed:]/[cancelled:]
 *    tag-stripping and badge rendering for print_charge transactions
 *
 * No production file is modified by this suite. Auth stays disabled (the
 * default MSW `auth/config` handler), which grants every permission via
 * AuthContext's `hasPermission` short-circuit — see AuthContext.tsx:230
 * (`if (!authEnabled) return true;`). That's enough to reach every gated
 * control in this file; the current `user` stays null under auth-disabled,
 * which only affects the (untested-here) private-cost-center owner label.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { FinancePage } from '../../pages/FinancePage';
import type { CostCenterSummary, UserSlim, WalletTransaction } from '../../api/client';

afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCostCenter(overrides: Partial<CostCenterSummary> = {}): CostCenterSummary {
  return {
    id: 10,
    name: 'Team Alpha',
    is_private: false,
    owner_user_id: null,
    is_active: true,
    total_balance: 100,
    total_budget: null,
    monthly_budget: 200,
    budget_mode: 'monthly',
    budget_limit: 200,
    budget_used: 50,
    budget_available: 150,
    can_print: true,
    ...overrides,
  };
}

function makeTransaction(overrides: Partial<WalletTransaction> = {}): WalletTransaction {
  return {
    id: 1,
    user_id: 1,
    cost_center_id: null,
    transaction_type: 'deposit',
    amount: 50,
    balance_after: 50,
    description: 'Initial deposit',
    created_by_user_id: null,
    print_run_id: null,
    print_archive_id: null,
    print_queue_id: null,
    created_at: '2026-01-01T10:00:00Z',
    ...overrides,
  };
}

const USERS: UserSlim[] = [
  { id: 1, username: 'alice' },
  { id: 2, username: 'bob' },
];

/** Finds the modal card <div> (header + body) for a FinanceModal by its title. */
function modalFor(headingName: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: headingName });
  // h3 -> header div -> modal card div (see FinancePage.tsx's FinanceModal).
  return heading.parentElement!.parentElement as HTMLElement;
}

function jsonHandler<T>(path: string, data: T) {
  return http.get(path, () => HttpResponse.json(data));
}

/** Base handlers every test needs: balance, personal+admin tx lists, cost centers, users. */
function baseHandlers(opts: {
  balance?: number;
  currency?: string;
  transactions?: WalletTransaction[];
  costCenters?: CostCenterSummary[];
  users?: UserSlim[];
}) {
  const {
    balance = 50,
    currency = 'EUR',
    transactions = [],
    costCenters = [],
    users = USERS,
  } = opts;

  return [
    jsonHandler('/api/v1/finance/me/balance', {
      user_id: 1,
      balance,
      currency,
      updated_at: '2026-01-01T00:00:00Z',
    }),
    http.get('/api/v1/finance/me/transactions', () =>
      HttpResponse.json({ items: transactions, total: transactions.length, limit: 50, offset: 0 })
    ),
    http.get('/api/v1/finance/transactions', () =>
      HttpResponse.json({ items: transactions, total: transactions.length, limit: 50, offset: 0 })
    ),
    http.get('/api/v1/finance/cost-centers/mine', () => HttpResponse.json(costCenters)),
    http.get('/api/v1/finance/cost-centers', () => HttpResponse.json(costCenters)),
    http.get('/api/v1/finance/cost-centers/:id', ({ params }) => {
      const center = costCenters.find((c) => String(c.id) === params.id);
      return HttpResponse.json({ ...(center ?? makeCostCenter()), members: [] });
    }),
    jsonHandler('/api/v1/users/slim', users),
  ];
}

async function switchToAdminView(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Admin view' }, { timeout: 5000 }));
}

// ---------------------------------------------------------------------------
// Currency / balance formatting
// ---------------------------------------------------------------------------

describe('FinancePage — balance formatting', () => {
  it('formats the personal balance with the currency symbol and two decimals (EUR)', async () => {
    server.use(...baseHandlers({ balance: 1234.5, currency: 'EUR' }));
    render(<FinancePage />);

    expect(await screen.findByText('€1234.50', {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it('still uses two decimal places for a currency with no minor unit (XPF) — no currency-aware rounding', async () => {
    server.use(...baseHandlers({ balance: 1000, currency: 'XPF' }));
    render(<FinancePage />);

    // XPF has zero decimal places in real life; the page's .toFixed(2) call
    // does not special-case this, so it renders "FCFP1000.00" rather than
    // "FCFP1000". Pinning the current (naive) behavior, not endorsing it.
    expect(await screen.findByText('FCFP1000.00', {}, { timeout: 5000 })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// parsePrintChargeDescription() — via the "Recent transactions" table
// ---------------------------------------------------------------------------

describe('FinancePage — partial print-charge description parsing', () => {
  it('strips a lowercase [aborted: ...] tag from the description and shows a badge', async () => {
    server.use(
      ...baseHandlers({
        transactions: [
          makeTransaction({
            id: 201,
            transaction_type: 'print_charge',
            amount: -4.25,
            description: 'Benchy [aborted: nozzle jam]',
          }),
        ],
      })
    );
    render(<FinancePage />);

    const row = (await screen.findByText('Benchy', {}, { timeout: 5000 })).closest('tr')!;
    expect(within(row).getByText('Print charge')).toBeInTheDocument();
    expect(within(row).getByText('aborted')).toBeInTheDocument();
    expect(within(row).queryByText(/nozzle jam/)).not.toBeInTheDocument();
    expect(within(row).getByText('-€4.25')).toBeInTheDocument();
  });

  it('strips an uppercase [FAILED: ...] tag case-insensitively and lower-cases the badge', async () => {
    server.use(
      ...baseHandlers({
        transactions: [
          makeTransaction({
            id: 202,
            transaction_type: 'print_charge',
            amount: -1,
            description: 'Vase [FAILED: heater error]',
          }),
        ],
      })
    );
    render(<FinancePage />);

    const row = (await screen.findByText('Vase', {}, { timeout: 5000 })).closest('tr')!;
    // Badge text is lower-cased even though the source tag was uppercase.
    expect(within(row).getByText('failed')).toBeInTheDocument();
    expect(within(row).queryByText(/FAILED/)).not.toBeInTheDocument();
  });

  it('strips a [cancelled: ...] tag from the middle/end of a longer description', async () => {
    server.use(
      ...baseHandlers({
        transactions: [
          makeTransaction({
            id: 203,
            transaction_type: 'print_charge',
            amount: -2.5,
            description: 'Gear housing [cancelled: manual stop]',
          }),
        ],
      })
    );
    render(<FinancePage />);

    const row = (await screen.findByText('Gear housing', {}, { timeout: 5000 })).closest('tr')!;
    expect(within(row).getByText('cancelled')).toBeInTheDocument();
  });

  it('does not add a badge or touch the text for a print_charge with no tag', async () => {
    server.use(
      ...baseHandlers({
        transactions: [
          makeTransaction({
            id: 204,
            transaction_type: 'print_charge',
            amount: -3,
            description: 'Plain print job',
          }),
        ],
      })
    );
    render(<FinancePage />);

    const row = (await screen.findByText('Plain print job', {}, { timeout: 5000 })).closest('tr')!;
    expect(within(row).queryByText('aborted')).not.toBeInTheDocument();
    expect(within(row).queryByText('failed')).not.toBeInTheDocument();
    expect(within(row).queryByText('cancelled')).not.toBeInTheDocument();
  });

  it('never parses the tag on non-print_charge transactions (raw text + no badge on a deposit)', async () => {
    server.use(
      ...baseHandlers({
        transactions: [
          makeTransaction({
            id: 205,
            transaction_type: 'deposit',
            amount: 10,
            description: '[aborted: this looks like a tag but is not a print charge]',
          }),
        ],
      })
    );
    render(<FinancePage />);

    const row = (
      await screen.findByText(
        '[aborted: this looks like a tag but is not a print charge]',
        {},
        { timeout: 5000 }
      )
    ).closest('tr')!;
    expect(within(row).getByText('Deposit')).toBeInTheDocument();
    expect(within(row).queryByText('aborted')).not.toBeInTheDocument();
  });

  it('shows "-" only when there is truly no description at all', async () => {
    server.use(
      ...baseHandlers({
        transactions: [
          makeTransaction({
            id: 206,
            transaction_type: 'print_charge',
            amount: -1,
            description: null,
          }),
        ],
      })
    );
    render(<FinancePage />);

    // "Print charge" also appears as an <option> in the Type filter select,
    // so locate the row via its (unique) amount cell instead.
    const row = (await screen.findByText('-€1.00', {}, { timeout: 5000 })).closest('tr')!;
    expect(within(row).getByText('Print charge')).toBeInTheDocument();
    // Columns (personal view): Date, Cost center, Type, Description, Amount,
    // Balance after — Cost center is also "-", so index into cells directly
    // rather than a bare getByText('-') (which would be ambiguous).
    const cells = within(row).getAllByRole('cell');
    expect(cells[3]).toHaveTextContent('-');
    expect(within(row).queryByText('aborted')).not.toBeInTheDocument();
  });

  it('BUG (not fixed): when the description is only the tag, the UI falls back to the raw tagged text instead of "-"', async () => {
    // parsePrintChargeDescription('[failed:]') returns cleanedDescription:
    // null (the whole string was consumed by the tag, then trimmed to '').
    // The render call is `(parsed?.cleanedDescription ?? tx.description) || '-'`.
    // `??` treats `null` as nullish and falls through to `tx.description`,
    // which is the ORIGINAL "[failed:]" string (truthy) — so the tag text
    // reappears verbatim instead of collapsing to "-". A `||` in place of
    // the first `??` would have produced the (probably intended) "-".
    server.use(
      ...baseHandlers({
        transactions: [
          makeTransaction({
            id: 207,
            transaction_type: 'print_charge',
            amount: -1,
            description: '[failed:]',
          }),
        ],
      })
    );
    render(<FinancePage />);

    // "Print charge" also appears as an <option> in the Type filter select,
    // so locate the row via its (unique) raw description text instead.
    const row = (await screen.findByText('[failed:]', {}, { timeout: 5000 })).closest('tr')!;
    expect(within(row).getByText('Print charge')).toBeInTheDocument();
    expect(within(row).getByText('failed')).toBeInTheDocument(); // badge still renders
    // Description column (index 3) shows the raw tag text, not "-".
    const cells = within(row).getAllByRole('cell');
    expect(cells[3]).toHaveTextContent('[failed:]');
  });
});

// ---------------------------------------------------------------------------
// Editing a wallet transaction
// ---------------------------------------------------------------------------

describe('FinancePage — editing a wallet transaction', () => {
  // No cost centers in this block: the cost-center table's own Edit/Delete
  // icon buttons carry a `title` (so an accessible name of "Edit"/"Delete"),
  // which would otherwise collide with the transaction row's icon-only
  // (nameless) buttons and the ConfirmModal's "Delete" button.
  function editHandlers(transactions: WalletTransaction[]) {
    return baseHandlers({ transactions, costCenters: [] });
  }

  it('pre-fills the modal with the raw (untouched) amount, user and description — including the tag', async () => {
    server.use(
      ...editHandlers([
        makeTransaction({
          id: 301,
          user_id: 1,
          cost_center_id: null,
          transaction_type: 'print_charge',
          amount: -4.25,
          description: 'Benchy [aborted: nozzle jam]',
        }),
      ])
    );
    const user = userEvent.setup();
    render(<FinancePage />);
    await switchToAdminView(user);

    const row = (await screen.findByText('Benchy', {}, { timeout: 5000 })).closest('tr')!;
    const rowButtons = within(row).getAllByRole('button');
    await user.click(rowButtons[0]); // Pencil (edit) is the first action button

    const modal = await waitFor(() => modalFor('Edit Transaction'), { timeout: 5000 });
    expect(within(modal).getByRole('spinbutton')).toHaveValue(-4.25);
    // The description textarea keeps the full raw string, tag included.
    expect(within(modal).getByRole('textbox')).toHaveValue('Benchy [aborted: nozzle jam]');
    const [userSelect] = within(modal).getAllByRole('combobox');
    expect(userSelect).toHaveValue('1');
  });

  it('saves an amount change and sends only the changed-relevant fields, closes the modal, and shows a toast', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      ...editHandlers([
        makeTransaction({
          id: 302,
          user_id: 1,
          cost_center_id: null,
          transaction_type: 'deposit',
          amount: 50,
          description: 'Initial deposit',
        }),
      ]),
      http.patch('/api/v1/finance/transactions/:id', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          makeTransaction({ id: 302, amount: 12.34, description: 'Initial deposit' })
        );
      })
    );
    const user = userEvent.setup();
    render(<FinancePage />);
    await switchToAdminView(user);

    const row = (await screen.findByText('Initial deposit', {}, { timeout: 5000 })).closest('tr')!;
    await user.click(within(row).getAllByRole('button')[0]);

    const modal = await waitFor(() => modalFor('Edit Transaction'), { timeout: 5000 });
    const amountInput = within(modal).getByRole('spinbutton');
    await user.clear(amountInput);
    await user.type(amountInput, '12.34');
    await user.click(within(modal).getByRole('button', { name: 'Save' }));

    await waitFor(
      () => {
        expect(capturedBody).toEqual({
          user_id: 1,
          cost_center_id: undefined,
          amount: 12.34,
          description: 'Initial deposit',
        });
      },
      { timeout: 5000 }
    );
    expect(
      await screen.findByText('Transaction updated and ledger recalculated', {}, { timeout: 5000 })
    ).toBeInTheDocument();
    await waitFor(
      () => expect(screen.queryByRole('heading', { name: 'Edit Transaction' })).not.toBeInTheDocument(),
      { timeout: 5000 }
    );
  });

  it('accepts a negative amount with no client-side validation error', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      ...editHandlers([
        makeTransaction({
          id: 303,
          user_id: 1,
          cost_center_id: null,
          transaction_type: 'deposit',
          amount: 50,
          description: 'Initial deposit',
        }),
      ]),
      http.patch('/api/v1/finance/transactions/:id', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makeTransaction({ id: 303, amount: -10 }));
      })
    );
    const user = userEvent.setup();
    render(<FinancePage />);
    await switchToAdminView(user);

    const row = (await screen.findByText('Initial deposit', {}, { timeout: 5000 })).closest('tr')!;
    await user.click(within(row).getAllByRole('button')[0]);

    const modal = await waitFor(() => modalFor('Edit Transaction'), { timeout: 5000 });
    const amountInput = within(modal).getByRole('spinbutton');
    await user.clear(amountInput);
    await user.type(amountInput, '-10');
    await user.click(within(modal).getByRole('button', { name: 'Save' }));

    await waitFor(
      () => {
        expect(capturedBody).not.toBeNull();
        expect((capturedBody as unknown as { amount: number }).amount).toBe(-10);
      },
      { timeout: 5000 }
    );
    expect(screen.queryByText('Amount must be a valid number')).not.toBeInTheDocument();
  });

  it('omits cost_center_id and description from the PATCH when they are cleared (means "no change", not "clear to null")', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      ...editHandlers([
        makeTransaction({
          id: 304,
          user_id: 1,
          cost_center_id: null,
          transaction_type: 'deposit',
          amount: 50,
          description: 'Has a description',
        }),
      ]),
      http.patch('/api/v1/finance/transactions/:id', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makeTransaction({ id: 304, description: null }));
      })
    );
    const user = userEvent.setup();
    render(<FinancePage />);
    await switchToAdminView(user);

    const row = (await screen.findByText('Has a description', {}, { timeout: 5000 })).closest('tr')!;
    await user.click(within(row).getAllByRole('button')[0]);

    const modal = await waitFor(() => modalFor('Edit Transaction'), { timeout: 5000 });
    const descriptionBox = within(modal).getByRole('textbox');
    await user.clear(descriptionBox);
    await user.click(within(modal).getByRole('button', { name: 'Save' }));

    await waitFor(
      () => {
        expect(capturedBody).not.toBeNull();
      },
      { timeout: 5000 }
    );
    // JSON.stringify drops keys whose value is `undefined`, so an
    // intentionally-cleared field never reaches the server as `null` —
    // it simply isn't sent, leaving the stored value untouched server-side.
    expect(capturedBody).not.toHaveProperty('description');
    expect(capturedBody).not.toHaveProperty('cost_center_id');
    expect((capturedBody as unknown as { user_id: number }).user_id).toBe(1);
  });

  it('Cancel closes the modal and sends no request', async () => {
    let patchCalls = 0;
    server.use(
      ...editHandlers([
        makeTransaction({
          id: 305,
          user_id: 1,
          cost_center_id: null,
          transaction_type: 'deposit',
          amount: 50,
          description: 'Initial deposit',
        }),
      ]),
      http.patch('/api/v1/finance/transactions/:id', async () => {
        patchCalls += 1;
        return HttpResponse.json(makeTransaction({ id: 305 }));
      })
    );
    const user = userEvent.setup();
    render(<FinancePage />);
    await switchToAdminView(user);

    const row = (await screen.findByText('Initial deposit', {}, { timeout: 5000 })).closest('tr')!;
    await user.click(within(row).getAllByRole('button')[0]);

    const modal = await waitFor(() => modalFor('Edit Transaction'), { timeout: 5000 });
    const amountInput = within(modal).getByRole('spinbutton');
    await user.clear(amountInput);
    await user.type(amountInput, '999');
    await user.click(within(modal).getByRole('button', { name: 'Cancel' }));

    await waitFor(
      () => expect(screen.queryByRole('heading', { name: 'Edit Transaction' })).not.toBeInTheDocument(),
      { timeout: 5000 }
    );
    expect(patchCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Deleting a transaction
// ---------------------------------------------------------------------------

describe('FinancePage — deleting a transaction', () => {
  function deleteHandlers(items: WalletTransaction[]) {
    return baseHandlers({ transactions: items, costCenters: [] });
  }

  it('Cancel in the confirm modal leaves the transaction in place and sends no request', async () => {
    let deleteCalls = 0;
    server.use(
      ...deleteHandlers([
        makeTransaction({ id: 401, transaction_type: 'deposit', amount: 50, description: 'Keep me' }),
      ]),
      http.delete('/api/v1/finance/transactions/:id', () => {
        deleteCalls += 1;
        return HttpResponse.json({ status: 'ok' });
      })
    );
    const user = userEvent.setup();
    render(<FinancePage />);
    await switchToAdminView(user);

    const row = (await screen.findByText('Keep me', {}, { timeout: 5000 })).closest('tr')!;
    const rowButtons = within(row).getAllByRole('button');
    await user.click(rowButtons[1]); // Trash2 (delete) is the second action button

    await screen.findByText(
      'Delete this transaction? Balances will be recalculated automatically.',
      {},
      { timeout: 5000 }
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(
      () =>
        expect(
          screen.queryByText('Delete this transaction? Balances will be recalculated automatically.')
        ).not.toBeInTheDocument(),
      { timeout: 5000 }
    );
    expect(deleteCalls).toBe(0);
    expect(screen.getByText('Keep me')).toBeInTheDocument();
  });

  it('Confirm sends a real DELETE, shows a toast, and the row disappears once the list refetches', async () => {
    let items = [
      makeTransaction({ id: 402, transaction_type: 'deposit', amount: 50, description: 'Delete me' }),
      makeTransaction({ id: 403, transaction_type: 'deposit', amount: 20, description: 'Survivor' }),
    ];
    let deletedId: number | null = null;
    server.use(
      http.get('/api/v1/finance/me/balance', () =>
        HttpResponse.json({ user_id: 1, balance: 70, currency: 'EUR', updated_at: null })
      ),
      http.get('/api/v1/finance/me/transactions', () =>
        HttpResponse.json({ items, total: items.length, limit: 50, offset: 0 })
      ),
      http.get('/api/v1/finance/transactions', () =>
        HttpResponse.json({ items, total: items.length, limit: 50, offset: 0 })
      ),
      http.get('/api/v1/finance/cost-centers/mine', () => HttpResponse.json([])),
      http.get('/api/v1/finance/cost-centers', () => HttpResponse.json([])),
      jsonHandler('/api/v1/users/slim', USERS),
      http.delete('/api/v1/finance/transactions/:id', ({ params }) => {
        deletedId = Number(params.id);
        items = items.filter((t) => t.id !== deletedId);
        return HttpResponse.json({ status: 'ok' });
      })
    );
    const user = userEvent.setup();
    render(<FinancePage />);
    await switchToAdminView(user);

    const row = (await screen.findByText('Delete me', {}, { timeout: 5000 })).closest('tr')!;
    await user.click(within(row).getAllByRole('button')[1]);

    await screen.findByText(
      'Delete this transaction? Balances will be recalculated automatically.',
      {},
      { timeout: 5000 }
    );
    // Two "Delete" buttons exist while the confirm modal is open (the row's
    // is unnamed/icon-only, so `getByRole('button', {name:'Delete'})` only
    // ever matches the confirm modal's, unambiguously).
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deletedId).toBe(402), { timeout: 5000 });
    expect(await screen.findByText('Transaction deleted', {}, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Delete me')).not.toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByText('Survivor')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// parseBudgetValue() — via the "Create cost center" modal
// ---------------------------------------------------------------------------

describe('FinancePage — budget value parsing (create cost center)', () => {
  function createHandlers(onCreate: (body: Record<string, unknown>) => void) {
    return [
      ...baseHandlers({}),
      http.post('/api/v1/finance/cost-centers', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        onCreate(body);
        return HttpResponse.json(makeCostCenter({ id: 999, name: String(body.name) }));
      }),
    ];
  }

  it('sends the parsed monthly budget as a number and total_budget as null', async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(...createHandlers((body) => (captured = body)));
    const user = userEvent.setup();
    render(<FinancePage />);
    await switchToAdminView(user);
    await user.click(await screen.findByRole('button', { name: 'Create cost center' }, { timeout: 5000 }));

    const modal = await waitFor(() => modalFor('Create cost center'), { timeout: 5000 });
    await user.type(within(modal).getByRole('textbox'), 'R&D Lab');
    await user.type(within(modal).getByRole('spinbutton'), '150.5');
    await user.click(within(modal).getByRole('button', { name: 'Create' }));

    await waitFor(
      () =>
        expect(captured).toEqual({
          name: 'R&D Lab',
          total_budget: null,
          monthly_budget: 150.5,
          is_active: true,
        }),
      { timeout: 5000 }
    );
  });

  it('sends total_budget (not monthly_budget) when the budget type is switched to Total', async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(...createHandlers((body) => (captured = body)));
    const user = userEvent.setup();
    render(<FinancePage />);
    await switchToAdminView(user);
    await user.click(await screen.findByRole('button', { name: 'Create cost center' }, { timeout: 5000 }));

    const modal = await waitFor(() => modalFor('Create cost center'), { timeout: 5000 });
    await user.type(within(modal).getByRole('textbox'), 'Total Budget Center');
    await user.selectOptions(within(modal).getByRole('combobox'), 'total');
    await user.type(within(modal).getByRole('spinbutton'), '300');
    await user.click(within(modal).getByRole('button', { name: 'Create' }));

    await waitFor(
      () =>
        expect(captured).toEqual({
          name: 'Total Budget Center',
          total_budget: 300,
          monthly_budget: null,
          is_active: true,
        }),
      { timeout: 5000 }
    );
  });

  it('parses an empty budget field as null (unlimited), not zero or NaN', async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(...createHandlers((body) => (captured = body)));
    const user = userEvent.setup();
    render(<FinancePage />);
    await switchToAdminView(user);
    await user.click(await screen.findByRole('button', { name: 'Create cost center' }, { timeout: 5000 }));

    const modal = await waitFor(() => modalFor('Create cost center'), { timeout: 5000 });
    await user.type(within(modal).getByRole('textbox'), 'No Budget Center');
    // Budget field left untouched (empty string).
    await user.click(within(modal).getByRole('button', { name: 'Create' }));

    await waitFor(
      () =>
        expect(captured).toEqual({
          name: 'No Budget Center',
          total_budget: null,
          monthly_budget: null,
          is_active: true,
        }),
      { timeout: 5000 }
    );
  });

  it('BUG (not fixed): a negative budget value is accepted with no positivity check', async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(...createHandlers((body) => (captured = body)));
    const user = userEvent.setup();
    render(<FinancePage />);
    await switchToAdminView(user);
    await user.click(await screen.findByRole('button', { name: 'Create cost center' }, { timeout: 5000 }));

    const modal = await waitFor(() => modalFor('Create cost center'), { timeout: 5000 });
    await user.type(within(modal).getByRole('textbox'), 'Negative Budget Center');
    await user.type(within(modal).getByRole('spinbutton'), '-25');
    await user.click(within(modal).getByRole('button', { name: 'Create' }));

    await waitFor(
      () =>
        expect(captured).toEqual({
          name: 'Negative Budget Center',
          total_budget: null,
          monthly_budget: -25,
          is_active: true,
        }),
      { timeout: 5000 }
    );
  });

  it("a comma decimal separator never reaches parseBudgetValue: the browser's <input type=number> sanitizes it to empty first", async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(...createHandlers((body) => (captured = body)));
    const user = userEvent.setup();
    render(<FinancePage />);
    await switchToAdminView(user);
    await user.click(await screen.findByRole('button', { name: 'Create cost center' }, { timeout: 5000 }));

    const modal = await waitFor(() => modalFor('Create cost center'), { timeout: 5000 });
    await user.type(within(modal).getByRole('textbox'), 'Comma Budget Center');
    const budgetInput = within(modal).getByRole('spinbutton') as HTMLInputElement;
    // A real browser (and jsdom, which mirrors the HTML5 number-input
    // sanitization algorithm) rejects "12,5" outright and leaves the value
    // empty — Number.parseFloat's own comma-truncating behavior
    // (parseFloat('12,5') === 12) is therefore unreachable through this
    // control; parseBudgetValue only ever sees '' here, so the result is
    // null, not 12.
    fireEvent.change(budgetInput, { target: { value: '12,5' } });
    expect(budgetInput.value).toBe('');
    await user.click(within(modal).getByRole('button', { name: 'Create' }));

    await waitFor(
      () =>
        expect(captured).toEqual({
          name: 'Comma Budget Center',
          total_budget: null,
          monthly_budget: null,
          is_active: true,
        }),
      { timeout: 5000 }
    );
  });

  it('blocks submission with a toast and no request when the name is blank', async () => {
    let createCalls = 0;
    server.use(...createHandlers(() => (createCalls += 1)));
    const user = userEvent.setup();
    render(<FinancePage />);
    await switchToAdminView(user);
    await user.click(await screen.findByRole('button', { name: 'Create cost center' }, { timeout: 5000 }));

    const modal = await waitFor(() => modalFor('Create cost center'), { timeout: 5000 });
    await user.type(within(modal).getByRole('spinbutton'), '50');
    await user.click(within(modal).getByRole('button', { name: 'Create' }));

    expect(
      await screen.findByText('Cost center name is required', {}, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(createCalls).toBe(0);
  });
});
