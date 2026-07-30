/**
 * Regression test for the page-crossfade wiring: React Router only calls
 * document.startViewTransition through the DATA router (createBrowserRouter +
 * the react-router/dom RouterProvider). This test clicks a `viewTransition`
 * NavLink under that exact setup and asserts the browser API is invoked —
 * if this fails, page navigation silently loses its crossfade.
 */

import { StrictMode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createBrowserRouter, RouterProvider, NavLink } from 'react-router-dom';

function makeTransitionStub() {
  return {
    ready: Promise.resolve(),
    finished: Promise.resolve(),
    updateCallbackDone: Promise.resolve(),
    skipTransition: () => {},
  };
}

afterEach(() => {
  // @ts-expect-error cleanup of test stub
  delete document.startViewTransition;
  window.history.replaceState(null, '', '/');
});

describe('view transition wiring (data router)', () => {
  it('calls document.startViewTransition when a viewTransition NavLink is clicked', async () => {
    const calls: Array<() => void | Promise<void>> = [];
    // @ts-expect-error jsdom has no VT; stub it before the router mounts
    document.startViewTransition = vi.fn((cb: () => void | Promise<void>) => {
      calls.push(cb);
      // Run the DOM-update callback like a real browser would.
      Promise.resolve().then(() => cb());
      return makeTransitionStub();
    });

    const router = createBrowserRouter([
      {
        path: '/',
        element: (
          <div>
            <NavLink to="/other" viewTransition>
              go
            </NavLink>
            <span>home-page</span>
          </div>
        ),
      },
      { path: '/other', element: <span>other-page</span> },
    ]);

    render(<RouterProvider router={router} />);
    expect(screen.getByText('home-page')).toBeInTheDocument();

    await userEvent.click(screen.getByText('go'));

    // The click must have gone through the View Transitions API.
    expect(document.startViewTransition).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('other-page')).toBeInTheDocument();
  });

  it('does not skip the transition under StrictMode (main.tsx wraps the app in it)', async () => {
    const skipSpy = vi.fn();
    // @ts-expect-error jsdom has no VT; stub it before the router mounts
    document.startViewTransition = vi.fn((cb: () => void | Promise<void>) => {
      Promise.resolve().then(() => cb());
      return { ...makeTransitionStub(), skipTransition: skipSpy };
    });

    const router = createBrowserRouter([
      {
        path: '/',
        element: (
          <div>
            <NavLink to="/other" viewTransition>
              go
            </NavLink>
            <span>home-page</span>
          </div>
        ),
      },
      { path: '/other', element: <span>other-page</span> },
    ]);

    render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );

    await userEvent.click(screen.getByText('go'));

    expect(document.startViewTransition).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('other-page')).toBeInTheDocument();
    expect(skipSpy).not.toHaveBeenCalled();
  });
});
