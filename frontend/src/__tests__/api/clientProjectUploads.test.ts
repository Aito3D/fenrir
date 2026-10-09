/**
 * Pins the raw-fetch requests the project (PDM) upload/download methods send.
 *
 * dropFilesOnTask, uploadProjectRevision and addProjectRevisionFiles bypass
 * `request()` because they post multipart bodies: the browser has to set the
 * form-data boundary itself, so no Content-Type may be forced. Their non-OK
 * handling is `detail || HTTP <status>`, with a non-JSON body falling back to
 * the status line. downloadProjectRevision shares the auth header and the
 * error message shape.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { api, setAuthToken } from '../../api/client';

const fileA = () => new File(['aaa'], 'a.3mf', { type: 'application/octet-stream' });
const fileB = () => new File(['bbbb'], 'b.stl', { type: 'application/octet-stream' });

interface Captured {
  url: string;
  contentType: string | null;
  authorization: string | null;
  /** Multipart part names in wire order (file contents are not inspected here:
   *  jsdom Files reach msw as empty "blob" parts, so `formEntries` pins those). */
  partNames: string[];
}

/** Capture POSTs to `path` via msw and answer with `reply`. */
function capturePost(path: string, reply: () => Response): { captured: Captured[] } {
  const captured: Captured[] = [];
  server.use(
    http.post(`*${path}`, async ({ request }) => {
      const text = await request.text();
      captured.push({
        url: request.url,
        contentType: request.headers.get('content-type'),
        authorization: request.headers.get('authorization'),
        partNames: [...text.matchAll(/Content-Disposition: form-data; name="([^"]+)"/g)].map((m) => m[1]),
      });
      return reply();
    }),
  );
  return { captured };
}

/** The FormData handed to fetch, as [field, file name | string value] pairs. */
function formEntries(body: unknown): Array<[string, string]> {
  expect(body).toBeInstanceOf(FormData);
  const out: Array<[string, string]> = [];
  (body as FormData).forEach((value, key) => {
    out.push([key, typeof value === 'string' ? value : `file:${(value as File).name}`]);
  });
  return out;
}

function spyFetch(body: unknown, status = 200) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
  setAuthToken(null);
  vi.restoreAllMocks();
});

describe('project multipart uploads', () => {
  const cases = [
    {
      name: 'dropFilesOnTask',
      path: '/api/v1/aito/tasks/7/files',
      call: () => api.dropFilesOnTask(7, [fileA(), fileB()]),
      body: { created: [] },
    },
    {
      name: 'uploadProjectRevision',
      path: '/api/v1/projects/items/12/revisions',
      call: () => api.uploadProjectRevision(12, [fileA(), fileB()]),
      body: { revision: { id: 1 }, warnings: [] },
    },
    {
      name: 'addProjectRevisionFiles',
      path: '/api/v1/projects/revisions/34/files',
      call: () => api.addProjectRevisionFiles(34, [fileA(), fileB()]),
      body: { warnings: [] },
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      it('posts every file under `files`, in order, with the browser-set multipart type and no auth', async () => {
        const { captured } = capturePost(c.path, () => HttpResponse.json(c.body));

        const result = await c.call();

        expect(result).toEqual(c.body);
        expect(captured).toHaveLength(1);
        expect(new URL(captured[0].url).pathname).toBe(c.path);
        expect(new URL(captured[0].url).search).toBe('');
        expect(captured[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
        expect(captured[0].authorization).toBeNull();
        expect(captured[0].partNames).toEqual(['files', 'files']);
      });

      it('passes exactly method, headers and body to fetch', async () => {
        setAuthToken('tok-123');
        const fetchSpy = spyFetch(c.body);

        await c.call();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(c.path);
        expect(Object.keys(init ?? {}).sort()).toEqual(['body', 'headers', 'method']);
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ Authorization: 'Bearer tok-123' });
        expect(formEntries(init.body)).toEqual([
          ['files', 'file:a.3mf'],
          ['files', 'file:b.stl'],
        ]);
      });

      it('sends the bearer token when one is set', async () => {
        setAuthToken('tok-abc');
        const { captured } = capturePost(c.path, () => HttpResponse.json(c.body));

        await c.call();

        expect(captured[0].authorization).toBe('Bearer tok-abc');
      });

      it('throws the server detail on a non-OK response', async () => {
        server.use(
          http.post(`*${c.path}`, () => HttpResponse.json({ detail: 'File too large' }, { status: 413 })),
        );

        await expect(c.call()).rejects.toThrow(new Error('File too large'));
      });

      it('throws `HTTP <status>` when the error body is not JSON', async () => {
        server.use(http.post(`*${c.path}`, () => new HttpResponse('upstream exploded', { status: 500 })));

        await expect(c.call()).rejects.toThrow(new Error('HTTP 500'));
      });

      it('throws `HTTP <status>` when the JSON body has no detail', async () => {
        server.use(http.post(`*${c.path}`, () => HttpResponse.json({ other: 1 }, { status: 422 })));

        await expect(c.call()).rejects.toThrow(new Error('HTTP 422'));
      });
    });
  }

  it('uploadProjectRevision appends note and derived_from_id after the files', async () => {
    const fetchSpy = spyFetch({ revision: { id: 2 }, warnings: [] });

    await api.uploadProjectRevision(5, [fileA()], { note: 'v2 fix', derivedFromId: 9 });

    expect(formEntries(fetchSpy.mock.calls[0][1]?.body)).toEqual([
      ['files', 'file:a.3mf'],
      ['note', 'v2 fix'],
      ['derived_from_id', '9'],
    ]);
  });

  it('uploadProjectRevision skips an empty note but keeps derived_from_id 0', async () => {
    const fetchSpy = spyFetch({ revision: { id: 2 }, warnings: [] });

    await api.uploadProjectRevision(5, [fileA()], { note: '', derivedFromId: 0 });

    expect(formEntries(fetchSpy.mock.calls[0][1]?.body)).toEqual([
      ['files', 'file:a.3mf'],
      ['derived_from_id', '0'],
    ]);
  });
});

describe('downloadProjectRevision', () => {
  it('sends only the auth header and the file_id query', async () => {
    setAuthToken('tok-dl');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ detail: 'nope' }), { status: 404 }));

    await expect(api.downloadProjectRevision(3, 8)).rejects.toThrow(new Error('nope'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/projects/revisions/3/download?file_id=8');
    expect(init).toEqual({ headers: { Authorization: 'Bearer tok-dl' } });
  });

  it('sends no headers and no query without a token or file id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('not json', { status: 500 }));

    await expect(api.downloadProjectRevision(3)).rejects.toThrow(new Error('HTTP 500'));

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/projects/revisions/3/download');
    expect(init).toEqual({ headers: {} });
  });

  it('saves the blob under the Content-Disposition name', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let downloadName = '';
    clickSpy.mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('zipbytes', {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="part_v2.zip"' },
      }),
    );

    await api.downloadProjectRevision(3, undefined, 'fallback.zip');

    expect(downloadName).toBe('part_v2.zip');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });
});
