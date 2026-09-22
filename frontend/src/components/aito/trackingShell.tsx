import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import aito3dLogo from '../../assets/aito3d_logo.png';
import { SHOP_MAIL_HREF, SHOP_TEL_HREF } from '../../utils/aitoShop';
import { BRAND, FOCUS, delayAt } from '../../utils/trackingShell';
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
 *  site's own testid/state text stays a source-visible literal. */
export function TrackingPaidRow({
  'data-testid': testid,
  'data-state': state,
  dotClassName,
  title,
  sub,
}: {
  'data-testid': string;
  'data-state': string;
  dotClassName: string;
  title: ReactNode;
  sub: ReactNode;
}) {
  return (
    <div data-testid={testid} data-state={state} className="text-[15px]">
      <div className="flex items-center gap-[8px]">
        <span className={`h-[8px] w-[8px] shrink-0 rounded-full ${dotClassName}`} aria-hidden="true" />
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
