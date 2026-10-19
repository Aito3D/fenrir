import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useArrivals } from '../../hooks/useArrivals';

describe('useArrivals', () => {
  it('flags nothing on the first ready render, then only keys that arrive later', () => {
    const { result, rerender } = renderHook(({ keys, ready }) => useArrivals(keys, ready), {
      initialProps: { keys: [] as number[], ready: false },
    });
    expect(result.current.size).toBe(0);

    rerender({ keys: [1, 2], ready: true });
    expect([...result.current]).toEqual([]);

    rerender({ keys: [3, 1, 2], ready: true });
    expect([...result.current]).toEqual([3]);
  });

  it('keeps a key flagged on later renders so a re-render never cuts its entrance', () => {
    const { result, rerender } = renderHook(({ keys }) => useArrivals(keys), { initialProps: { keys: ['a'] } });
    rerender({ keys: ['a', 'b'] });
    rerender({ keys: ['a', 'b'] });
    expect(result.current.has('b')).toBe(true);
    expect(result.current.has('a')).toBe(false);
  });
});
