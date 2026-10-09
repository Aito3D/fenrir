import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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

  it('pages through more than one page of results', async () => {
    const offsets: Array<[string | null, string | null]> = [];
    server.use(
      http.get('/api/v1/projects/search', ({ request }) => {
        const params = new URL(request.url).searchParams;
        offsets.push([params.get('offset'), params.get('limit')]);
        const offset = Number(params.get('offset'));
        const count = Math.min(50, 120 - offset);
        const items = Array.from({ length: count }, (_, i) =>
          item(offset + i + 1, `P-${String(offset + i + 1).padStart(4, '0')}`, `Projet ${offset + i + 1}`),
        );
        return HttpResponse.json({ items, total: 120 });
      }),
    );
    render(<ProjectListPage />);

    expect(await screen.findByText('1–50 of 120')).toBeInTheDocument();
    expect(offsets).toEqual([['0', '50']]);
    const prev = screen.getByRole('button', { name: 'Previous page' });
    const next = screen.getByRole('button', { name: 'Next page' });
    expect(prev).toBeDisabled();
    expect(next).toBeEnabled();

    await userEvent.click(next);
    expect(await screen.findByText('51–100 of 120')).toBeInTheDocument();
    expect(offsets.at(-1)).toEqual(['50', '50']);
    expect(await screen.findByText('P-0051')).toBeInTheDocument();
    expect(prev).toBeEnabled();
    expect(next).toBeEnabled();

    await userEvent.click(next);
    expect(await screen.findByText('101–120 of 120')).toBeInTheDocument();
    expect(offsets.at(-1)).toEqual(['100', '50']);
    expect(next).toBeDisabled();
    expect(prev).toBeEnabled();

    await userEvent.click(prev);
    expect(await screen.findByText('51–100 of 120')).toBeInTheDocument();
    expect(offsets.at(-1)).toEqual(['50', '50']);
  });

  it('hides the pager when every result fits on one page', async () => {
    render(<ProjectListPage />);
    await screen.findByText('P-0001');
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
    expect(screen.queryByText(/ of 2$/)).not.toBeInTheDocument();
  });

  it('renders grid cards with code, name, description, tags, print count and cover', async () => {
    localStorage.setItem('projects-view', 'grid');
    server.use(
      http.get('/api/v1/projects/search', () =>
        HttpResponse.json({
          items: [
            { ...item(1, 'P-0001', 'Support caméra', [{ id: 9, name: 'drone' }]), cover_image_filename: 'c.png' },
            { ...item(4, 'P-0004', 'Boîtier'), description: null },
          ],
          total: 2,
        }),
      ),
    );
    render(<ProjectListPage />);

    const first = await screen.findByRole('button', { name: /P-0001/ });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(within(first).getByText('Support caméra')).toBeInTheDocument();
    expect(within(first).getByText('Support caméra description')).toBeInTheDocument();
    expect(within(first).getByText('drone')).toBeInTheDocument();
    expect(within(first).getByText('Prints: 1')).toBeInTheDocument();
    expect(within(first).getByText('Active')).toBeInTheDocument();
    const cover = first.querySelector('img');
    expect(cover?.getAttribute('src')).toContain('/api/v1/projects/1/cover-image');

    const second = screen.getByRole('button', { name: /P-0004/ });
    expect(within(second).getByText('Boîtier')).toBeInTheDocument();
    expect(within(second).getByText('Prints: 4')).toBeInTheDocument();
    expect(second.querySelector('img')).toBeNull();
    expect(second.querySelector('p')).toBeNull();
  });

  it('opens the project when a grid card is clicked', async () => {
    localStorage.setItem('projects-view', 'grid');
    window.history.pushState({}, '', '/projects');
    render(<ProjectListPage />);
    await userEvent.click(await screen.findByRole('button', { name: /P-0002/ }));
    expect(window.location.pathname).toBe('/projects/2');
  });

  it('opens the project when a table row is clicked', async () => {
    window.history.pushState({}, '', '/projects');
    render(<ProjectListPage />);
    await userEvent.click(await screen.findByText('P-0002'));
    expect(window.location.pathname).toBe('/projects/2');
  });
});
