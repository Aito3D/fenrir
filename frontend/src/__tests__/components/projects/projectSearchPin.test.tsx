/**
 * Pins the project search shared by ProjectLinkPicker (Aito task → project)
 * and MoveToProjectModal (File Manager → project): the rendered DOM at each
 * step (suggestions, search results without suggested ids, not-found, picked)
 * and the search query keys, each scoped to its own site.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryCache } from '@tanstack/react-query';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { ProjectLinkPicker } from '../../../components/projects/aito/ProjectLinkPicker';
import { MoveToProjectModal } from '../../../components/projects/filing/MoveToProjectModal';

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

let keys: unknown[][];

beforeEach(() => {
  keys = [];
  const build = QueryCache.prototype.build;
  vi.spyOn(QueryCache.prototype, 'build').mockImplementation(function (this: QueryCache, ...args) {
    keys.push([...(args[1].queryKey as unknown[])]);
    return build.apply(this, args);
  });
  server.use(
    http.get('/api/v1/aito/tasks/:taskId/project-suggestions', ({ params }) =>
      HttpResponse.json(
        params.taskId === '42'
          ? [
              { id: 1, code: 'P-0001', name: 'Support caméra', reason: 'same_client' },
              { id: 2, code: 'P-0002', name: 'Boîtier drone', reason: 'similar_title' },
            ]
          : [],
      ),
    ),
    http.get('/api/v1/library/files/:id/project-suggestions', () =>
      HttpResponse.json([
        { project_id: 2, code: 'P-0002', name: 'Boîtier drone', item_id: 30, item_name: 'Support X1C', score: 1, reason: 'item_name' },
        { project_id: 9, code: null, name: 'Sans code', item_id: null, item_name: null, score: 0.5, reason: 'project_name' },
      ]),
    ),
    http.get('/api/v1/projects/search', ({ request }) => {
      const q = new URL(request.url).searchParams.get('q') ?? '';
      if (q === 'zzz') return HttpResponse.json({ items: [], total: 0 });
      return HttpResponse.json({
        items: [searchItem(2, 'P-0002', 'Boîtier drone'), searchItem(3, 'P-0003', 'Boîtier pile'), searchItem(4, '', 'Nu')],
        total: 3,
      });
    }),
    http.get('/api/v1/projects/:id/tree', ({ params }) =>
      HttpResponse.json({
        project_id: Number(params.id),
        code: 'P-0003',
        sections: [{ section: 'impression', items: [{ id: 30, section: 'impression', name: 'Plate', name_key: 'plate', forked_from: null, revisions: [] }] }],
      }),
    ),
  );
});

afterEach(() => vi.restoreAllMocks());

const searchKeys = () => keys.filter((k) => k[0] === 'projects-search');

describe('ProjectLinkPicker search (pinned DOM)', () => {
  it('renders suggestions, then results without suggested ids, then not-found', async () => {
    const { container } = render(<ProjectLinkPicker taskId={42} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /Support caméra/ });
    expect(container.innerHTML).toMatchInlineSnapshot(`"<div class="mt-2 space-y-2 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-2"><label class="flex items-center gap-2 rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-1"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search h-3.5 w-3.5 flex-shrink-0 text-bambu-gray" aria-hidden="true"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg><input placeholder="Search projects…" aria-label="Search projects…" class="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-bambu-gray focus:outline-none" type="search" value=""></label><ul class="max-h-60 space-y-0.5 overflow-y-auto"><li><button type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span title="Project code P-0001" class="inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-bambu-green/40 bg-bambu-green/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-bambu-green ">P-0001</span><span class="min-w-0 flex-1 truncate">Support caméra</span><span class="flex-shrink-0 text-xs text-bambu-gray">Same client</span></button></li><li><button type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span title="Project code P-0002" class="inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-bambu-green/40 bg-bambu-green/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-bambu-green ">P-0002</span><span class="min-w-0 flex-1 truncate">Boîtier drone</span><span class="flex-shrink-0 text-xs text-bambu-gray">Similar title</span></button></li></ul></div><div data-testid="toast-viewport" class="fixed z-[60] flex flex-col items-end gap-2 " style="bottom: calc(1rem + env(safe-area-inset-bottom)); right: calc(5rem + env(safe-area-inset-right));"></div>"`);

    await userEvent.type(screen.getByRole('searchbox'), ' boî ');
    await screen.findByRole('button', { name: /Boîtier pile/ }, { timeout: 2000 });
    expect(container.innerHTML).toMatchInlineSnapshot(`"<div class="mt-2 space-y-2 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-2"><label class="flex items-center gap-2 rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-1"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search h-3.5 w-3.5 flex-shrink-0 text-bambu-gray" aria-hidden="true"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg><input placeholder="Search projects…" aria-label="Search projects…" class="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-bambu-gray focus:outline-none" type="search" value=" boî "></label><ul class="max-h-60 space-y-0.5 overflow-y-auto"><li><button type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span title="Project code P-0001" class="inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-bambu-green/40 bg-bambu-green/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-bambu-green ">P-0001</span><span class="min-w-0 flex-1 truncate">Support caméra</span><span class="flex-shrink-0 text-xs text-bambu-gray">Same client</span></button></li><li><button type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span title="Project code P-0002" class="inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-bambu-green/40 bg-bambu-green/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-bambu-green ">P-0002</span><span class="min-w-0 flex-1 truncate">Boîtier drone</span><span class="flex-shrink-0 text-xs text-bambu-gray">Similar title</span></button></li><li><button type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span title="Project code P-0003" class="inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-bambu-green/40 bg-bambu-green/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-bambu-green ">P-0003</span><span class="min-w-0 flex-1 truncate">Boîtier pile</span></button></li><li><button type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span class="min-w-0 flex-1 truncate">Nu</span></button></li></ul></div><div data-testid="toast-viewport" class="fixed z-[60] flex flex-col items-end gap-2 " style="bottom: calc(1rem + env(safe-area-inset-bottom)); right: calc(5rem + env(safe-area-inset-right));"></div>"`);
    expect(searchKeys()).toContainEqual(['projects-search', 'aito-link', 'boî']);
    expect(searchKeys().every((k) => k.length === 3 && k[1] === 'aito-link')).toBe(true);
  });

  it('renders the not-found message when nothing is suggested or found', async () => {
    const { container } = render(<ProjectLinkPicker taskId={7} onPick={vi.fn()} onClose={vi.fn()} disabled />);
    await userEvent.type(screen.getByRole('searchbox'), 'zzz');
    await screen.findByText('No matching project', {}, { timeout: 2000 });
    expect(container.innerHTML).toMatchInlineSnapshot(`"<div class="mt-2 space-y-2 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-2"><label class="flex items-center gap-2 rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2 py-1"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search h-3.5 w-3.5 flex-shrink-0 text-bambu-gray" aria-hidden="true"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg><input placeholder="Search projects…" aria-label="Search projects…" class="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-bambu-gray focus:outline-none" type="search" value="zzz"></label><p class="px-2 py-1 text-xs text-bambu-gray">No matching project</p></div><div data-testid="toast-viewport" class="fixed z-[60] flex flex-col items-end gap-2 " style="bottom: calc(1rem + env(safe-area-inset-bottom)); right: calc(5rem + env(safe-area-inset-right));"></div>"`);
    expect(searchKeys()).toContainEqual(['projects-search', 'aito-link', 'zzz']);
  });
});

describe('MoveToProjectModal search (pinned DOM)', () => {
  it('renders suggestions, results without suggested ids, and the picked state', async () => {
    const user = userEvent.setup();
    render(<MoveToProjectModal fileIds={[1]} fileName="a.3mf" onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /Boîtier drone/ });
    expect(document.body.innerHTML).toMatchInlineSnapshot(`"<div><div data-testid="toast-viewport" class="fixed z-[60] flex flex-col items-end gap-2 " style="bottom: calc(1rem + env(safe-area-inset-bottom)); right: calc(5rem + env(safe-area-inset-right));"></div></div><div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-overlay-in"><div role="dialog" aria-modal="true" aria-label="Move to a project" tabindex="-1" class="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5 focus:outline-none animate-modal-in"><div class="min-w-0"><h2 class="text-lg font-semibold text-white">Move to a project</h2><p class="mt-0.5 truncate text-sm text-bambu-gray" title="a.3mf" data-testid="move-to-project-subject">a.3mf</p></div><section class="space-y-1"><h3 class="text-xs font-medium uppercase tracking-wide text-bambu-gray">Suggested</h3><ul class="space-y-0.5"><li><button type="button" aria-pressed="false" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span title="Project code P-0002" class="inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-bambu-green/40 bg-bambu-green/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-bambu-green ">P-0002</span><span class="min-w-0 flex-1 truncate">Boîtier drone</span><span class="flex-shrink-0 truncate text-xs text-bambu-gray">Support X1C</span></button></li><li><button type="button" aria-pressed="false" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span class="min-w-0 flex-1 truncate">Sans code</span></button></li></ul></section><section class="space-y-1"><label class="flex items-center gap-2 rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1.5"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search h-3.5 w-3.5 flex-shrink-0 text-bambu-gray" aria-hidden="true"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg><input placeholder="Search a project…" aria-label="Search a project…" class="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-bambu-gray focus:outline-none" type="search" value=""></label></section><div class="flex justify-end gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-4 py-2 text-sm gap-2 min-h-[44px] md:min-h-0 " type="button">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-4 py-2 text-sm gap-2 min-h-[44px] md:min-h-0 " type="button" disabled="" aria-label="Move">Move</button></div></div></div>"`);

    await user.type(screen.getByRole('searchbox'), ' boî ');
    await screen.findByRole('button', { name: /Boîtier pile/ }, { timeout: 2000 });
    await waitFor(() => expect(document.querySelector('label .animate-spin')).toBeNull());
    expect(document.body.innerHTML).toMatchInlineSnapshot(`"<div><div data-testid="toast-viewport" class="fixed z-[60] flex flex-col items-end gap-2 " style="bottom: calc(1rem + env(safe-area-inset-bottom)); right: calc(5rem + env(safe-area-inset-right));"></div></div><div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-overlay-in"><div role="dialog" aria-modal="true" aria-label="Move to a project" tabindex="-1" class="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5 focus:outline-none animate-modal-in"><div class="min-w-0"><h2 class="text-lg font-semibold text-white">Move to a project</h2><p class="mt-0.5 truncate text-sm text-bambu-gray" title="a.3mf" data-testid="move-to-project-subject">a.3mf</p></div><section class="space-y-1"><h3 class="text-xs font-medium uppercase tracking-wide text-bambu-gray">Suggested</h3><ul class="space-y-0.5"><li><button type="button" aria-pressed="false" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span title="Project code P-0002" class="inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-bambu-green/40 bg-bambu-green/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-bambu-green ">P-0002</span><span class="min-w-0 flex-1 truncate">Boîtier drone</span><span class="flex-shrink-0 truncate text-xs text-bambu-gray">Support X1C</span></button></li><li><button type="button" aria-pressed="false" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span class="min-w-0 flex-1 truncate">Sans code</span></button></li></ul></section><section class="space-y-1"><label class="flex items-center gap-2 rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1.5"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search h-3.5 w-3.5 flex-shrink-0 text-bambu-gray" aria-hidden="true"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg><input placeholder="Search a project…" aria-label="Search a project…" class="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-bambu-gray focus:outline-none" type="search" value=" boî "></label><ul class="max-h-48 space-y-0.5 overflow-y-auto"><li><button type="button" aria-pressed="false" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span title="Project code P-0003" class="inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-bambu-green/40 bg-bambu-green/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-bambu-green ">P-0003</span><span class="min-w-0 flex-1 truncate">Boîtier pile</span></button></li><li><button type="button" aria-pressed="false" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span class="min-w-0 flex-1 truncate">Nu</span></button></li></ul></section><div class="flex justify-end gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-4 py-2 text-sm gap-2 min-h-[44px] md:min-h-0 " type="button">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-4 py-2 text-sm gap-2 min-h-[44px] md:min-h-0 " type="button" disabled="" aria-label="Move">Move</button></div></div></div>"`);

    await user.click(screen.getByRole('button', { name: /Boîtier pile/ }));
    await screen.findByText('Plate');
    expect(document.body.innerHTML).toMatchInlineSnapshot(`"<div><div data-testid="toast-viewport" class="fixed z-[60] flex flex-col items-end gap-2 " style="bottom: calc(1rem + env(safe-area-inset-bottom)); right: calc(5rem + env(safe-area-inset-right));"></div></div><div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-overlay-in"><div role="dialog" aria-modal="true" aria-label="Move to a project" tabindex="-1" class="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5 focus:outline-none animate-modal-in"><div class="min-w-0"><h2 class="text-lg font-semibold text-white">Move to a project</h2><p class="mt-0.5 truncate text-sm text-bambu-gray" title="a.3mf" data-testid="move-to-project-subject">a.3mf</p></div><section class="space-y-1"><h3 class="text-xs font-medium uppercase tracking-wide text-bambu-gray">Suggested</h3><ul class="space-y-0.5"><li><button type="button" aria-pressed="false" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span title="Project code P-0002" class="inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-bambu-green/40 bg-bambu-green/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-bambu-green ">P-0002</span><span class="min-w-0 flex-1 truncate">Boîtier drone</span><span class="flex-shrink-0 truncate text-xs text-bambu-gray">Support X1C</span></button></li><li><button type="button" aria-pressed="false" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span class="min-w-0 flex-1 truncate">Sans code</span></button></li></ul></section><section class="space-y-1"><label class="flex items-center gap-2 rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1.5"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search h-3.5 w-3.5 flex-shrink-0 text-bambu-gray" aria-hidden="true"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg><input placeholder="Search a project…" aria-label="Search a project…" class="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-bambu-gray focus:outline-none" type="search" value=" boî "></label><ul class="max-h-48 space-y-0.5 overflow-y-auto"><li><button type="button" aria-pressed="true" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors bg-bambu-green/20 ring-1 ring-bambu-green/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span title="Project code P-0003" class="inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-bambu-green/40 bg-bambu-green/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-bambu-green ">P-0003</span><span class="min-w-0 flex-1 truncate">Boîtier pile</span></button></li><li><button type="button" aria-pressed="false" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors hover:bg-bambu-dark-tertiary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><span class="min-w-0 flex-1 truncate">Nu</span></button></li></ul></section><fieldset class="space-y-2"><legend class="mb-1 text-xs font-medium uppercase tracking-wide text-bambu-gray">Item</legend><label class="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg border border-bambu-dark-tertiary px-3 py-2 text-sm text-white hover:bg-bambu-dark-tertiary has-[:checked]:border-bambu-green/60"><input class="accent-bambu-green" type="radio" checked="" name="move-to-project-item"><span>Automatic (from each file name)</span></label><label class="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg border border-bambu-dark-tertiary px-3 py-2 text-sm text-white hover:bg-bambu-dark-tertiary has-[:checked]:border-bambu-green/60"><input class="accent-bambu-green" type="radio" name="move-to-project-item"><span class="min-w-0 break-words">Plate</span></label><label class="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg border border-bambu-dark-tertiary px-3 py-2 text-sm text-white hover:bg-bambu-dark-tertiary has-[:checked]:border-bambu-green/60"><input class="accent-bambu-green" type="radio" name="move-to-project-item"><span>New item…</span></label></fieldset><div class="flex justify-end gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-4 py-2 text-sm gap-2 min-h-[44px] md:min-h-0 " type="button">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-4 py-2 text-sm gap-2 min-h-[44px] md:min-h-0 " type="button" aria-label="Move">Move</button></div></div></div>"`);
    expect(searchKeys()).toContainEqual(['projects-search', 'move-to-project', 'boî']);
    expect(searchKeys().every((k) => k.length === 3 && k[1] === 'move-to-project')).toBe(true);
  });

  it('shows the spinner in the search box while a search is in flight', async () => {
    let release: () => void = () => {};
    server.use(
      http.get('/api/v1/projects/search', async () => {
        await new Promise<void>((r) => (release = r));
        return HttpResponse.json({ items: [], total: 0 });
      }),
    );
    const user = userEvent.setup();
    render(<MoveToProjectModal fileIds={[1, 2]} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /Boîtier drone/ });
    await user.type(screen.getByRole('searchbox'), 'x');
    await waitFor(() => expect(document.querySelector('label .animate-spin')).not.toBeNull(), { timeout: 2000 });
    expect(document.querySelector('label')?.outerHTML).toMatchInlineSnapshot(`"<label class="flex items-center gap-2 rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1.5"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search h-3.5 w-3.5 flex-shrink-0 text-bambu-gray" aria-hidden="true"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg><input placeholder="Search a project…" aria-label="Search a project…" class="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-bambu-gray focus:outline-none" type="search" value="x"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle h-3.5 w-3.5 animate-spin text-bambu-gray" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></label>"`);
    release();
    await waitFor(() => expect(document.querySelector('label .animate-spin')).toBeNull());
  });
});
