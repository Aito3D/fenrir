/**
 * Drag-reorder gate: dragging a queued row renumbers the global queue in the
 * displayed order, so it is only offered in ascending "by position" sort.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { QueuePage } from '../../pages/QueuePage';

const dndSensors = vi.hoisted(() => ({ last: undefined as unknown[] | undefined }));

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
      dndSensors.last = props.sensors as unknown[] | undefined;
      return <actual.DndContext {...props} />;
    },
  };
});

const item = (id: number) => ({
  id,
  printer_id: 1,
  archive_id: id,
  position: id,
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

const renderWithSort = async (sortBy: string, asc: string) => {
  vi.mocked(localStorage.getItem).mockImplementation((key: string) => {
    if (key === 'queue.historyCollapsed') return 'false';
    if (key === 'queue.viewMode') return 'list';
    if (key === 'queue.pendingSortBy') return sortBy;
    if (key === 'queue.pendingSortAsc') return asc;
    return null;
  });
  render(<QueuePage />);
  await waitFor(() => expect(screen.getByText('Job 1')).toBeInTheDocument());
};

describe('QueuePage drag reorder gate', () => {
  beforeEach(() => {
    dndSensors.last = undefined;
    server.use(
      http.get('/api/v1/queue/', () => HttpResponse.json([item(1), item(2)])),
      http.get('/api/v1/queue/history', () => HttpResponse.json({ items: [], total: 0, locations: [] })),
    );
  });

  it('keeps dragging enabled in ascending position sort', async () => {
    await renderWithSort('position', 'true');
    expect(dndSensors.last?.length).toBeGreaterThan(0);
  });

  it('disables dragging in descending position sort', async () => {
    await renderWithSort('position', 'false');
    expect(dndSensors.last).toEqual([]);
  });

  it('shows the phone move arrows in ascending position sort', async () => {
    await renderWithSort('position', 'true');
    expect(screen.getAllByTitle('Move Up')).toHaveLength(2);
    expect(screen.getAllByTitle('Move Down')).toHaveLength(2);
  });

  it('hides the phone move arrows in descending position sort', async () => {
    await renderWithSort('position', 'false');
    expect(screen.queryByTitle('Move Up')).toBeNull();
    expect(screen.queryByTitle('Move Down')).toBeNull();
  });

  it.each(['name', 'printer', 'time'])('disables dragging in %s sort', async (sortBy) => {
    await renderWithSort(sortBy, 'true');
    expect(dndSensors.last).toEqual([]);
  });
});
