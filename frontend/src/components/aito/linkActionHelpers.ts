import { useEffect, useRef, useState } from 'react';
import { focusRingCls } from '../formStyles';

/** The detail panel's two "this card has a public link" rows — Online
 *  payment (BillingCard) and Tracking link (RecordCard) — share one control
 *  vocabulary: a row of icon-only buttons, the same size and tone, in the
 *  same order (open, copy, then anything destructive). Names live on
 *  `aria-label` + `title`, as on the quote action group. Before this module
 *  the payment row had a green "⧉ Copier" text button at 14px while the
 *  tracking row had grey 16px icon buttons, and the two rows — one card
 *  apart — read as two different kinds of thing.
 *
 *  Plain .ts, apart from the two components in linkActions.tsx, so the
 *  react-refresh rule (components-only modules) holds for both files. */

/** One icon button. `p-1.5` around a `w-4` glyph is 28px square, so with
 *  the row's `-my-1` pull it sits inside a `text-sm` line instead of
 *  growing it. */
export const LINK_ICON_BUTTON_CLS = `inline-flex items-center justify-center p-1.5 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-bambu-gray ${focusRingCls}`;

export const LINK_ICON_CLS = 'w-4 h-4';

const COPIED_HOLD_MS = 1500;
const COPIED_EXIT_MS = 150; // matches .animate-fade-out-sm

export type CopiedPhase = 'in' | 'out' | null;

/** The "Copied" confirmation's lifecycle: rises in (`animate-rise-sm`),
 *  holds, fades out (`animate-fade-out-sm`, index.css) and only then
 *  unmounts. A second copy inside the window restarts it rather than racing
 *  it, and unmounting mid-window (closing the panel right after a copy)
 *  clears the timers so nothing calls setState on a gone component. */
export function useCopiedFlash(): [CopiedPhase, () => void] {
  const [copied, setCopied] = useState<CopiedPhase>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);
  const flash = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    setCopied('in');
    timers.current = [
      window.setTimeout(() => setCopied('out'), COPIED_HOLD_MS),
      window.setTimeout(() => setCopied(null), COPIED_HOLD_MS + COPIED_EXIT_MS),
    ];
  };
  return [copied, flash];
}

/** Open a link the panel must first FETCH in a new tab. The tab is opened
 *  synchronously, inside the click, so the browser attributes it to the
 *  gesture; the URL lands in it once the request resolves. Safari drops a
 *  `window.open` issued after an await, Chrome tolerates one for a few
 *  seconds — opening first is the one recipe that works in both. `resolve`
 *  returning null (or throwing) closes the blank tab again; the caller
 *  handles the toast. When the blocker still refuses (`window.open` gives
 *  null) it falls back to opening after the fetch, which is better than
 *  nothing. */
export async function openFetchedLink(resolve: () => Promise<string | null>): Promise<void> {
  const win = window.open('', '_blank');
  try {
    const url = await resolve();
    if (!url) {
      win?.close();
      return;
    }
    if (win) {
      win.opener = null;
      win.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  } catch (err) {
    win?.close();
    throw err;
  }
}
