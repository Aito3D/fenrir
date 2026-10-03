/**
 * Archives page loads newest-first: a small "head" request paints page 1 while
 * the full list (needed for search, filters, later pages) loads behind it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { render } from '../utils';
import { ArchivesPage } from '../../pages/ArchivesPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { setAuthToken } from '../../api/client';

function archive(id: number, name: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id, filename: `${name}.gcode.3mf`, print_name: name, printer_id: 1, printer_name: 'X1 Carbon',
    print_time_seconds: 3600, filament_used_grams: 10, status: 'completed',
    started_at: createdAt, completed_at: createdAt, thumbnail_path: null, notes: null, rating: null,
    project_id: null, project_name: null, project_color: null, print_count: 1, tags: '',
    created_at: createdAt, updated_at: createdAt, has_f3d: false,
    duplicate_count: 0, duplicate_sequence: 0, original_archive_id: null, ...extra,
  };
}

const newest = archive(2, 'Newest Benchy', '2026-10-01T10:00:00Z');
const older = archive(1, 'Older Bracket', '2025-01-01T10:00:00Z');

/** Full-list response the test releases by hand. */
let releaseFull: (rows: unknown[] | 'error') => void;

function installHandlers(head: unknown[]) {
  const fullGate = new Promise<unknown[] | 'error'>((resolve) => { releaseFull = resolve; });
  server.use(
    http.get('/api/v1/archives/', async ({ request }) => {
      const limit = new URL(request.url).searchParams.get('limit');
      if (limit !== '10000') return HttpResponse.json(head);
      const rows = await fullGate;
      if (rows === 'error') return new HttpResponse(null, { status: 500 });
      return HttpResponse.json(rows);
    }),
    http.get('/api/v1/archives/stats', () => HttpResponse.json({ total_archives: 2 })),
    http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1 Carbon' }])),
    http.get('/api/v1/projects/', () => HttpResponse.json([])),
    http.get('/api/v1/archives/tags', () => HttpResponse.json([])),
  );
}

