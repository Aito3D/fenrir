/**
 * Unit tests for rewriteMediaSrcWithToken — the DOM walker that retrofits a
 * camera stream token onto <img>/<video> src URLs that rendered before the
 * token arrived (regression guard for the post-login blank-thumbnails bug) —
 * and for useStreamTokenSync, which owns the auth-gated token fetch and the
 * capture-phase error listener that auto-refreshes an invalidated token.
 *
 * Since #3025 rewriteMediaSrcWithToken carries two tokens and picks per
 * URL: live-camera URLs take the camera stream token, everything else
 * takes the media token.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isCameraUrl, rewriteMediaSrcWithToken, useStreamTokenSync } from '../../hooks/useCameraStreamToken';
import { getStreamToken, setStreamToken } from '../../api/client';
import type { UserResponse } from '../../api/client';

// Mutable auth state read fresh by the mocked useAuth() on every render — the
// test flips `.value` and calls renderHook's `rerender()` to simulate
// AuthContext settling (loading -> resolved) the way the real provider does.
const authState = vi.hoisted(() => ({
  value: { authEnabled: false, user: null as UserResponse | null, loading: true },
}));
// hasPermission is vacuously true here: these tests cover the auth gate, not the
// camera:view split (#3025), and the hook reads it on every render.

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ ...authState.value, hasPermission: () => true }),
}));

// Only api.getCameraStreamToken is faked; setStreamToken/getStreamToken stay
// real so the effect's module-level token state behaves exactly as in prod.
const getCameraStreamTokenMock = vi.hoisted(() => vi.fn());
// Since #3025 the hook mints a media token alongside; it is not under test
// here, so it resolves to a fixed value rather than hitting the network.
const getMediaTokenMock = vi.hoisted(() => vi.fn(async () => ({ token: 'media-tok' })));
vi.mock('../../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../api/client')>();
  return {
    ...mod,
    api: { ...mod.api, getCameraStreamToken: getCameraStreamTokenMock, getMediaToken: getMediaTokenMock },
  };
});

describe('rewriteMediaSrcWithToken', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
  });

  const addImg = (src: string) => {
    const img = document.createElement('img');
    img.setAttribute('src', src);
    root.appendChild(img);
    return img;
  };

  const addVideo = (src: string) => {
    const v = document.createElement('video');
    v.setAttribute('src', src);
    root.appendChild(v);
    return v;
  };

  it('appends token to /api/v1/ images that have no query string', () => {
    const img = addImg('/api/v1/library/files/42/thumbnail');
    const count = rewriteMediaSrcWithToken(root, 'abc123', null);
    expect(count).toBe(1);
    expect(img.getAttribute('src')).toBe('/api/v1/library/files/42/thumbnail?token=abc123');
  });

  it('appends token to URLs that already have a query string using & separator', () => {
    const img = addImg('/api/v1/archives/5/thumbnail?v=1700000000000');
    rewriteMediaSrcWithToken(root, 'abc123', null);
    expect(img.getAttribute('src')).toBe('/api/v1/archives/5/thumbnail?v=1700000000000&token=abc123');
  });

  it('leaves images alone that already carry the current token', () => {
    const img = addImg('/api/v1/library/files/42/thumbnail?token=abc123');
    const count = rewriteMediaSrcWithToken(root, 'abc123', null);
    expect(count).toBe(0);
    expect(img.getAttribute('src')).toBe('/api/v1/library/files/42/thumbnail?token=abc123');
  });

  it('replaces a stale token with the current one', () => {
    const img = addImg('/api/v1/library/files/42/thumbnail?token=OLD');
    rewriteMediaSrcWithToken(root, 'NEW', null);
    expect(img.getAttribute('src')).toBe('/api/v1/library/files/42/thumbnail?token=NEW');
  });

  it('replaces a stale token that sits in the middle of the query string', () => {
    const img = addImg('/api/v1/archives/5/thumbnail?token=OLD&v=1700000000000');
    rewriteMediaSrcWithToken(root, 'NEW', null);
    // Old token stripped, v preserved, new token appended.
    expect(img.getAttribute('src')).toBe('/api/v1/archives/5/thumbnail?v=1700000000000&token=NEW');
  });

  it('ignores images that do not point at /api/v1/', () => {
    const img = addImg('https://cdn.example.com/static/logo.png');
    rewriteMediaSrcWithToken(root, 'abc123', null);
    expect(img.getAttribute('src')).toBe('https://cdn.example.com/static/logo.png');
  });

  it('updates <video> elements as well', () => {
    const v = addVideo('/api/v1/printers/7/camera/stream?fps=10');
    rewriteMediaSrcWithToken(root, null, 'abc123');
    expect(v.getAttribute('src')).toBe('/api/v1/printers/7/camera/stream?fps=10&token=abc123');
  });

  it('url-encodes tokens containing special characters', () => {
    const img = addImg('/api/v1/library/files/42/thumbnail');
    rewriteMediaSrcWithToken(root, 'a b/c=d', null);
    expect(img.getAttribute('src')).toBe('/api/v1/library/files/42/thumbnail?token=a%20b%2Fc%3Dd');
  });
});

describe('useStreamTokenSync', () => {
  const mockUser: UserResponse = {
    id: 1,
    username: 'alice',
    role: 'admin',
    is_active: true,
    is_admin: true,
    auth_source: 'local',
    groups: [],
    permissions: [],
    created_at: '2026-01-01T00:00:00Z',
  };

  const makeWrapper = (client: QueryClient) =>
    function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(QueryClientProvider, { client }, children);
    };

  const makeQueryClient = () =>
    new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  afterEach(() => {
    cleanup();
    // Real module-level singleton — reset so one test's token can't leak
    // into the next (mirrors the hook's own unmount cleanup).
    setStreamToken(null);
    vi.restoreAllMocks();
    authState.value = { authEnabled: false, user: null, loading: true };
  });

  it('fetches the camera stream token once auth has resolved, and stores it via setStreamToken', async () => {
    authState.value = { authEnabled: true, user: mockUser, loading: false };
    getCameraStreamTokenMock.mockResolvedValue({ token: 'tok-1' });
    const qc = makeQueryClient();

    const { unmount } = renderHook(() => useStreamTokenSync(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(getCameraStreamTokenMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getStreamToken()).toBe('tok-1'));

    unmount();
    // Effect cleanup on unmount clears the shared token.
    expect(getStreamToken()).toBeNull();
  });

  it('keeps the token query disabled while auth is still loading (401-on-login-page race gate), then fires once the gate opens', async () => {
    // Real pre-settle default from AuthProvider's initial state: `loading`
    // starts true and `authEnabled` defaults to false until checkAuthStatus
    // resolves. The retired gate (`authEnabled ? !!user : true`) evaluated
    // to `true` here — firing an unauthenticated fetch on the login page
    // before AuthContext had a chance to settle. The current gate must not.
    authState.value = { authEnabled: false, user: null, loading: true };
    getCameraStreamTokenMock.mockResolvedValue({ token: 'tok-2' });
    const qc = makeQueryClient();

    const { rerender, unmount } = renderHook(() => useStreamTokenSync(), { wrapper: makeWrapper(qc) });

    // Query is registered but disabled — react-query reports it idle, and
    // the fetcher must not have been invoked at all.
    expect(qc.getQueryState(['camera-stream-token', null])?.fetchStatus).toBe('idle');
    expect(getCameraStreamTokenMock).not.toHaveBeenCalled();

    // AuthContext settles: loading resolves and the user arrives.
    authState.value = { authEnabled: true, user: mockUser, loading: false };
    rerender();

    await waitFor(() => expect(getCameraStreamTokenMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getStreamToken()).toBe('tok-2'));

    unmount();
  });

  it('auto-refreshes an invalidated token on a tokened <img> error, debounced for 5s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const elements: HTMLElement[] = [];
    try {
      authState.value = { authEnabled: true, user: mockUser, loading: false };
      getCameraStreamTokenMock.mockResolvedValue({ token: 'tok-err' });
      const qc = makeQueryClient();
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      const { unmount } = renderHook(() => useStreamTokenSync(), { wrapper: makeWrapper(qc) });
      await waitFor(() => expect(getStreamToken()).toBe('tok-err'));

      const img = document.createElement('img');
      img.src = `/api/v1/printers/1/camera/stream?token=${encodeURIComponent('tok-err')}`;
      document.body.appendChild(img);
      elements.push(img);

      // First error on a URL carrying the current token: refresh triggered.
      img.dispatchEvent(new Event('error'));
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['camera-stream-token'] });

      // A second error within the 5s debounce window must not re-invalidate.
      await vi.advanceTimersByTimeAsync(1000);
      img.dispatchEvent(new Event('error'));
      expect(invalidateSpy).toHaveBeenCalledTimes(1);

      // Once the debounce window elapses, a further error refreshes again.
      await vi.advanceTimersByTimeAsync(4100);
      img.dispatchEvent(new Event('error'));
      expect(invalidateSpy).toHaveBeenCalledTimes(2);

      unmount();
    } finally {
      elements.forEach((el) => el.remove());
      vi.useRealTimers();
    }
  });

  it('ignores an error on an element whose src does not carry the current token', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const elements: HTMLElement[] = [];
    try {
      authState.value = { authEnabled: true, user: mockUser, loading: false };
      getCameraStreamTokenMock.mockResolvedValue({ token: 'tok-good' });
      const qc = makeQueryClient();
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      const { unmount } = renderHook(() => useStreamTokenSync(), { wrapper: makeWrapper(qc) });
      await waitFor(() => expect(getStreamToken()).toBe('tok-good'));

      // Proves the listener IS wired up and CAN fire (positive case) before
      // trusting the negative assertion below.
      const goodImg = document.createElement('img');
      goodImg.src = '/api/v1/printers/1/camera/stream?token=tok-good';
      document.body.appendChild(goodImg);
      elements.push(goodImg);
      goodImg.dispatchEvent(new Event('error'));
      expect(invalidateSpy).toHaveBeenCalledTimes(1);

      invalidateSpy.mockClear();
      // Clear the debounce window from the first error so this assertion
      // isolates the src/token-match check, not the refreshingRef debounce.
      await vi.advanceTimersByTimeAsync(5100);

      // A stale/unrelated src (no token, or a different one) must not
      // trigger a refresh — the handler is asserting on the CURRENT token.
      const staleImg = document.createElement('img');
      staleImg.src = '/api/v1/printers/1/camera/stream?token=stale-token';
      document.body.appendChild(staleImg);
      elements.push(staleImg);
      staleImg.dispatchEvent(new Event('error'));
      expect(invalidateSpy).not.toHaveBeenCalled();

      unmount();
    } finally {
      elements.forEach((el) => el.remove());
      vi.useRealTimers();
    }
  });
});

// #3025 — the two tokens are not interchangeable. A user without camera:view
// holds a media token and no camera token; sending the media token to a camera
// route (or the camera token to a thumbnail) would 401 either way.
describe('rewriteMediaSrcWithToken picks the token per URL (#3025)', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
  });

  const addImg = (src: string) => {
    const img = document.createElement('img');
    img.setAttribute('src', src);
    root.appendChild(img);
    return img;
  };

  it('gives a thumbnail the media token, not the camera token', () => {
    const img = addImg('/api/v1/library/files/42/thumbnail');
    rewriteMediaSrcWithToken(root, 'media-tok', 'camera-tok');
    expect(img.getAttribute('src')).toBe('/api/v1/library/files/42/thumbnail?token=media-tok');
  });

  it('gives a live camera stream the camera token, not the media token', () => {
    const img = addImg('/api/v1/printers/7/camera/stream?fps=10');
    rewriteMediaSrcWithToken(root, 'media-tok', 'camera-tok');
    expect(img.getAttribute('src')).toBe('/api/v1/printers/7/camera/stream?fps=10&token=camera-tok');
  });

  it('still rewrites thumbnails for a user who has no camera token at all', () => {
    const thumb = addImg('/api/v1/archives/5/thumbnail');
    const stream = addImg('/api/v1/printers/7/camera/stream?fps=10');
    const count = rewriteMediaSrcWithToken(root, 'media-tok', null);
    expect(count).toBe(1);
    expect(thumb.getAttribute('src')).toBe('/api/v1/archives/5/thumbnail?token=media-tok');
    // Left untouched rather than given a token that would not work on it.
    expect(stream.getAttribute('src')).toBe('/api/v1/printers/7/camera/stream?fps=10');
  });

  it('classifies the three camera routes as camera and the media routes as media', () => {
    expect(isCameraUrl('/api/v1/printers/1/camera/stream?fps=10')).toBe(true);
    expect(isCameraUrl('/api/v1/printers/1/camera/snapshot')).toBe(true);
    expect(isCameraUrl('/api/v1/printers/1/camera/plate-detection/references/0/thumbnail')).toBe(true);
    expect(isCameraUrl('/api/v1/library/files/42/thumbnail')).toBe(false);
    expect(isCameraUrl('/api/v1/archives/5/timelapse')).toBe(false);
    expect(isCameraUrl('/api/v1/printers/1/cover')).toBe(false);
    expect(isCameraUrl('/api/v1/external-links/3/icon')).toBe(false);
  });
});
