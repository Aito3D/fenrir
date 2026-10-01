import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * One URL search parameter that a page acts on once (`/aito?card=41`,
 * `/printers?focus=7`) and then drops. `clear` removes only that parameter and
 * replaces the history entry, so a refresh or Back does not act on it again.
 */
export function useDeepLinkParam(name: string): [value: string | null, clear: () => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const clear = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(name);
        return next;
      },
      { replace: true },
    );
  }, [name, setSearchParams]);
  return [searchParams.get(name), clear];
}
