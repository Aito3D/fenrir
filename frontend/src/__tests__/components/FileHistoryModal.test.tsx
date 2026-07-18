/**
 * Tests for the FileHistoryModal component (library file history timeline).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FileHistoryModal } from '../../components/FileHistoryModal';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const baseHistory = {
  file_id: 7,
  filename: 'benchy.gcode.3mf',
  added_at: '2026-06-01T10:00:00',
  added_by_username: 'paul',
  source_type: null,
  source_url: null,
  history_available: true,
  total_prints: 0,
  success_count: 0,
  total_filament_grams: null,
  last_printed_at: null,
  events: [],
};

function mockHistory(overrides: Partial<typeof baseHistory> & { events?: unknown[] }) {
  server.use(
    http.get('/api/v1/library/files/:id/history', () =>
      HttpResponse.json({ ...baseHistory, ...overrides })
    )
  );
}

describe('FileHistoryModal', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the filename in the title', async () => {
    mockHistory({});
    render(<FileHistoryModal fileId={7} filename="benchy.gcode.3mf" onClose={mockOnClose} />);
    expect(screen.getByText(/benchy\.gcode\.3mf/)).toBeInTheDocument();
  });

  it('shows the added-to-library provenance line', async () => {
    mockHistory({});
    render(<FileHistoryModal fileId={7} filename="benchy.gcode.3mf" onClose={mockOnClose} />);
    await waitFor(() => {
      expect(screen.getByText('Added to library')).toBeInTheDocument();
    });
    expect(screen.getByText('by paul')).toBeInTheDocument();
  });

  it('shows the empty state when the file was never printed', async () => {
    mockHistory({});
    render(<FileHistoryModal fileId={7} filename="benchy.gcode.3mf" onClose={mockOnClose} />);
    await waitFor(() => {
      expect(screen.getByText('This file has not been printed yet.')).toBeInTheDocument();
    });
  });

  it('shows the external-file note when history is unavailable', async () => {
    mockHistory({ history_available: false });
    render(<FileHistoryModal fileId={7} filename="benchy.gcode.3mf" onClose={mockOnClose} />);
    await waitFor(() => {
      expect(
        screen.getByText('Print history is not available for external files.')
      ).toBeInTheDocument();
    });
  });

  it('renders print events with status and stats strip', async () => {
    mockHistory({
      total_prints: 2,
      success_count: 1,
      total_filament_grams: 24.5,
      last_printed_at: '2026-06-10T12:00:00',
      events: [
        {
          type: 'print',
          status: 'failed',
          archive_id: null,
          printer_name: 'P1S',
          started_at: '2026-06-10T11:00:00',
          completed_at: '2026-06-10T12:00:00',
          duration_seconds: 3600,
          filament_used_grams: 4.5,
          cost: null,
          failure_reason: 'filament_runout',
          created_by_username: null,
          event_at: '2026-06-10T12:00:00',
        },
        {
          type: 'print',
          status: 'completed',
          archive_id: 42,
          printer_name: 'X1 Carbon',
          started_at: '2026-06-05T10:00:00',
          completed_at: '2026-06-05T11:00:00',
          duration_seconds: 3600,
          filament_used_grams: 20.0,
          cost: 0.5,
          failure_reason: null,
          created_by_username: 'paul',
          event_at: '2026-06-05T11:00:00',
        },
      ],
    });
    render(<FileHistoryModal fileId={7} filename="benchy.gcode.3mf" onClose={mockOnClose} />);
    await waitFor(() => {
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
    // Stats strip: 2 prints, 50% success.
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('24.5 g')).toBeInTheDocument();
  });

  it('renders queued events with the queued label', async () => {
    mockHistory({
      events: [
        {
          type: 'queued',
          status: 'pending',
          archive_id: null,
          printer_name: 'X1 Carbon',
          started_at: null,
          completed_at: null,
          duration_seconds: null,
          filament_used_grams: null,
          cost: null,
          failure_reason: null,
          created_by_username: null,
          event_at: '2026-06-12T09:00:00',
        },
      ],
    });
    render(<FileHistoryModal fileId={7} filename="benchy.gcode.3mf" onClose={mockOnClose} />);
    await waitFor(() => {
      expect(screen.getByText('Queued')).toBeInTheDocument();
    });
  });

  it('closes when the close button is clicked', async () => {
    mockHistory({});
    const user = userEvent.setup();
    render(<FileHistoryModal fileId={7} filename="benchy.gcode.3mf" onClose={mockOnClose} />);
    await user.click(screen.getByTitle('Close'));
    expect(mockOnClose).toHaveBeenCalled();
  });
});
