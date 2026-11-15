/**
 * Pins the exact fetch init that postForBlob (label PDFs and previews) and
 * uploadSpoolsCsv (spool CSV import) send, with and without a bearer token.
 * postForBlob forces a JSON Content-Type first and adds Authorization after it;
 * uploadSpoolsCsv sends multipart, so only Authorization (or nothing) is set.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setAuthToken } from '../../api/client';

function spyFetch(body: BodyInit | null, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
}

function lastInit(fetchSpy: ReturnType<typeof spyFetch>): [string, RequestInit] {
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  return fetchSpy.mock.calls[0] as [string, RequestInit];
}

afterEach(() => {
  setAuthToken(null);
  vi.restoreAllMocks();
});

describe('postForBlob headers', () => {
  const data = { spool_ids: [1, 2], template: 'box_62x29' } as never;

  it('sends only the JSON Content-Type when no token is set', async () => {
    const fetchSpy = spyFetch('pdf-bytes');

    const blob = await api.printSpoolLabels(data);

    expect(blob.size).toBe('pdf-bytes'.length);
    const [url, init] = lastInit(fetchSpy);
    expect(url).toBe('/api/v1/inventory/labels');
    expect(Object.keys(init).sort()).toEqual(['body', 'headers', 'method', 'signal']);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify(data));
    expect(init.signal).toBeUndefined();
  });

  it('adds the bearer token after the Content-Type when one is set', async () => {
    setAuthToken('tok-blob');
    const fetchSpy = spyFetch('png-bytes');
    const controller = new AbortController();

    await api.previewSpoolmanSpoolLabel(data, controller.signal);

    const [url, init] = lastInit(fetchSpy);
    expect(url).toBe('/api/v1/spoolman/labels/preview');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer tok-blob' });
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(['Content-Type', 'Authorization']);
    expect(init.signal).toBe(controller.signal);
  });

  it('reads the token at call time, not at module load', async () => {
    setAuthToken('first');
    setAuthToken(null);
    const fetchSpy = spyFetch('x');

    await api.printSpoolmanSpoolLabels(data);

    expect(lastInit(fetchSpy)[1].headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('uploadSpoolsCsv headers', () => {
  const csv = () => new File(['a,b\n1,2\n'], 'spools.csv', { type: 'text/csv' });

  it('sends an empty headers object when no token is set', async () => {
    const fetchSpy = spyFetch(JSON.stringify({ rows: [] }));

    const result = await api.importSpoolsCsvPreview(csv());

    expect(result).toEqual({ rows: [] });
    const [url, init] = lastInit(fetchSpy);
    expect(url).toBe('/api/v1/inventory/spools/import?dry_run=true');
    expect(Object.keys(init).sort()).toEqual(['body', 'headers', 'method']);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({});
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('sends only the bearer token when one is set', async () => {
    setAuthToken('tok-csv');
    const fetchSpy = spyFetch(JSON.stringify({ created: 1, skipped: 0, errors: 0, error_rows: [] }));

    await api.importSpoolsCsv(csv());

    const [url, init] = lastInit(fetchSpy);
    expect(url).toBe('/api/v1/inventory/spools/import');
    expect(init.headers).toEqual({ Authorization: 'Bearer tok-csv' });
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(['Authorization']);
  });
});

describe('postForBlob / postForResponse errors', () => {
  const data = { spool_ids: [1], template: 'box_62x29' } as never;

  it('raises an ApiError carrying status, code and structured detail', async () => {
    const body = JSON.stringify({ detail: { code: 'no_template', message: 'No such template', extra: 1 } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 422 }));

    const err = await api.printSpoolLabels(data).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('No such template');
    expect(err.status).toBe(422);
    expect(err.code).toBe('no_template');
    expect(err.detail).toEqual({ code: 'no_template', message: 'No such template', extra: 1 });
  });

  it('keeps a plain string detail as the message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ detail: 'nope' }), { status: 404 }));
    await expect(api.printSpoolLabels(data)).rejects.toMatchObject({ message: 'nope', status: 404, code: null });
  });

  it('falls back to HTTP <status> when the body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('oops', { status: 500 }));
    await expect(api.printSpoolLabels(data)).rejects.toMatchObject({ message: 'HTTP 500', status: 500 });
  });
});
