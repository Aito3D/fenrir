import { ExternalLink } from 'lucide-react';
import { LINK_ICON_BUTTON_CLS, LINK_ICON_CLS, type CopiedPhase } from './linkActionHelpers';

/** The two components of the shared link-row vocabulary; see
 *  linkActionHelpers.ts for the classes, the hook and the open-tab recipe. */

/** The rising "Copied" beside a copy button. Renders nothing between flashes. */
export function CopiedLabel({ phase, text, testId }: { phase: CopiedPhase; text: string; testId: string }) {
  if (!phase) return null;
  return (
    <span className={`text-xs text-bambu-green ${phase === 'out' ? 'animate-fade-out-sm' : 'animate-rise-sm'}`} data-testid={testId}>
      {text}
    </span>
  );
}

/** Open a link the panel already holds in a new tab. A real anchor, not a
 *  button calling `window.open`: middle-click, ⌘-click and "copy link
 *  address" all keep working, and there is no popup blocker to argue with. */
export function OpenLinkButton({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label} title={label} className={LINK_ICON_BUTTON_CLS}>
      <ExternalLink className={LINK_ICON_CLS} aria-hidden="true" />
    </a>
  );
}
