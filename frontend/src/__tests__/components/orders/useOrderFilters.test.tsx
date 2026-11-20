import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { useOrderFilters } from '../../../components/orders/useOrderFilters';

const { getUiPrefs, putUiPref } = vi.hoisted(() => ({
  getUiPrefs: vi.fn(),
  putUiPref: vi.fn(),
}));
vi.mock('../../../api/client', () => ({ api: { getUiPrefs, putUiPref } }));

beforeEach(() => {
  getUiPrefs.mockReset().mockResolvedValue({});
  putUiPref.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
});

function Box() {
  const f = useOrderFilters();
  return (
    <>
      <input data-testid="q" value={f.query} onChange={e => f.setQuery(e.target.value)} />
      <output data-testid="state">{`${f.payFilter}|${f.follow}|${f.sort.key}|${f.sort.flipped}|${f.coreOnly}`}</output>
      <button onClick={() => f.setSort({ key: 'value', flipped: true })}>sort</button>
      <button onClick={() => f.chooseCoreOnly(false)}>core</button>
      <button onClick={() => f.setCoreOnly(false)}>core-temp</button>
    </>
  );
}
const setValue = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const mount = (url: string) => {
  const router = createMemoryRouter([{ path: '/orders', element: <Box /> }], { initialEntries: [url] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
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

  it('brings back the sort and filters saved on the account', async () => {
    getUiPrefs.mockResolvedValue({ orders: { pay: 'unpaid', follow: null, sort: 'customer', flip: true, coreOnly: false } });
    const { router } = mount('/orders');
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('unpaid|null|customer|true|false'));
    await waitFor(() => expect(router.state.location.search).toBe('?pay=unpaid&sort=customer&flip=1'));
    expect(putUiPref).not.toHaveBeenCalled();
  });

  it('lets a link that names its filters win over the saved ones', async () => {
    getUiPrefs.mockResolvedValue({ orders: { pay: 'unpaid', coreOnly: false } });
    mount('/orders?pay=paid');
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('paid|null|age|false|false'));
  });

  it('saves what the viewer picks, merged with what was saved, but not a temporary switch', async () => {
    getUiPrefs.mockResolvedValue({ orders: { pay: 'unpaid' } });
    mount('/orders');
    await waitFor(() => expect(screen.getByTestId('state').textContent).toContain('unpaid'));
    fireEvent.click(screen.getByText('core-temp'));
    expect(putUiPref).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('sort'));
    expect(putUiPref).toHaveBeenLastCalledWith('orders', { pay: 'unpaid', sort: 'value', flip: true });
    fireEvent.click(screen.getByText('core'));
    // the second save waits for the first to settle
    await waitFor(() =>
      expect(putUiPref).toHaveBeenLastCalledWith('orders', { pay: 'unpaid', sort: 'value', flip: true, coreOnly: false }),
    );
  });

  it('keeps a pick made before the account answered and saves it merged over the account copy', async () => {
    let answer!: (v: unknown) => void;
    getUiPrefs.mockReturnValue(new Promise(r => (answer = r)));
    mount('/orders');
    fireEvent.click(screen.getByText('sort'));
    expect(putUiPref).not.toHaveBeenCalled();
    expect(screen.getByTestId('state').textContent).toBe('all|null|value|true|true');
    await act(async () => answer({ orders: { pay: 'unpaid', follow: 'x', coreOnly: false } }));
    await waitFor(() => expect(putUiPref).toHaveBeenCalledTimes(1));
    expect(putUiPref).toHaveBeenCalledWith('orders', { pay: 'unpaid', follow: 'x', coreOnly: false, sort: 'value', flip: true });
    expect(screen.getByTestId('state').textContent).toBe('all|null|value|true|true');
  });

  it('never writes a partial copy over the account after the prefs failed to load', async () => {
    let fail!: (e: Error) => void;
    getUiPrefs.mockReturnValue(new Promise((_, rej) => (fail = rej)));
    mount('/orders');
    fireEvent.click(screen.getByText('sort'));
    await act(async () => fail(new Error('down')));
    fireEvent.click(screen.getByText('core'));
    expect(putUiPref).not.toHaveBeenCalled();
    expect(screen.getByTestId('state').textContent).toBe('all|null|value|true|false');
  });

  it('sends the saves in pick order even when the first one is slower, and a failed one blocks nothing', async () => {
    getUiPrefs.mockResolvedValue({});
    const arrived: unknown[] = [];
    let release!: () => void;
    putUiPref.mockImplementationOnce((_k: string, v: unknown) => {
      // the first PUT only reaches the server once released: a later one sent at once would overtake it
      return new Promise((_, rej) => (release = () => (arrived.push(v), rej(new Error('down')))));
    });
    putUiPref.mockImplementation((_k: string, v: unknown) => {
      arrived.push(v);
      return Promise.resolve();
    });
    mount('/orders');
    await waitFor(() => expect(getUiPrefs).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByText('sort'));
    fireEvent.click(screen.getByText('core'));
    await act(async () => {});
    expect(putUiPref).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await waitFor(() => expect(putUiPref).toHaveBeenCalledTimes(2));
    expect(arrived).toEqual([
      { sort: 'value', flip: true },
      { sort: 'value', flip: true, coreOnly: false },
    ]);
  });
});
