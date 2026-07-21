import { useEffect, useState } from 'react';

/** The value once it has stopped changing for `delay` ms. */
export function useSettledValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(handle);
  }, [value, delay]);
  return settled;
}
