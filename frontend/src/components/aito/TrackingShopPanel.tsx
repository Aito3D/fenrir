import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Instagram, Mail, Navigation, Phone } from 'lucide-react';
import { AITO3D_SENDER } from '../../utils/shippingLabel';
import { SHOP_DIRECTIONS_URL, SHOP_MAIL_HREF, SHOP_SOCIAL_URL, SHOP_TEL_HREF, SHOP_WEBSITE_URL, shopMapEmbedUrl } from '../../utils/aitoShop';
import { FOCUS, PRESS } from '../../utils/trackingShell';
import { PanelReveal, TrackingPanel } from './TrackingPanel';

/** "Nous trouver": the shop as a place — a map, the address, then every way
 *  to reach it as a tappable row, and the two things a client on their way
 *  actually does: get directions, or call. On the desktop panel (≥ 1060 px)
 *  everything is a notch tighter — a shorter map, the four rows as a 2 × 2
 *  grid — so the panel stays well inside the card's height (index.css
 *  `.track-panel` caps it); the phone sheet keeps the roomier stack. The
 *  map is Google's embed, turned
 *  to night with a filter (index.css `.track-map`), and only requested the
 *  first time the panel opens: a third-party frame has no business loading
 *  under a page the client may never open it on. */
export function TrackingShopPanel({ open, onClose, titleRef }: { open: boolean; onClose: () => void; titleRef: (el: HTMLHeadingElement | null) => void }) {
  const { t, i18n } = useTranslation();
  const [mapSrc, setMapSrc] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  useEffect(() => {
    if (open && mapSrc === null) setMapSrc(shopMapEmbedUrl(i18n.language));
  }, [open, mapSrc, i18n.language]);

  const [street, ...rest] = AITO3D_SENDER.addressLines;
  const row = (label: string, value: string, href: string, icon: ReactNode, external = false) => (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={`group flex min-h-[44px] items-center gap-[12px] border-t border-aito-line py-[7px] pr-[12px] pl-[14px] text-[13px] transition-colors duration-150 first:border-t-0 hover:bg-white/[.03] ${FOCUS} rounded-[8px] focus-visible:-outline-offset-2 min-[1060px]:min-h-[40px] min-[1060px]:px-[12px] min-[1060px]:py-[5px] min-[1060px]:even:border-l min-[1060px]:[&:nth-child(2)]:border-t-0`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-[12px] min-[1060px]:block">
        <span className="w-[96px] shrink-0 text-[12px] text-aito-muted min-[1060px]:block min-[1060px]:w-auto">{label}</span>
        <span className="block min-w-0 flex-1 text-aito-ink [overflow-wrap:anywhere]">{value}</span>
      </span>
      <span className="inline-flex text-aito-muted transition-colors duration-150 group-hover:text-aito-cyan min-[1060px]:hidden" aria-hidden="true">
        {icon}
      </span>
    </a>
  );
  // The row icons and the two buttons' icons share one size.
  const iconCls = 'h-[14px] w-[14px]';
  const button = `inline-flex min-h-[44px] flex-1 items-center justify-center gap-[8px] rounded-[8px] px-[16px] text-[13.5px] font-semibold ${PRESS} ${FOCUS}`;

  return (
    <TrackingPanel id="track-panel-shop" testId="track-panel-shop" side="left" open={open} title={t('aito.track.shop.title')} subtitle={t('aito.track.shop.sub')} titleRef={titleRef} onClose={onClose}>
      <PanelReveal i={0}>
        <div className="track-map relative mt-[18px] h-[190px] overflow-hidden min-[1060px]:mt-[14px] min-[1060px]:h-[130px] rounded-[10px] border border-aito-line bg-[#0e141b]">
          {!mapReady && (
            <span className="absolute inset-0 flex items-center justify-center text-[12.5px] text-aito-muted" aria-hidden="true">
              {t('aito.track.shop.mapLoading')}
            </span>
          )}
          <iframe
            title={t('aito.track.shop.mapTitle')}
            src={mapSrc ?? undefined}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allowFullScreen
            data-ready={mapReady || undefined}
            onLoad={() => {
              if (mapSrc) setMapReady(true);
            }}
          />
        </div>
      </PanelReveal>
      <PanelReveal i={1}>
        <p className="mt-[16px] text-[15px] leading-[1.4] min-[1060px]:mt-[12px] min-[1060px]:text-[14px]">
          <b className="block font-semibold">{street}</b>
          <span className="text-aito-muted">{rest.join(', ')}</span>
        </p>
      </PanelReveal>
      <PanelReveal i={2} className="mt-[14px] rounded-[10px] border border-aito-line min-[1060px]:mt-[12px] min-[1060px]:grid min-[1060px]:grid-cols-2">
        {row(t('aito.track.shop.phone'), AITO3D_SENDER.phone, SHOP_TEL_HREF, <Phone className={iconCls} />)}
        {row(t('aito.track.shop.email'), AITO3D_SENDER.email, SHOP_MAIL_HREF, <Mail className={iconCls} />)}
        {row(t('aito.track.shop.website'), AITO3D_SENDER.website, SHOP_WEBSITE_URL, <ExternalLink className={iconCls} />, true)}
        {row(t('aito.track.shop.social'), AITO3D_SENDER.socialHandle, SHOP_SOCIAL_URL, <Instagram className={iconCls} />, true)}
      </PanelReveal>
      <PanelReveal i={3} className="mt-[16px] flex gap-[10px] min-[1060px]:mt-[12px]">
        <a href={SHOP_DIRECTIONS_URL} target="_blank" rel="noopener noreferrer" className={`${button} bg-aito-cyan text-aito-midnight hover:brightness-110`}>
          <Navigation className={iconCls} aria-hidden="true" />
          {t('aito.track.shop.directions')}
        </a>
        <a href={SHOP_TEL_HREF} className={`${button} border border-aito-cyan/35 text-aito-cyan hover:bg-aito-cyan/10`}>
          {t('aito.track.shop.call')}
        </a>
      </PanelReveal>
    </TrackingPanel>
  );
}
