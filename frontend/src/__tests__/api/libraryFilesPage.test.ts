import { afterEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { api } from '../../api/client';

const rows = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: offset + i + 1, filename: `f${offset + i + 1}.3mf`, file_type: '3mf' }));

afterEach(() => server.resetHandlers());

describe('api.getLibraryFilesPage', () => {
  it('sends every filter, sort and paging parameter and reads X-Total-Count', async () => {
    let seen: URLSearchParams | null = null;
    server.use(
      http.get('/api/v1/library/files', ({ request }) => {
        seen = new URL(request.url).searchParams;
        return HttpResponse.json(rows(2), { headers: { 'X-Total-Count': '345' } });
      }),
    );
    const page = await api.getLibraryFilesPage({
      folderId: 7, includeRoot: false, recursive: true, tagIds: [3, 1],
      search: 'benchy', fileType: 'stl', createdBy: 'paul', sort: 'date', direction: 'desc',
      limit: 100, offset: 200,
    });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(345);
    const p = seen!;
    expect(p.get('folder_id')).toBe('7');
    expect(p.get('include_root')).toBe('false');
    expect(p.get('recursive')).toBe('true');
    expect(p.getAll('tag_ids')).toEqual(['3', '1']);
    expect(p.get('search')).toBe('benchy');
    expect(p.get('file_type')).toBe('stl');
    expect(p.get('created_by')).toBe('paul');
    expect(p.get('sort')).toBe('date');
    expect(p.get('direction')).toBe('desc');
    expect(p.get('limit')).toBe('100');
    expect(p.get('offset')).toBe('200');
  });

  it('maps scope to internal_only / external_only and omits empty filters', async () => {
    let seen: URLSearchParams | null = null;
    server.use(
      http.get('/api/v1/library/files', ({ request }) => {
        seen = new URL(request.url).searchParams;
        return HttpResponse.json([], { headers: { 'X-Total-Count': '0' } });
      }),
    );
    await api.getLibraryFilesPage({ folderId: null, scope: 'external', search: '  ', fileType: 'all', createdBy: '', limit: 100, offset: 0 });
    const p = seen!;
    expect(p.get('external_only')).toBe('true');
    expect(p.has('internal_only')).toBe(false);
    expect(p.has('folder_id')).toBe(false);
    expect(p.has('search')).toBe(false);
    expect(p.has('file_type')).toBe(false);
    expect(p.has('created_by')).toBe(false);
  });

  it('treats a missing X-Total-Count as the end of the list', async () => {
    server.use(http.get('/api/v1/library/files', () => HttpResponse.json(rows(3, 100))));
    const page = await api.getLibraryFilesPage({ folderId: null, limit: 100, offset: 100 });
    expect(page.total).toBe(103);
  });

  it('throws the server detail on an error response', async () => {
    server.use(
      http.get('/api/v1/library/files', () => HttpResponse.json({ detail: 'nope' }, { status: 400 })),
    );
    await expect(api.getLibraryFilesPage({ folderId: null, limit: 100, offset: 0 })).rejects.toThrow('nope');
  });
});

describe('api.getLibraryFileTypes', () => {
  it('calls the facet endpoint with the scope parameters', async () => {
    let seen: URLSearchParams | null = null;
    server.use(
      http.get('/api/v1/library/files/file-types', ({ request }) => {
        seen = new URL(request.url).searchParams;
        return HttpResponse.json(['3mf', 'stl']);
      }),
    );
    await expect(api.getLibraryFileTypes({ folderId: 4, includeRoot: false, tagIds: [2] })).resolves.toEqual(['3mf', 'stl']);
    expect(seen!.get('folder_id')).toBe('4');
    expect(seen!.get('include_root')).toBe('false');
    expect(seen!.getAll('tag_ids')).toEqual(['2']);
  });
});
