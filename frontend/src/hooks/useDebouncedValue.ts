import { useEffect, useState } from 'react';

/**
 * `value`, held back until it has stopped changing for `delayMs`.
 *
 * Starts at the first `value`; every change restarts the timer, and unmounting
 * cancels a pending update.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
