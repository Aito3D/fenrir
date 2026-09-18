import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import aito3dLogo from '../../assets/aito3d_logo.png';
import { BRAND, FOCUS, delayAt } from '../../utils/trackingShell';
import { AITO3D_SENDER } from '../../utils/shippingLabel';

/** The rendered pieces the public tracking pages share: the logo and the
 *  contact footer. Split out of AitoTrackPage when the code-entry page
 *  arrived, so the two pages are one surface and not two copies of it.
 *  The style tokens live in utils/trackingShell.ts, the language hook in
 *  hooks/useTrackingLanguage.ts. */

const TEL = `tel:${AITO3D_SENDER.phone.replace(/[^\d+]/g, '')}`;

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

/** Drops in from above once the content has landed (`at` ms after the
 *  page's clock starts); mounted only when there is something above it,
 *  so it never plays over the skeleton and then again over the content. */
export function Footer({ at, shop }: { at: number; shop?: { open: boolean; controls: string; toggle: (from: HTMLElement) => void } }) {
  const { t } = useTranslation();
  const linkCls = `inline-flex min-h-[44px] items-center text-aito-muted transition-colors duration-150 hover:text-aito-ink ${FOCUS} focus-visible:text-aito-ink`;
  return (
    <footer className="animate-track-drop mt-[32px] border-t border-aito-line/60 pt-[24px] text-center text-[13.5px]" style={delayAt(at)} data-testid="track-footer">
      <p className="text-aito-ink">{t('aito.track.footerQuestion')}</p>
      <p className="mt-[8px]">
        <a className={linkCls} href={TEL}>
          {AITO3D_SENDER.phone}
        </a>
        {/* The dot only makes sense while both links share a line; below
            360 px the email wraps, and a dangling dot would trail the phone. */}
        <span className="mx-[4px] max-[359px]:hidden" aria-hidden="true">
          ·
        </span>
        <a className={linkCls} href={`mailto:${AITO3D_SENDER.email}`}>
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
