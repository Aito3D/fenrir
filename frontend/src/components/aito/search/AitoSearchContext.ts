import { createContext, useContext } from 'react';
import type { SearchHit } from '../../../utils/aitoSearch';

export type TrashSearchState = 'loading' | 'error' | 'ready';

/** What the search box's dropdown shows, provided by `AitoPage` — which owns
 *  the query and both lists — so the desktop, tablet and phone headers can
 *  each render the box without threading three more props through. */
export interface AitoSearchValue {
  hits: SearchHit[];
  trash: TrashSearchState;
  onSelect: (id: number) => void;
}

export const AitoSearchContext = createContext<AitoSearchValue | null>(null);

export function useAitoSearch(): AitoSearchValue | null {
  return useContext(AitoSearchContext);
}