describe('ArchivesPage progressive load', () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    // jsdom has no scrollIntoView; the highlight jump calls it.
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
    setAuthToken(null);
    localStorage.removeItem('archiveSortBy');
    localStorage.removeItem('archivePageSize');
    localStorage.setItem('archiveViewMode', 'grid');
  });
  afterEach(() => {
    releaseFull?.([]);
    localStorage.removeItem('archiveSortBy');
    localStorage.removeItem('archivePageSize');
  });

  it('paints the head before the full list and shows the loading-older hint', async () => {
    installHandlers([newest]);
    render(<ArchivesPage />);

    await waitFor(() => expect(screen.getByText('Newest Benchy')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByTestId('archives-loading-older')).toHaveTextContent('Loading older archives…');
    expect(screen.queryByText('Older Bracket')).not.toBeInTheDocument();

    releaseFull([newest, older]);

    await waitFor(() => expect(screen.getByText('Older Bracket')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByTestId('archives-loading-older')).not.toBeInTheDocument();
  });

  it('waits for the full list when the sort is not newest-first', async () => {
    localStorage.setItem('archiveSortBy', 'name-asc');
    installHandlers([newest]);
    render(<ArchivesPage />);

    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText('Newest Benchy')).not.toBeInTheDocument();

    releaseFull([newest, older]);
    await waitFor(() => expect(screen.getByText('Older Bracket')).toBeInTheDocument(), { timeout: 5000 });
  });

  it('waits for the full list when the page size is "All"', async () => {
    localStorage.setItem('archivePageSize', '-1');
    installHandlers([newest]);
    render(<ArchivesPage />);

    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText('Newest Benchy')).not.toBeInTheDocument();

    releaseFull([newest, older]);
    await waitFor(() => expect(screen.getByText('Newest Benchy')).toBeInTheDocument(), { timeout: 5000 });
  });

  it('replaces the hint with a retryable error when the full list fails', async () => {
    installHandlers([newest]);
    render(<ArchivesPage />);

    await waitFor(() => expect(screen.getByTestId('archives-loading-older')).toBeInTheDocument(), { timeout: 5000 });
    releaseFull('error');

    const error = await screen.findByTestId('archives-load-error', {}, { timeout: 10000 });
    expect(error).toHaveTextContent("Couldn't load older archives.");
    expect(screen.queryByTestId('archives-loading-older')).not.toBeInTheDocument();
    expect(screen.getByText('Newest Benchy')).toBeInTheDocument();

    // Retry reaches the server again; this time it answers.
    server.use(http.get('/api/v1/archives/', () => HttpResponse.json([newest, older])));
    fireEvent.click(within(error).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Older Bracket')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByTestId('archives-load-error')).not.toBeInTheDocument();
  });

  it('never shows head rows under a non-date sort, even when the full list fails', async () => {
    localStorage.setItem('archiveSortBy', 'name-asc');
    installHandlers([newest]);
    render(<ArchivesPage />);

    releaseFull('error');
    await screen.findByTestId('archives-load-error', {}, { timeout: 10000 });
    expect(screen.queryByText('Newest Benchy')).not.toBeInTheDocument();
  });

  it('switching to "All" while the full list loads does not show the cached head', async () => {
    localStorage.setItem('archivePageSize', '25');
    const head = Array.from({ length: 30 }, (_, i) =>
      archive(100 + i, `Recent ${i}`, `2026-09-${String(30 - (i % 28)).padStart(2, '0')}T10:00:00Z`));
    installHandlers(head);
    render(<ArchivesPage />);

    await waitFor(() => expect(screen.getByText('Recent 0')).toBeInTheDocument(), { timeout: 5000 });
    const pageSizeSelect = screen.getAllByRole('combobox').find(
      (el) => Array.from((el as HTMLSelectElement).options).some((o) => o.value === '-1'),
    ) as HTMLSelectElement;
    fireEvent.change(pageSizeSelect, { target: { value: '-1' } });

    await waitFor(() => expect(screen.queryByText('Recent 0')).not.toBeInTheDocument(), { timeout: 5000 });

    releaseFull([...head, older]);
    await waitFor(() => expect(screen.getByText('Older Bracket')).toBeInTheDocument(), { timeout: 5000 });
  });

  it('keeps a pending jump to the original alive when the full list is slow', async () => {
    const dup = archive(3, 'Reprint', '2026-10-02T10:00:00Z', {
      content_hash: 'h', duplicate_count: 1, duplicate_sequence: 1, original_archive_id: 1,
    });
    installHandlers([dup]);
    render(<ArchivesPage />);

    fireEvent.click(await screen.findByTitle('Click to view original print (#1)', {}, { timeout: 5000 }));
    // Longer than the 5 s highlight window.
    await new Promise((r) => setTimeout(r, 5500));

    releaseFull([dup, { ...older, content_hash: 'h', duplicate_count: 1 }]);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled(), { timeout: 5000 });
    expect(screen.queryByText('Original print not visible - try clearing filters')).not.toBeInTheDocument();
  }, 20000);

  it('does not report the original as missing while only the head is loaded', async () => {
    const dup = archive(3, 'Reprint', '2026-10-02T10:00:00Z', {
      content_hash: 'h', duplicate_count: 1, duplicate_sequence: 1, original_archive_id: 1,
    });
    installHandlers([dup]);
    render(<ArchivesPage />);

    const badge = await screen.findByTitle('Click to view original print (#1)', {}, { timeout: 5000 });
    fireEvent.click(badge);
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByText('Original print not visible - try clearing filters')).not.toBeInTheDocument();

    releaseFull([dup, { ...older, content_hash: 'h', duplicate_count: 1 }]);
    await waitFor(() => expect(screen.getByText('Older Bracket')).toBeInTheDocument(), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByText('Original print not visible - try clearing filters')).not.toBeInTheDocument();
    // The pending jump retried once the full list arrived and found the original.
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
