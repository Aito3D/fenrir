import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { useOrderFilters } from '../../../components/orders/useOrderFilters';

function Box() {
  const { query, setQuery } = useOrderFilters();
  return <input data-testid="q" value={query} onChange={e => setQuery(e.target.value)} />;
}
const setValue = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const mount = (url: string) => {
  const router = createMemoryRouter([{ path: '/orders', element: <Box /> }], { initialEntries: [url] });
  render(<RouterProvider router={router} />);
  return { router, input: screen.getByTestId('q') as HTMLInputElement };
};

describe('useOrderFilters', () => {
  it('keeps a keystroke typed before the router committed the previous URL change', async () => {
    const { router, input } = mount('/orders');
    // Real scheduling: the router commits in a transition, so no act() around the keystrokes.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      setValue(input, 'a');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      setValue(input, 'ab');
      await new Promise(r => setTimeout(r, 100));
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    }
    expect(input.value).toBe('ab');
    expect(router.state.location.search).toBe('?q=ab');
  });

  it('still copies a genuine outside URL change into the filters', async () => {
    const { router, input } = mount('/orders?q=abc');
    expect(input.value).toBe('abc');
    await act(async () => {
      await router.navigate('/orders?q=zzz');
    });
    expect(input.value).toBe('zzz');
    await act(async () => {
      await router.navigate('/orders');
    });
    expect(input.value).toBe('');
  });
});
