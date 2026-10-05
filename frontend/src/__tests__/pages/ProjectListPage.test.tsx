import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ProjectListPage } from '../../pages/ProjectListPage';

const item = (id: number, code: string, name: string, tags: { id: number; name: string }[] = []) => ({
  id,
  code,
  name,
  description: `${name} description`,
  status: 'active',
  color: null,
  cover_image_filename: null,
  tags,
  archive_count: id,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
});

let lastSearch: URLSearchParams;

beforeEach(() => {
  localStorage.clear();
  server.use(
    http.get('/api/v1/projects/search', ({ request }) => {
      lastSearch = new URL(request.url).searchParams;
      const q = lastSearch.get('q');
      const all = [item(1, 'P-0001', 'Support caméra', [{ id: 9, name: 'drone' }]), item(2, 'P-0002', 'Boîtier')];
      const items = q ? all.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : all;
      return HttpResponse.json({ items, total: items.length });
    }),
    http.get('/api/v1/projects/tags', () =>
      HttpResponse.json([
        { id: 9, name: 'drone', project_count: 1 },
        { id: 10, name: 'inutilisée', project_count: 0 },
      ]),
    ),
  );
});

describe('ProjectListPage', () => {
  it('shows code chips, titles and tags in the table', async () => {
    render(<ProjectListPage />);
    expect(await screen.findByText('P-0001')).toBeInTheDocument();
    expect(screen.getByText('Support caméra')).toBeInTheDocument();
    expect(screen.getAllByText('drone').length).toBeGreaterThan(0);
  });

  it('makes the title a keyboard-reachable link', async () => {
    render(<ProjectListPage />);
    const link = await screen.findByRole('link', { name: 'Support caméra' });
    expect(link).toHaveAttribute('href', '/projects/1');
  });

  it('pushes one history entry when the title link is clicked', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    render(<ProjectListPage />);
    await userEvent.click(await screen.findByRole('link', { name: 'Support caméra' }));
    expect(push.mock.calls.filter((c) => c[2] === '/projects/1')).toHaveLength(1);
    push.mockRestore();
  });

  it('defaults to active projects', async () => {
    render(<ProjectListPage />);
    await screen.findByText('P-0001');
    expect(lastSearch.get('status')).toBe('active');
  });

  it('sends the search term after typing', async () => {
    render(<ProjectListPage />);
    await screen.findByText('P-0001');
    await userEvent.type(screen.getByRole('searchbox'), 'boît');
    await waitFor(() => expect(lastSearch.get('q')).toBe('boît'));
    await waitFor(() => expect(screen.queryByText('Support caméra')).not.toBeInTheDocument());
  });

  it('filters by a tag, listing only tags that projects use', async () => {
    render(<ProjectListPage />);
    await screen.findByText('P-0001');
    expect(screen.queryByRole('button', { name: 'inutilisée' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'drone', pressed: false }));
    await waitFor(() => expect(lastSearch.getAll('tag_ids')).toEqual(['9']));
  });

  it('switches to grid view and remembers it', async () => {
    render(<ProjectListPage />);
    await screen.findByText('P-0001');
    await userEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(localStorage.getItem('projects-view')).toBe('grid');
  });

  it('shows the search-empty message', async () => {
    render(<ProjectListPage />);
    await screen.findByText('P-0001');
    await userEvent.type(screen.getByRole('searchbox'), 'zzz');
    expect(await screen.findByText('No project matches this search')).toBeInTheDocument();
  });

  it('does not offer sub-project nesting', async () => {
    render(<ProjectListPage />);
    await screen.findByText('P-0001');
    expect(screen.queryByText(/sub-project/i)).not.toBeInTheDocument();
  });
});
