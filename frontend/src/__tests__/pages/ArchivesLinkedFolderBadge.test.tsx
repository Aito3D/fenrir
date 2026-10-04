/**
 * The archive card's folder badge comes from the list row's `linked_folder`;
 * no card fetches /library/folders/by-archive/{id} any more (that was one
 * request per archive on every page view).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { ArchivesPage } from '../../pages/ArchivesPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { setAuthToken } from '../../api/client';

const row = (id: number, name: string, linked: { id: number; name: string } | null) => ({
  id, filename: `${name}.gcode.3mf`, print_name: name, printer_id: 1, printer_name: 'X1 Carbon',
  print_time_seconds: 3600, filament_used_grams: 10, status: 'completed',
  started_at: '2026-10-01T10:00:00Z', completed_at: '2026-10-01T10:00:00Z', thumbnail_path: null,
  notes: null, rating: null, project_id: null, project_name: null, project_color: null, print_count: 1,
  tags: '', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', has_f3d: false,
  duplicate_count: 0, duplicate_sequence: 0, original_archive_id: null, linked_folder: linked,
});

describe('archive folder badge', () => {
  let byArchiveCalls = 0;

  beforeEach(() => {
    byArchiveCalls = 0;
    setAuthToken(null);
    localStorage.setItem('archiveViewMode', 'grid');
    server.use(
      http.get('/api/v1/archives/', () =>
        HttpResponse.json([row(1, 'Linked Bracket', { id: 77, name: 'Customer A' }), row(2, 'Plain Hook', null)]),
      ),
      http.get('/api/v1/library/folders/by-archive/:id', () => {
        byArchiveCalls += 1;
        return HttpResponse.json([]);
      }),
      http.get('/api/v1/archives/stats', () => HttpResponse.json({ total_archives: 2 })),
      http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1 Carbon' }])),
      http.get('/api/v1/projects/', () => HttpResponse.json([])),
      http.get('/api/v1/archives/tags', () => HttpResponse.json([])),
    );
  });

  it('links the folder from the list row without a per-card request', async () => {
    render(<ArchivesPage />);

    await waitFor(() => expect(screen.getByText('Plain Hook')).toBeInTheDocument(), { timeout: 5000 });
    const badge = screen.getByTitle('Open folder: Customer A');
    expect(badge.closest('a')?.getAttribute('href')).toBe('/files?folder=77');
    expect(screen.queryAllByTitle(/Open folder:/)).toHaveLength(1);
    expect(byArchiveCalls).toBe(0);
  });
});
