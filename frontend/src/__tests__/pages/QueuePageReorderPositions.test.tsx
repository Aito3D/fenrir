/**
 * Reorder keeps the positions the visible jobs already occupy (hidden jobs of a
 * filtered view keep their place); an unfiltered 1..n queue sends 1..n.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { QueuePage } from '../../pages/QueuePage';

const dnd = vi.hoisted(() => ({
  onDragEnd: undefined as ((e: { active: { id: number }; over: { id: number } | null }) => void) | undefined,
}));

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
      dnd.onDragEnd = props.onDragEnd as typeof dnd.onDragEnd;
      return <actual.DndContext {...props} />;
    },
  };
});

const item = (id: number, position: number) => ({
  id,
  printer_id: 1,
  archive_id: id,
  position,
  status: 'pending',
  scheduled_time: null,
  require_previous_success: false,
  auto_off_after: false,
  manual_start: false,
  ams_mapping: null,
  plate_id: null,
  bed_levelling: 'on',
  flow_cali: 'off',
  vibration_cali: true,
  layer_inspect: false,
  timelapse: false,
  use_ams: true,
  started_at: null,
  completed_at: null,
  error_message: null,
  created_at: '2024-01-01T00:00:00Z',
  archive_name: `Job ${id}`,
  archive_thumbnail: null,
  printer_name: 'Test Printer',
  print_time_seconds: 3600,
});

let reorderBody: unknown;

const renderQueue = async (items: ReturnType<typeof item>[]) => {
  server.use(
    http.get('/api/v1/queue/', () => HttpResponse.json(items)),
    http.get('/api/v1/queue/history', () => HttpResponse.json({ items: [], total: 0, locations: [] })),
    http.post('/api/v1/queue/reorder', async ({ request }) => {
      reorderBody = await request.json();
      return HttpResponse.json({ message: 'ok' });
    }),
  );
  vi.mocked(localStorage.getItem).mockImplementation((key: string) => {
    if (key === 'queue.historyCollapsed') return 'false';
    if (key === 'queue.viewMode') return 'list';
    if (key === 'queue.pendingSortBy') return 'position';
    if (key === 'queue.pendingSortAsc') return 'true';
    return null;
  });
  render(<QueuePage />);
  await waitFor(() => expect(screen.getByText(`Job ${items[0].id}`)).toBeInTheDocument());
};

const expectBody = async (body: { id: number; position: number }[]) => {
  await waitFor(() => expect(reorderBody).toBeDefined());
  expect(reorderBody).toEqual({ items: body });
};

describe('QueuePage reorder positions', () => {
  beforeEach(() => {
    reorderBody = undefined;
    dnd.onDragEnd = undefined;
  });

  it('drag in an unfiltered 1..n queue sends 1..n', async () => {
    await renderQueue([item(1, 1), item(2, 2), item(3, 3)]);
    act(() => dnd.onDragEnd?.({ active: { id: 3 }, over: { id: 1 } }));
    await expectBody([
      { id: 3, position: 1 },
      { id: 1, position: 2 },
      { id: 2, position: 3 },
    ]);
  });

  it('drag in a filtered view swaps the visible jobs onto the positions they hold', async () => {
    // job 2 (position 2) belongs to another printer and is hidden
    await renderQueue([item(1, 1), item(3, 3)]);
    act(() => dnd.onDragEnd?.({ active: { id: 3 }, over: { id: 1 } }));
    await expectBody([
      { id: 3, position: 1 },
      { id: 1, position: 3 },
    ]);
  });

  it('arrow in an unfiltered 1..n queue sends 1..n', async () => {
    await renderQueue([item(1, 1), item(2, 2)]);
    fireEvent.click(screen.getAllByLabelText(/move down/i)[0]);
    await expectBody([
      { id: 2, position: 1 },
      { id: 1, position: 2 },
    ]);
  });

  it('arrow in a filtered view swaps the visible jobs onto the positions they hold', async () => {
    await renderQueue([item(1, 1), item(3, 3)]);
    fireEvent.click(screen.getAllByLabelText(/move down/i)[0]);
    await expectBody([
      { id: 3, position: 1 },
      { id: 1, position: 3 },
    ]);
  });

  it('falls back to 1..n when two visible jobs share a position (the route rejects duplicates)', async () => {
    await renderQueue([item(1, 2), item(3, 2)]);
    fireEvent.click(screen.getAllByLabelText(/move down/i)[0]);
    await expectBody([
      { id: 3, position: 1 },
      { id: 1, position: 2 },
    ]);
  });
});
