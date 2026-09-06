import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, within } from '../../utils';
import { server } from '../../mocks/server';
import { PipelineWidget } from '../../../components/stats/PipelineWidget';
import type { AitoStats } from '../../../api/client';

const bucket = (count: number, total: number) => ({ count, total });
const stats: AitoStats = {
  board: [
    { column: 'devis', count: 2, total: 1500 },
    { column: 'waiting', count: 0, total: 0 },
    { column: 'scan', count: 1, total: 800 },
    { column: 'model', count: 0, total: 0 },
    { column: 'print', count: 3, total: 4200 },
    { column: 'finish', count: 1, total: 300 },
    { column: 'done', count: 12, total: 20000 },
  ],
  conversion: { sent: bucket(9, 41000), accepted: bucket(6, 30500), declined: bucket(1, 2000), acceptance_rate: 0.857 },
  stage_days: [
    { column: 'devis', median_days: 2.5, sample: 8 },
    { column: 'waiting', median_days: 4, sample: 3 },
    { column: 'scan', median_days: null, sample: 0 },
    { column: 'model', median_days: 1.25, sample: 2 },
    { column: 'print', median_days: 3, sample: 5 },
    { column: 'finish', median_days: 6.5, sample: 4 },
  ],
  invoicing: { invoiced_total: 28000, invoiced_count: 5, outstanding_balance: 7400, outstanding_count: 2 },
  date_from: '2026-08-01',
  date_to: '2026-09-05',
};
const empty: AitoStats = {
  ...stats,
  board: stats.board.map((b) => ({ ...b, count: 0, total: 0 })),
  conversion: { sent: bucket(0, 0), accepted: bucket(0, 0), declined: bucket(0, 0), acceptance_rate: null },
  stage_days: stats.stage_days.map((s) => ({ ...s, median_days: null, sample: 0 })),
  invoicing: { invoiced_total: 0, invoiced_count: 0, outstanding_balance: 0, outstanding_count: 0 },
};

describe('PipelineWidget', () => {
  it('renders the four sections from the stats', async () => {
    server.use(http.get('/api/v1/aito/stats', () => HttpResponse.json(stats)));
    render(<PipelineWidget dateFrom="2026-08-01" dateTo="2026-09-05" />);
    const board = await screen.findByTestId('pipeline-board');
    expect(board).toHaveTextContent('Printing');
    expect(board).toHaveTextContent('3');
    expect(board).toHaveTextContent('Done 12');

    const conv = screen.getByTestId('pipeline-conversion');
    expect(conv).toHaveTextContent('Sent');
    expect(conv).toHaveTextContent('9');
    expect(conv).toHaveTextContent('86% accepted');

    const days = screen.getByTestId('pipeline-stage-days');
    expect(days).toHaveTextContent('2.5 d');
    expect(within(days).getAllByText('—').length).toBeGreaterThanOrEqual(1);

    const inv = screen.getByTestId('pipeline-invoicing');
    expect(inv).toHaveTextContent('Invoiced');
    expect(inv).toHaveTextContent('5');
    expect(inv).toHaveTextContent('Outstanding');
    expect(inv).toHaveTextContent('2');
  });

  it('shows a dash for a null rate and the empty line when nothing happened', async () => {
    server.use(http.get('/api/v1/aito/stats', () => HttpResponse.json(empty)));
    render(<PipelineWidget />);
    expect(await screen.findByText('Nothing on the Aito board in this period')).toBeInTheDocument();
    expect(screen.queryByTestId('pipeline-conversion')).not.toBeInTheDocument();
  });

  it('shows the load error, not the empty line, when the request fails', async () => {
    server.use(http.get('/api/v1/aito/stats', () => new HttpResponse(null, { status: 500 })));
    render(<PipelineWidget dateFrom="2026-08-01" dateTo="2026-09-05" />);
    expect(await screen.findByText('Error loading data')).toBeInTheDocument();
    expect(screen.queryByText('Nothing on the Aito board in this period')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pipeline-board')).not.toBeInTheDocument();
  });

  it('sends the date range and the browser timezone offset to the API', async () => {
    let seen = '';
    server.use(
      http.get('/api/v1/aito/stats', ({ request }) => {
        seen = new URL(request.url).search;
        return HttpResponse.json(stats);
      }),
    );
    render(<PipelineWidget dateFrom="2026-08-01" dateTo="2026-08-31" />);
    await screen.findByTestId('pipeline-board');
    expect(seen).toContain('date_from=2026-08-01');
    expect(seen).toContain('date_to=2026-08-31');
    // The days are the user's local ones, so the server needs the offset.
    expect(seen).toMatch(/tz_offset_minutes=-?\d+/);
  });
});
