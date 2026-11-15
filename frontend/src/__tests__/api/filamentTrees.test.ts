import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../../api/client';

describe('filament tree api methods', () => {
  afterEach(() => vi.restoreAllMocks());

  function mockFetch(body: BodyInit = '{}') {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    return seen;
  }
  const path = (u: string) => u.replace(/^.*\/api\/v1/, '');

  it('exportFilamentTrees posts tree_id and resolves a Blob', async () => {
    const seen = mockFetch('zipbytes');
    const blob = await api.exportFilamentTrees(3);
    expect(blob).toBeInstanceOf(Blob);
    expect(path(seen[0].url)).toBe('/filament-trees/export');
    expect(seen[0].init?.method).toBe('POST');
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({ tree_id: 3 });
    await api.exportFilamentTrees();
    expect(JSON.parse(String(seen[1].init?.body))).toEqual({});
  });

  it('getFilamentTreeNode sends only the params that are set', async () => {
    const seen = mockFetch('[]');
    await api.getFilamentTreeNode(1, { machine: 'H2S', nozzle: '0.4' });
    await api.getFilamentTreeNode(1, { colorId: 5 });
    await api.getFilamentTreeNode(1, {});
    expect(seen.map((s) => path(s.url))).toEqual([
      '/filament-trees/1/node?machine=H2S&nozzle=0.4',
      '/filament-trees/1/node?color_id=5',
      '/filament-trees/1/node',
    ]);
  });

  it('routes and methods', async () => {
    const seen = mockFetch();
    await api.getFilamentTrees();
    await api.setFilamentTreeTargets({ machines: ['H2S'], nozzles: ['0.4'] });
    await api.syncFilamentTrees();
    await api.setFilamentTreeNode(2, { machine: 'H2S', set: { a: '1' }, clear: ['b'] });
    await api.deleteFilamentTreeColor(2, 7);
    expect(seen.map((s) => [path(s.url), s.init?.method ?? 'GET'])).toEqual([
      ['/filament-trees', 'GET'],
      ['/filament-trees/targets', 'PUT'],
      ['/filament-trees/sync', 'POST'],
      ['/filament-trees/2/node', 'PUT'],
      ['/filament-trees/2/colors/7', 'DELETE'],
    ]);
    expect(JSON.parse(String(seen[3].init?.body))).toEqual({ machine: 'H2S', set: { a: '1' }, clear: ['b'] });
  });
});
