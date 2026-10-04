/**
 * The Archives page's full list has no ceiling.
 *
 * It asked for limit=10000 once, so past 10,000 archives the oldest silently
 * dropped out of the page -- search, filters and pagination with them. At the
 * shop's ~40 archives a day that point is a few months out. getAllArchives
 * pages until a short page comes back.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { api } from '../../api/client';

describe('getAllArchives', () => {
  it('pages until a short page comes back', async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
    const asked: Array<[string | null, string | null]> = [];
    server.use(
      http.get('/api/v1/archives/', ({ request }) => {
        const params = new URL(request.url).searchParams;
        asked.push([params.get('limit'), params.get('offset')]);
        const limit = Number(params.get('limit'));
        const offset = Number(params.get('offset'));
        return HttpResponse.json(all.slice(offset, offset + limit));
      }),
    );

    const rows = await api.getAllArchives(undefined, 2);

    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(asked).toEqual([['2', '0'], ['2', '2'], ['2', '4']]);
  });

  it('passes the printer filter on every page', async () => {
    const seen: Array<string | null> = [];
    server.use(
      http.get('/api/v1/archives/', ({ request }) => {
        seen.push(new URL(request.url).searchParams.get('printer_id'));
        return HttpResponse.json([]);
      }),
    );
    await api.getAllArchives(7, 2);
    expect(seen).toEqual(['7']);
  });
});
