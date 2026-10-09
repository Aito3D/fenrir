/**
 * ProjectLinkPicker: suggestions first (with their reason), then a debounced
 * free search that drops ids already suggested; Escape closes without
 * reaching window/document listeners; a click picks unless disabled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { ProjectLinkPicker } from '../../../../components/projects/aito/ProjectLinkPicker';

const searchItem = (id: number, code: string, name: string) => ({
  id,
  code,
  name,
  description: null,
  status: 'active',
  color: null,
  cover_image_filename: null,
  tags: [],
  archive_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
});

let searches: URLSearchParams[];
let suggestionCalls: number;

beforeEach(() => {
  searches = [];
  suggestionCalls = 0;
  server.use(
    http.get('/api/v1/aito/tasks/:taskId/project-suggestions', ({ params }) => {
      suggestionCalls += 1;
      if (params.taskId !== '42') return HttpResponse.json([]);
      return HttpResponse.json([
        { id: 1, code: 'P-0001', name: 'Support caméra', reason: 'same_client' },
        { id: 2, code: 'P-0002', name: 'Boîtier drone', reason: 'similar_title' },
      ]);
    }),
    http.get('/api/v1/projects/search', ({ request }) => {
      const params = new URL(request.url).searchParams;
      searches.push(params);
      const q = params.get('q') ?? '';
      if (q === 'zzz') return HttpResponse.json({ items: [], total: 0 });
      return HttpResponse.json({
        items: [searchItem(2, 'P-0002', 'Boîtier drone'), searchItem(3, 'P-0003', 'Boîtier pile')],
        total: 2,
      });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const optionNames = () =>
  screen.queryAllByRole('listitem').map((li) => within(li).getByRole('button').textContent);

describe('ProjectLinkPicker', () => {
  it('lists the suggestions with their reason labels and focuses the search box', async () => {
    render(<ProjectLinkPicker taskId={42} onPick={vi.fn()} onClose={vi.fn()} />);

    const first = await screen.findByRole('button', { name: /Support caméra/ });
    expect(within(first).getByText('P-0001')).toBeInTheDocument();
    expect(within(first).getByText('Same client')).toBeInTheDocument();
    const second = screen.getByRole('button', { name: /Boîtier drone/ });
    expect(within(second).getByText('Similar title')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search projects…' })).toHaveFocus();
    expect(searches).toHaveLength(0);
    expect(screen.queryByText('No matching project')).not.toBeInTheDocument();
  });

  it('appends search results after the suggestions, without repeating a suggested id', async () => {
    render(<ProjectLinkPicker taskId={42} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /Support caméra/ });

    await userEvent.type(screen.getByRole('searchbox'), '  boîtier ');

    await waitFor(() => expect(screen.getByRole('button', { name: /Boîtier pile/ })).toBeInTheDocument(), {
      timeout: 2000,
    });
    expect(searches.at(-1)?.get('q')).toBe('boîtier');
    expect(searches.at(-1)?.get('limit')).toBe('10');
    expect(optionNames()).toEqual([
      'P-0001Support caméraSame client',
      'P-0002Boîtier droneSimilar title',
      'P-0003Boîtier pile',
    ]);
    expect(screen.getAllByRole('button', { name: /Boîtier drone/ })).toHaveLength(1);
  });

  it('shows the not-found message when a search matches nothing and nothing is suggested', async () => {
    render(<ProjectLinkPicker taskId={7} onPick={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(suggestionCalls).toBe(1));
    expect(screen.queryByText('No matching project')).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole('searchbox'), 'zzz');

    expect(await screen.findByText('No matching project', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('keeps the suggestions instead of the not-found message when a search matches nothing', async () => {
    render(<ProjectLinkPicker taskId={42} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /Support caméra/ });

    await userEvent.type(screen.getByRole('searchbox'), 'zzz');

    await waitFor(() => expect(searches.at(-1)?.get('q')).toBe('zzz'), { timeout: 2000 });
    expect(screen.queryByText('No matching project')).not.toBeInTheDocument();
    expect(optionNames()).toHaveLength(2);
  });

  it('closes on Escape without letting the key reach document listeners', async () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    try {
      render(<ProjectLinkPicker taskId={42} onPick={vi.fn()} onClose={onClose} />);
      await screen.findByRole('button', { name: /Support caméra/ });

      await userEvent.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(outer).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', outer);
    }
  });

  it('lets other keys through without closing', async () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    try {
      render(<ProjectLinkPicker taskId={42} onPick={vi.fn()} onClose={onClose} />);
      fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });

      expect(onClose).not.toHaveBeenCalled();
      expect(outer).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', outer);
    }
  });

  it('calls onPick with the project id of the clicked option', async () => {
    const onPick = vi.fn();
    render(<ProjectLinkPicker taskId={42} onPick={onPick} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /Support caméra/ });
    await userEvent.type(screen.getByRole('searchbox'), 'boîtier');
    const searched = await screen.findByRole('button', { name: /Boîtier pile/ }, { timeout: 2000 });

    await userEvent.click(searched);
    await userEvent.click(screen.getByRole('button', { name: /Support caméra/ }));

    expect(onPick.mock.calls).toEqual([[3], [1]]);
  });

  it('disables every option and ignores clicks while disabled', async () => {
    const onPick = vi.fn();
    render(<ProjectLinkPicker taskId={42} onPick={onPick} onClose={vi.fn()} disabled />);
    const option = await screen.findByRole('button', { name: /Support caméra/ });

    expect(option).toBeDisabled();
    expect(screen.getByRole('button', { name: /Boîtier drone/ })).toBeDisabled();
    await userEvent.click(option);

    expect(onPick).not.toHaveBeenCalled();
  });
});
