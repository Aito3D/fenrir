import { createContext, useContext } from 'react';
import type { Vec } from './particles';
import type { CelebrationVariant } from './variants';

/** The celebration's public surface: one function, handed down by
 *  `CelebrationProvider`.
 *
 *  Split from the provider because Fast Refresh will not touch a module that
 *  exports both a component and something else — and the something else here
 *  is a hook every card on the board calls. */

/** Where a burst starts. A `DOMRect` (the card's) is reduced to its centre,
 *  which is what every caller actually means. */
export type CelebrationOrigin = DOMRect | Vec;

export type Celebrate = (origin: CelebrationOrigin, variant?: CelebrationVariant) => void;

const noop: Celebrate = () => {};

export const CelebrationContext = createContext<Celebrate>(noop);

/** The default `celebrate` is a no-op, deliberately.
 *
 *  `useColumnMoveMutation` is also used from the Done grid (to un-archive),
 *  and it is mounted in tests with no provider around it. A hook that threw
 *  or warned outside the board would make a decorative layer a hard
 *  dependency of a data mutation, which it is not. */
export function useCelebration(): Celebrate {
  return useContext(CelebrationContext);
}
