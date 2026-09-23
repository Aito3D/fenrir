import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import aito3dLogo from '../../assets/aito3d_logo.png';
import { SHOP_MAIL_HREF, SHOP_TEL_HREF } from '../../utils/aitoShop';
import { BRAND, CARD, FOCUS, PAGE, PRESS, delayAt } from '../../utils/trackingShell';
import { TRACK_MOTION } from '../../utils/aitoTracking';
import { AITO3D_SENDER } from '../../utils/shippingLabel';
import type { PanelTrigger } from './TrackingPayment';

/** The rendered pieces the public tracking pages share: the logo, the
 *  loading skeleton and the contact footer. Split out of AitoTrackPage when
 *  the code-entry page arrived, so the two pages are one surface and not two
 *  copies of it. The style tokens live in utils/trackingShell.ts, the
 *  language hook in hooks/useTrackingLanguage.ts. */

/** The asset is black + cyan; invert + hue-rotate turns the black white and
 *  brings the cyan back to cyan on the dark card. 26 px tall (§7b final
 *  pixel pass) — pixel-exact because this repo's 14.4 px root shorts
 *  Tailwind's rem-based height utilities. */
export function Logo({ className = '' }: { className?: string }) {
  return (
    <img
      src={aito3dLogo}
      alt={BRAND}
      className={`mx-auto h-[26px] w-auto ${className}`}
      style={{ filter: 'invert(1) hue-rotate(180deg)' }}
    />
  );
}

/** What stands in the card's body while the page waits — for its data, for
 *  its language bundle, or for both. Two pulsing blocks in the shape of what
 *  lands there, and nothing to read: no text is translated yet. Hidden from
 *  screen readers, which get the content itself once it arrives. */
export function CardSkeleton() {
  return (
    <div className="mt-[32px] space-y-[32px]" aria-hidden="true">
      <div className="h-[64px] rounded-[12px] bg-aito-line/60 motion-safe:animate-pulse" />
      <div className="rounded-[12px] bg-aito-line/60 motion-safe:animate-pulse sm:min-h-[132px]" />
    </div>
  );
}

/** The quiet "paid" row TrackingPayment and TrackingInvoice both render:
 *  a dot-and-title line plus a sub-line, no border, so paid never competes
 *  with the state above it. Parameterised by dot colour and copy — each
 *  caller keeps its own translation keys and dot source (a literal for the
 *  online payment, a state-keyed lookup for invoices). Takes `data-testid`
 *  / `data-state` as named-literal props (not composed here) so each call
 *  site's own testid/state text stays a source-visible literal.
 *  `pop`: the row arrived by a refetch that flipped the state to paid while
 *  the page was open — the dot pops in one beat after the row rises, so the
 *  moment the client came back for reads as a moment. */
export function TrackingPaidRow({
  'data-testid': testid,
  'data-state': state,
  dotClassName,
  title,
  sub,
  pop = false,
}: {
  'data-testid': string;
  'data-state': string;
  dotClassName: string;
  title: ReactNode;
  sub: ReactNode;
  pop?: boolean;
}) {
  return (
    <div data-testid={testid} data-state={state} className="text-[15px]">
      <div className="flex items-center gap-[8px]">
        <span
          className={`h-[8px] w-[8px] shrink-0 rounded-full ${dotClassName} ${pop ? 'animate-track-pop' : ''}`}
          style={pop ? delayAt(TRACK_MOTION.flipDot) : undefined}
          data-testid={pop ? `${testid}-dot-pop` : undefined}
          aria-hidden="true"
        />
        <span className="font-semibold text-aito-ink">{title}</span>
      </div>
      <p className="mt-[4px] text-[13px] text-aito-muted">{sub}</p>
    </div>
  );
}

/** Drops in from above once the content has landed (`at` ms after the
 *  page's clock starts); mounted only when there is something above it,
 *  so it never plays over the skeleton and then again over the content. */
