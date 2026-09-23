import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, ChevronRight, ExternalLink, Instagram, Mail, Navigation, Phone } from 'lucide-react';
import { AITO3D_SENDER } from '../../utils/shippingLabel';
import { SHOP_DIRECTIONS_URL, SHOP_MAIL_HREF, SHOP_SOCIAL_URL, SHOP_TEL_HREF, SHOP_WEBSITE_URL, shopMapEmbedUrl } from '../../utils/aitoShop';
import { FOCUS, PRESS } from '../../utils/trackingShell';
import { PanelReveal, TrackingPanel } from './TrackingPanel';

/** "Nous trouver": the shop as a place — a map big enough to read the
 *  streets around it, the address, then every way to reach the shop as one
 *  tappable row each (an icon tile, the label over the value, an arrow that
 *  says what tapping does: a chevron dials or writes, an up-right arrow
 *  leaves for another site), and the two things a client on their way
 *  actually does: get directions, or call. The 420 px desktop panel and the
 *  phone sheet share the layout; only the map is a touch shorter on the
 *  sheet. The map is Google's embed, turned to night with a filter
 *  (index.css `.track-map`), and only requested the first time the panel
 *  opens: a third-party frame has no business loading under a page the
 *  client may never open it on. */
export function TrackingShopPanel({ open, onClose, titleRef }: { open: boolean; onClose: () => void; titleRef: (el: HTMLHeadingElement | null) => void }) {
  const { t, i18n } = useTranslation();
  const [mapSrc, setMapSrc] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  useEffect(() => {
    if (open && mapSrc === null) setMapSrc(shopMapEmbedUrl(i18n.language));
  }, [open, mapSrc, i18n.language]);

  const [street, ...rest] = AITO3D_SENDER.addressLines;
  const iconCls = 'h-[15px] w-[15px]';
  const row = (label: string, value: string, href: string, icon: ReactNode, external = false) => {
    const Arrow = external ? ArrowUpRight : ChevronRight;
    return (
      <a
        href={href}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        className={`group flex min-h-[56px] items-center gap-[14px] border-t border-aito-line py-[9px] pr-[12px] pl-[12px] transition-colors duration-150 first:border-t-0 hover:bg-white/[.03] ${FOCUS} rounded-[8px] focus-visible:-outline-offset-2`}
      >
        <span
          className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border border-aito-line bg-white/[.03] text-aito-muted transition-colors duration-150 group-hover:border-aito-cyan/35 group-hover:text-aito-cyan"
          aria-hidden="true"
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] leading-[1.3] text-aito-muted">{label}</span>
          <span className="mt-[1px] block text-[14.5px] leading-[1.35] text-aito-ink [overflow-wrap:anywhere]">{value}</span>
        </span>
        <Arrow
          className="h-[15px] w-[15px] shrink-0 text-aito-muted/60 transition-[color,translate] duration-150 group-hover:translate-x-[2px] group-hover:text-aito-cyan"
          aria-hidden="true"
        />
      </a>
    );
  };
  const button = `inline-flex min-h-[46px] flex-1 items-center justify-center gap-[8px] rounded-[8px] px-[16px] text-[14px] font-semibold ${PRESS} ${FOCUS}`;

  return (
    <TrackingPanel id="track-panel-shop" testId="track-panel-shop" side="left" open={open} title={t('aito.track.shop.title')} subtitle={t('aito.track.shop.sub')} titleRef={titleRef} onClose={onClose}>
      <PanelReveal i={0}>
        <div className="track-map relative mt-[18px] h-[200px] overflow-hidden rounded-[10px] border border-aito-line bg-[#0e141b] min-[1120px]:h-[230px]">
          {!mapReady && (
            <span className="absolute inset-0 flex items-center justify-center text-[12.5px] text-aito-muted" aria-hidden="true">
              {t('aito.track.shop.mapLoading')}
            </span>
          )}
          <iframe
            title={t('aito.track.shop.mapTitle')}
            src={mapSrc ?? undefined}
            loading="lazy"
            referrerPolicy="no-referrer"
            allowFullScreen
            data-ready={mapReady || undefined}
            onLoad={() => {
              if (mapSrc) setMapReady(true);
            }}
          />
        </div>
      </PanelReveal>
      <PanelReveal i={1}>
        <p className="mt-[16px] text-[15px] leading-[1.4]">
          <b className="block font-semibold">{street}</b>
          <span className="text-aito-muted">{rest.join(', ')}</span>
        </p>
      </PanelReveal>
      <PanelReveal i={2} className="mt-[14px] overflow-hidden rounded-[10px] border border-aito-line">
        {row(t('aito.track.shop.phone'), AITO3D_SENDER.phone, SHOP_TEL_HREF, <Phone className={iconCls} />)}
        {row(t('aito.track.shop.email'), AITO3D_SENDER.email, SHOP_MAIL_HREF, <Mail className={iconCls} />)}
        {row(t('aito.track.shop.website'), AITO3D_SENDER.website, SHOP_WEBSITE_URL, <ExternalLink className={iconCls} />, true)}
        {row(t('aito.track.shop.social'), AITO3D_SENDER.socialHandle, SHOP_SOCIAL_URL, <Instagram className={iconCls} />, true)}
      </PanelReveal>
      <PanelReveal i={3} className="mt-[16px] flex gap-[10px]">
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
