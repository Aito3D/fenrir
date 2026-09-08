import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ClientHistory } from '../../components/aito/ClientHistory';
import type { AitoClientHistory, AitoTask } from '../../api/client';

function makeTask(overrides: Partial<AitoTask> = {}): AitoTask {
  return {
    id: 1,
    project_id: 1,
    position: 0,
    title: null,
    scan_description: null,
    modelisation_description: null,
    impression_description: null,
    usinage_description: null,
    scan_cost: null,
    modelisation_cost: null,
    usinage_cost: null,
    impression_printer_id: null,
    impression_filament_id: null,
    impression_weight_g: null,
    impression_time_min: null,
    impression_quantity: 1,
    impression_color: null,
    impression_cost: null,
    impression_discount_pct: null,
    scan_quantity: null,
    modelisation_quantity: null,
    usinage_quantity: null,
    scan_discount_pct: null,
    modelisation_discount_pct: null,
    usinage_discount_pct: null,
    scan_done: false,
    modelisation_done: false,
    impression_done: false,
    usinage_done: false,
    created_at: '2026-08-12T09:14:00',
    updated_at: '2026-08-12T09:14:00',
    ...overrides,
  };
}

const HISTORY: AitoClientHistory = {
  cards: [
    {
      id: 42,
      // 20:14 UTC rather than the task fixtures' 09:14: this sandbox's
      // system timezone is Pacific/Tahiti (UTC-10), so a UTC hour below 10
      // rolls the locally-formatted calendar date back to Aug 11. 20:14
      // UTC stays on Aug 12 after the -10h conversion.
      created_at: '2026-08-12T20:14:00',
      column: 'done',
      total: 18500,
      tasks: [makeTask({ id: 1, title: 'Bracket', scan_cost: 1000 }), makeTask({ id: 2, title: null, modelisation_cost: 500 })],
    },
    { id: 41, created_at: '2026-07-02T09:14:00', column: 'print', total: 0, tasks: [] },
  ],
  latest_social: null,
};

function mockHistory(body: AitoClientHistory | null, status = 200) {
  const calls: string[] = [];
  server.use(
    http.get('/api/v1/aito/clients/:clientId/history', ({ params, request }) => {
      // `URL#search` already carries its own leading '?' (or '' with no
      // query), so concatenating a second one here would give
      // 'z A/1??limit=5' — the id and the search string need no separator
      // of our own.
      calls.push(`${String(params.clientId)}${new URL(request.url).search}`);
      return body === null ? HttpResponse.json({ detail: 'boom' }, { status }) : HttpResponse.json(body);
    }),
  );
  return calls;
}

describe('ClientHistory', () => {
  it('renders one row per card with date, stage, money and task titles', async () => {
    mockHistory(HISTORY);
    render(<ClientHistory clientId="zA" isDefault={false} onReuse={vi.fn()} />);
    const rows = await screen.findAllByTestId('client-history-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Done');
    expect(rows[0]).toHaveTextContent(/Aug 12, 2026/);
    expect(rows[0]).toHaveTextContent(/18[\s,. ]?500/);
    expect(rows[0]).toHaveTextContent('Bracket · Task 2');
    expect(rows[1]).toHaveTextContent('Print');
  });

  it('calls onReuse with the card tasks; a card without tasks has Reuse disabled', async () => {
    mockHistory(HISTORY);
    const onReuse = vi.fn();
    render(<ClientHistory clientId="zA" isDefault={false} onReuse={onReuse} />);
    const buttons = await screen.findAllByRole('button', { name: /reuse/i });
    expect(buttons[1]).toBeDisabled();
    await userEvent.click(buttons[0]);
    expect(onReuse).toHaveBeenCalledWith(HISTORY.cards[0].tasks);
  });

  it('renders nothing when the history is empty', async () => {
    const calls = mockHistory({ cards: [], latest_social: null });
    render(<ClientHistory clientId="zA" isDefault={false} onReuse={vi.fn()} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByTestId('client-history')).not.toBeInTheDocument();
  });

  it('renders nothing on a server error', async () => {
    const calls = mockHistory(null, 500);
    render(<ClientHistory clientId="zA" isDefault={false} onReuse={vi.fn()} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('client-history')).not.toBeInTheDocument();
  });

  it('never asks for the default contact', async () => {
    const calls = mockHistory(HISTORY);
    render(<ClientHistory clientId="zDefault" isDefault onReuse={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
    expect(screen.queryByTestId('client-history')).not.toBeInTheDocument();
  });

  it('requests the client with the default limit', async () => {
    const calls = mockHistory(HISTORY);
    render(<ClientHistory clientId="z A/1" isDefault={false} onReuse={vi.fn()} />);
    await screen.findAllByTestId('client-history-row');
    expect(calls[0]).toBe('z A/1?limit=5');
  });
});
