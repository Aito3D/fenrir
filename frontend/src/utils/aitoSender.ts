/** The shop, as printed in the shipping label's sender block and shown on
 *  the public tracking page.
 *
 *  A constant rather than a setting: this is the fork's single-tenant
 *  deployment — the logo is hardcoded the same way in `Layout.tsx` — and a
 *  shop address changes about as often as the logo does. One place to edit,
 *  no settings row to migrate, nothing that can be blank on a fresh install.
 *
 *  Its own module on purpose: `shippingLabel.ts` renders the label with
 *  `react-dom/server` and the QR renderer, and the tracking shell sits in the
 *  app entry. Importing the constant from there put a 195 KB chunk into every
 *  page load; here it costs a few hundred bytes.
 */
export const AITO3D_SENDER = {
  name: 'Aito3D',
  addressLines: ["20 Route de l'eau Royale", 'Arue – Tahiti', 'Polynésie française'],
  phone: '(+689) 89 25 32 10',
  email: 'contact@aito3d.fr',
  /** Google Business Profile → "Get more reviews". Printed on the review
   *  card as text and as a QR code. */
  reviewUrl: 'https://g.page/r/CVL6WajJzwuGEBM/review',
  website: 'aito3d.fr',
  /** One handle for Facebook, Instagram and TikTok alike. */
  socialHandle: '@aito3d',
} as const;
