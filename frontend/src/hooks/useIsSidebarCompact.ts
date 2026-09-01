import { useMediaQuery } from './useMediaQuery';

const SIDEBAR_COMPACT_BREAKPOINT = 1144;

export function useIsSidebarCompact(): boolean {
  return useMediaQuery(`(max-width: ${SIDEBAR_COMPACT_BREAKPOINT - 1}px)`, () =>
    typeof window !== 'undefined' ? window.innerWidth < SIDEBAR_COMPACT_BREAKPOINT : false
  );
}
