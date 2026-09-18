import { AITO3D_SENDER } from './shippingLabel';

/** The shop as a place, for the tracking page's "Nous trouver" panel. Every
 *  link is derived from `AITO3D_SENDER`, so the address, phone and handle
 *  are still edited in exactly one place. */
const QUERY = encodeURIComponent(AITO3D_SENDER.addressLines.join(', '));

export const SHOP_TEL_HREF = `tel:${AITO3D_SENDER.phone.replace(/[^\d+]/g, '')}`;
export const SHOP_MAIL_HREF = `mailto:${AITO3D_SENDER.email}`;
export const SHOP_WEBSITE_URL = `https://${AITO3D_SENDER.website}`;
export const SHOP_SOCIAL_URL = `https://www.instagram.com/${AITO3D_SENDER.socialHandle.replace(/^@/, '')}`;
/** Google Maps' universal directions link: opens the native app on a phone. */
export const SHOP_DIRECTIONS_URL = `https://www.google.com/maps/dir/?api=1&destination=${QUERY}`;

/** Google's keyless map embed for the shop, labelled in the page's language.
 *  A frame, not tiles: the app's CSP allows any https frame but only
 *  same-origin images, so this is the one map that needs no CSP change and
 *  no dependency. */
export const shopMapEmbedUrl = (lng: string) => `https://www.google.com/maps?q=${QUERY}&z=16&hl=${encodeURIComponent(lng)}&output=embed`;
