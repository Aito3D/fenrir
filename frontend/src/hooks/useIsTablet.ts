import { useMediaQuery } from './useMediaQuery';

/** Touch screens from phone-width up: the Aito tablet board.
 *
 *  Primary pointer (`pointer`), not `any-pointer`: a touchscreen laptop's
 *  primary input is the mouse and keeps the desktop board; an iPad, even with
 *  a trackpad attached, reports a coarse primary pointer. */
export const TABLET_QUERY = '(min-width: 768px) and (pointer: coarse)';

export function useIsTablet(): boolean {
  return useMediaQuery(TABLET_QUERY, () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(TABLET_QUERY).matches
      : false,
  );
}
