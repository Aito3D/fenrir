import { describe, it, expect, vi } from 'vitest';
import { screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ClientHistoryModal } from '../../components/aito/ClientHistoryModal';
import type { AitoClientHistoryCard, AitoProject } from '../../api/client';
import { formatMoney } from '../../utils/pricing';
import { formatDate } from '../../utils/date';

// The test currency is USD (mocked settings); amounts are compared through
// formatMoney rather than typed, so a locale change cannot break this file.
// formatMoney's thousands separator is a narrow no-break space (U+202F);
// `toHaveTextContent` normalizes the DOM's whitespace (collapsing it, along
// with U+202F, to a plain space) but not the string it is given, so the raw
// formatMoney output never matches — normalize it here the same way.
const money = (v: number) => formatMoney(v, 'USD').replace(/\s+/g, ' ');

const project = {
  id: 41,
  client_id: 'z1',
  client_name: 'PACIFIC MARINE',
  client_is_company: true,
  description: 'Pièce carrosserie de BMW X3',
} as unknown as AitoProject;

// Hours ≥ 10:00 UTC: the sandbox is UTC-10 (AitoDoneGrid precedent).
const card = (over: Partial<AitoClientHistoryCard>): AitoClientHistoryCard => ({
  id: 1,
  created_at: '2026-09-07T10:00:00',
  column: 'print',
  total: 3750,
  quote_number: 'DEV26-2656',
  quote_status: 'sent',
  description: 'Pièce carrosserie de BMW X3',
  tasks: [],
  ...over,
});

const cards = [
  card({ id: 41 }),
  card({ id: 33, created_at: '2026-07-30T10:00:00', column: 'done', total: 40500, quote_number: 'DEV26-2483', quote_status: 'accepted', description: 'Pièce de tambour en inox' }),
  card({ id: 17, created_at: '2026-04-03T10:00:00', column: 'devis', total: 6200, quote_number: 'DEV26-2401', quote_status: 'declined', description: 'Engrenage machine à laver' }),
  card({ id: 4, created_at: '2025-09-02T10:00:00', column: 'done', total: 2000, quote_number: null, quote_status: null, description: 'Bague entretoise' }),
];

function mockHistory(body: { cards: AitoClientHistoryCard[] }) {
  const seen: string[] = [];
  server.use(
    http.get('/api/v1/aito/clients/:clientId/history', ({ request, params }) => {
      seen.push(`${params.clientId}?${new URL(request.url).searchParams.get('limit')}`);
      return HttpResponse.json({ ...body, latest_social: null, latest_contact_person_id: null });
    }),
  );
  return seen;
}

describe('ClientHistoryModal', () => {
  it('asks for the full timeline of the card’s client', async () => {
    const seen = mockHistory({ cards });
    render(<ClientHistoryModal project={project} onClose={vi.fn()} />);
    await screen.findAllByTestId('client-history-row');
    expect(seen).toEqual(['z1?200']);
  });

  it('lists every card newest first with a year marker before each year, id, quote, total, description', async () => {
    mockHistory({ cards });
    render(<ClientHistoryModal project={project} onClose={vi.fn()} />);
    const rows = await screen.findAllByTestId('client-history-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('#41'),
      expect.stringContaining('#33'),
      expect.stringContaining('#17'),
      expect.stringContaining('#4'),
    ]);
    expect(rows[0]).toHaveTextContent('DEV26-2656');
    expect(rows[0]).toHaveTextContent(money(3750));
    expect(rows[1]).toHaveTextContent('Pièce de tambour en inox');
    expect(rows[1]).toHaveTextContent('Done');
    expect(rows[2]).toHaveTextContent('Declined');
    expect(rows[3]).toHaveTextContent('no quote');
    // Year markers: one per distinct year, in order.
    const list = screen.getByRole('list');
    const years = within(list).getAllByTestId('client-history-year').map((y) => y.textContent);
    expect(years).toEqual(['2026', '2025']);
  });

  it('marks the card it was opened from as current, not a button, and every other row as a button', async () => {
    mockHistory({ cards });
    const onOpenCard = vi.fn();
    render(<ClientHistoryModal project={project} onClose={vi.fn()} onOpenCard={onOpenCard} />);
    const rows = await screen.findAllByTestId('client-history-row');
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expect(within(rows[0]).queryByRole('button')).toBeNull();
    expect(rows[0]).toHaveTextContent('This card · Print');
    // The row button's accessible name is its full text content
    // (`#33 DEV26-2483 … Done`), not the `title` — so it is found by role alone.
    await userEvent.setup().click(within(rows[1]).getByRole('button'));
    expect(onOpenCard).toHaveBeenCalledWith(33);
  });

  it('renders no row buttons without onOpenCard', async () => {
    mockHistory({ cards });
    render(<ClientHistoryModal project={project} onClose={vi.fn()} />);
    const rows = await screen.findAllByTestId('client-history-row');
    expect(within(rows[1]).queryByRole('button')).toBeNull();
  });

  it('summarises: every row counted, declined totals left out, since the oldest month', async () => {
    mockHistory({ cards });
    render(<ClientHistoryModal project={project} onClose={vi.fn()} />);
    const summary = await screen.findByTestId('client-history-summary');
    expect(summary).toHaveTextContent(`4 projects · ${money(46250)}`);
    expect(summary).toHaveTextContent(formatDate('2025-09-02T10:00:00', { month: 'short', year: 'numeric' }));
  });

  it('shows the loading state, then the empty state', async () => {
    server.use(
      http.get('/api/v1/aito/clients/:clientId/history', async () => {
        await delay(50);
        return HttpResponse.json({ cards: [], latest_social: null, latest_contact_person_id: null });
      }),
    );
    render(<ClientHistoryModal project={project} onClose={vi.fn()} />);
    expect(screen.getByTestId('client-history-modal')).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByText('No projects for this client yet.')).toBeInTheDocument();
    expect(screen.getByTestId('client-history-modal')).not.toHaveAttribute('aria-busy', 'true');
  });

  it('shows the error state and retries', async () => {
    let calls = 0;
    server.use(
      http.get('/api/v1/aito/clients/:clientId/history', () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ detail: 'boom' }, { status: 500 })
          : HttpResponse.json({ cards, latest_social: null, latest_contact_person_id: null });
      }),
    );
    render(<ClientHistoryModal project={project} onClose={vi.fn()} />);
    expect(await screen.findByText('Could not load the client’s history.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findAllByTestId('client-history-row');
    expect(calls).toBe(2);
  });

  it('is a labelled dialog that closes on Escape and on the Close button', async () => {
    mockHistory({ cards });
    // Two separate mounts, not one Escape-then-click sequence: once
    // useDismissableDialog's exit animation starts, `closing` is already
    // true and a second requestClose is a no-op (by design — see
    // AitoClientEditor's "plays the exit while closing…" test), so a second
    // close signal on the SAME instance would never reach `onClose`.
    const onEscapeClose = vi.fn();
    const { unmount } = render(<ClientHistoryModal project={project} onClose={onEscapeClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Client history' });
    expect(dialog).toHaveTextContent('PACIFIC MARINE');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onEscapeClose).toHaveBeenCalledTimes(1));
    unmount();

    const onButtonClose = vi.fn();
    render(<ClientHistoryModal project={project} onClose={onButtonClose} />);
    await screen.findByRole('dialog', { name: 'Client history' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onButtonClose).toHaveBeenCalledTimes(1));
  });
});