export function Footer({ at, shop }: { at: number; shop?: PanelTrigger }) {
  const { t } = useTranslation();
  const linkCls = `inline-flex min-h-[44px] items-center text-aito-muted transition-colors duration-150 hover:text-aito-ink ${FOCUS} focus-visible:text-aito-ink`;
  return (
    <footer className="animate-track-drop mt-[32px] border-t border-aito-line/60 pt-[24px] text-center text-[13.5px]" style={delayAt(at)} data-testid="track-footer">
      <p className="text-aito-ink">{t('aito.track.footerQuestion')}</p>
      <p className="mt-[8px]">
        <a className={linkCls} href={SHOP_TEL_HREF}>
          {AITO3D_SENDER.phone}
        </a>
        {/* The dot only makes sense while both links share a line; below
            360 px the email wraps, and a dangling dot would trail the phone. */}
        <span className="mx-[4px] max-[359px]:hidden" aria-hidden="true">
          ·
        </span>
        <a className={linkCls} href={SHOP_MAIL_HREF}>
          {AITO3D_SENDER.email}
        </a>
      </p>
      {/* The way to the shop itself — the tracking page's "Nous trouver"
          panel — only where the page has one (the code-entry page has no
          order, so no panel). */}
      {shop && (
        <button
          type="button"
          aria-expanded={shop.open}
          aria-controls={shop.controls}
          onClick={(e) => shop.toggle(e.currentTarget)}
          className={`mt-[6px] inline-flex min-h-[40px] items-center gap-[7px] rounded-full border py-0 pr-[14px] pl-[12px] text-[13px] font-semibold transition-[color,border-color,background-color,transform] duration-150 active:scale-[0.97] ${FOCUS} ${
            shop.open ? 'border-aito-cyan/45 bg-aito-cyan/8 text-aito-cyan' : 'border-aito-line text-aito-muted hover:border-aito-muted/55 hover:text-aito-ink'
          }`}
        >
          <MapPin className="h-[14px] w-[14px]" aria-hidden="true" />
          {t('aito.track.shop.find')}
        </button>
      )}
    </footer>
  );
}

// A redeploy that swaps the hashed chunk files while a client's tab is
// still open (or a flaky mobile link mid-reload) makes `lazyWithReload`'s
// own one-shot retry (App.tsx) rethrow instead of recovering silently.
// Recognised by name (Firefox/older bundlers) or by the wording Vite and
// most browsers use for a failed dynamic `import()`.
const CHUNK_LOAD_ERROR_PATTERN = /dynamically imported module|loading chunk/i;
function isChunkLoadError(error: Error): boolean {
  return error.name === 'ChunkLoadError' || CHUNK_LOAD_ERROR_PATTERN.test(error.message);
}

/** The branded stand-in for `App.tsx`'s app-wide crash screen (logo, stack
 *  trace, "UI Crash") on the four public tracking routes — a client who
 *  followed a link printed on their quote must never see raw JavaScript,
 *  only the same "something went wrong, try again" card the page already
 *  shows for a failed fetch. A class component only for `getDerivedState-
 *  FromError`/`componentDidCatch` (no hook equivalent exists); the text
 *  itself is rendered by a plain function child so it can call
 *  `useTranslation()`. Reuses `common.errorLoading` / `common.retry`
 *  rather than adding tracking-specific copy, so no new key needs the
 *  14-locale translation sweep. */
function TrackingCrashCard({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={PAGE} data-testid="track-crash">
      <div className={CARD}>
        <Logo className="mb-[20px]" />
        <p className="mt-[32px] text-center text-[15px] text-aito-muted">{t('common.errorLoading')}</p>
        <div className="mt-[16px] text-center">
          <button
            type="button"
            onClick={onRetry}
            className={`inline-flex min-h-[44px] items-center justify-center rounded-[8px] border border-aito-cyan/35 px-[24px] text-[14px] font-semibold text-aito-cyan hover:bg-aito-cyan/10 ${PRESS} ${FOCUS}`}
          >
            {t('common.retry')}
          </button>
        </div>
      </div>
    </div>
  );
}

export class TrackingErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Tracking page crash:', error, errorInfo);
  }

  // Clears the crash first so a second failure re-renders the same card
  // instead of getting stuck; a chunk-load failure additionally forces a
  // full reload (the fix a stale index.html needs) rather than retrying a
  // React tree that can never mount without the missing chunk.
  retry = () => {
    const { error } = this.state;
    this.setState({ error: null });
    if (error && isChunkLoadError(error)) {
      window.location.reload();
    }
  };

  render() {
    if (this.state.error) {
      return <TrackingCrashCard onRetry={this.retry} />;
    }
    return this.props.children;
  }
}
