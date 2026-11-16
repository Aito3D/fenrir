import { describe, expect, it, vi } from 'vitest';
import { preloadRoute, type RoutePreloadTable } from '../../utils/routePreload';

/** The URL is known at t=0, but React Router only asks for a lazy route's
 *  chunk after auth has resolved — two round trips later. `preloadRoute`
 *  starts the matching chunk's import immediately; `React.lazy` then finds
 *  it already resolved. */
describe('preloadRoute', () => {
  function table() {
    const aito = vi.fn(() => Promise.resolve({}));
    const projects = vi.fn(() => Promise.resolve({}));
    const projectDetail = vi.fn(() => Promise.resolve({}));
    const t: RoutePreloadTable = [
      [/^\/aito(\/|$)/, aito],
      [/^\/projects\/[^/]+$/, projectDetail],
      [/^\/projects(\/|$)/, projects],
    ];
    return { t, aito, projects, projectDetail };
  }

  it('starts the loader of the first matching route', () => {
    const { t, aito, projects, projectDetail } = table();
    preloadRoute('/aito', t);
    preloadRoute('/aito/123', t);
    expect(aito).toHaveBeenCalledTimes(1);
    preloadRoute('/projects/7', t);
    expect(projectDetail).toHaveBeenCalledTimes(1);
    expect(projects).not.toHaveBeenCalled();
    preloadRoute('/projects', t);
    expect(projects).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a path with no lazy route', () => {
    const { t, aito, projects, projectDetail } = table();
    preloadRoute('/login', t);
    expect(aito).not.toHaveBeenCalled();
    expect(projects).not.toHaveBeenCalled();
    expect(projectDetail).not.toHaveBeenCalled();
  });

  it('swallows a failed import; the lazy route will report it on its own', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('chunk gone')));
    expect(() => preloadRoute('/aito', [[/^\/aito/, failing]])).not.toThrow();
    await Promise.resolve();
    expect(failing).toHaveBeenCalledTimes(1);
  });
});

describe('prefetchRoutesOnHover', () => {
  it('starts a route when the pointer reaches a link to it, and ignores other elements', async () => {
    const { prefetchRoutesOnHover } = await import('../../utils/routePreload');
    const files = vi.fn(() => Promise.resolve({}));
    prefetchRoutesOnHover([[/^\/files\/?$/, files]]);

    document.body.innerHTML = '<a href="/files"><span id="label">Files</span></a><button id="other">x</button>';
    document.getElementById('other')!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    expect(files).not.toHaveBeenCalled();
    document.getElementById('label')!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    document.getElementById('label')!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    expect(files).toHaveBeenCalledTimes(1);
  });
});
