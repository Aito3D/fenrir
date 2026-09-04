import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import type { AitoProject, AitoShippingService } from '../api/client';
import { formatPhoneDisplay } from './clientDraft';
import { islandLabel } from './shippingDraft';

/** The shop, as printed in the label's sender block.
 *
 *  A constant rather than a setting: this is the fork's single-tenant
 *  deployment — the logo is hardcoded the same way in `Layout.tsx` — and a
 *  shop address changes about as often as the logo does. One place to edit,
 *  no settings row to migrate, nothing that can be blank on a fresh install.
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

/** Everything the printed label says, already resolved to display strings.
 *
 *  Kept free of the project row on purpose: `buildShippingLabelHtml` is a
 *  pure string function over this, so the layout can be tested and previewed
 *  with hand-written values, and `shippingLabelFor` is the one place that
 *  knows which project columns feed which line. */
export interface ShippingLabel {
  recipientName: string;
  recipientPhone: string;
  island: string;
  serviceName: string;
  /** Invoice number. Empty when the invoice has no number yet — the row is
   *  then left out rather than printed blank. */
  reference: string;
}

/** The label for this project, or null when there is nothing to print.
 *
 *  Two gates, both the caller's spec rather than this function's opinion:
 *  the parcel is only packed once the work is in Finish, and only projects
 *  carrying shipping have anywhere to send it (`shipping_island === null` IS
 *  "no shipping" — the same single test `ShippingCard` uses). Done is
 *  excluded deliberately: it is the archive, and a label printed off an
 *  archived card is almost always a duplicate.
 *
 *  Recipient names come from the shipping fields, not the client — the two
 *  are seeded equal but the operator may have retyped the recipient, and the
 *  retyped one is the person collecting the parcel. */
export function shippingLabelFor(
  project: AitoProject,
  services: AitoShippingService[],
  invoiceNumber: string | null | undefined,
): ShippingLabel | null {
  if (project.column !== 'finish' || project.shipping_island === null) return null;

  const recipientName = [project.shipping_first_name, project.shipping_last_name]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');

  return {
    recipientName: recipientName || (project.client_name ?? ''),
    recipientPhone: project.shipping_phone ? formatPhoneDisplay(project.shipping_phone) : '',
    island: islandLabel(project.shipping_island, services),
    serviceName: project.shipping_service_name ?? project.shipping_service ?? '',
    reference: invoiceNumber ?? '',
  };
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inter, served from the app's own /fonts. Resolved against the logo URL so
 *  the document — which lives at a blob: URL with no base of its own — still
 *  finds the files. A relative logo URL (tests, previews) has no origin to
 *  resolve against; the label then simply falls back to the system stack. */
function fontFaceCss(logoUrl: string): string {
  // One try around both resolutions: a data: URL parses fine on its own and
  // only throws when `/fonts/…` is resolved against it (it has no origin).
  try {
    const face = (file: string, range: string) =>
      // `swap`, and not the default: without it Chrome hides text for up to
      // 3s while the font arrives, and a print snapshot taken inside that
      // window is a label with every word missing. The printing hook also
      // waits on `document.fonts.ready`; this is the belt to that brace.
      `@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:swap;src:url('${new URL(`/fonts/${file}`, logoUrl).href}') format('woff2');unicode-range:${range};}`;
    return (
      face('inter-latin.woff2', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F') +
      face('inter-latin-ext.woff2', 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F')
    );
  } catch {
    return '';
  }
}

/** Under the header: a run of niho mano, teeth down, over a hairline. */
const NIHO_STRIP = `<svg class="strip head" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <defs><pattern id="strip-niho" width="20" height="11.34" patternUnits="userSpaceOnUse">
    <path d="M0 0 10 9.5 20 0Z"/>
    <rect x="0" y="10.2" width="20" height="1.14"/>
  </pattern></defs>
  <rect width="100%" height="100%" fill="url(#strip-niho)"/>
</svg>`;

/** Above the thank-you line: a Tahitian bracelet band — solid black with
 *  the island's own motifs reversed out in white, the organic vocabulary of
 *  Tahitian tatau rather than Marquesan geometry:
 *    tiare — the Tahitian gardenia, six petals round a dot;
 *    manu  — a frigatebird in flight, the two curved wings;
 *    moana — the ocean curl the parcel crosses.
 *  Deliberately the opposite polarity of the header strip so the two frame
 *  the label rather than repeat each other. */
const TIARE = [0, 60, 120, 180, 240, 300]
  .map((angle) => `<ellipse cx="10" cy="4.1" rx="1.55" ry="3.7" fill="#fff" transform="rotate(${angle} 10 8.5)"/>`)
  .join('');
const MAOHI_STRIP = `<svg class="strip foot" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <defs><pattern id="strip-maohi" width="48" height="17" patternUnits="userSpaceOnUse">
    <rect width="48" height="17"/>
    ${TIARE}<circle cx="10" cy="8.5" r="1.1"/>
    <path d="M18.5 12C21.5 4.5 25 5.5 25.5 9.5C26 5.5 29.5 4.5 32.5 12C29.8 8.8 27 9.6 25.5 12C24 9.6 21.2 8.8 18.5 12Z" fill="#fff"/>
    <path d="M35 14A6 6 0 0 1 47 14A3 3 0 0 0 41 14A1.5 1.5 0 0 1 44 14" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
  </pattern></defs>
  <rect width="100%" height="100%" fill="url(#strip-maohi)"/>
</svg>`;

/** Scissors for the fold line. Drawn rather than the ✂ glyph: not every
 *  print font carries it, and a missing-glyph box on the cut line is worse
 *  than no scissors at all. */
const SCISSORS = `<svg class="scissors" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#999" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>
</svg>`;

const STAR = `<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.5l2.9 6.1 6.7.8-4.9 4.6 1.3 6.6L12 17.3 6 20.6l1.3-6.6L2.4 9.4l6.7-.8z"/></svg>`;

/** The review link as a scannable code. `qrcode.react` is already a
 *  dependency (the printer pages use it); rendered to static markup here
 *  because the label is a string document, not a React tree. Level M: the
 *  card is printed at 50mm+ on a home printer, and M survives a smudge. */
const qrSvg = (value: string): string =>
  renderToStaticMarkup(createElement(QRCodeSVG, { value, size: 160, level: 'M', marginSize: 0 }));

/** Simple line glyphs for the three networks, drawn rather than fetched:
 *  a brand's icon font is one more request a print snapshot can miss. */
const SOCIAL_ICONS: Record<'facebook' | 'instagram' | 'tiktok', string> = {
  facebook: `<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M14 8h3V4h-3c-2.8 0-4.5 1.7-4.5 4.5V11H7v4h2.5v6h4v-6H17l.5-4h-4V9c0-.6.4-1 .5-1z"/></svg>`,
  instagram: `<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><circle cx="12" cy="12" r="3.8"/><circle cx="17.2" cy="6.8" r=".9" fill="#111" stroke="none"/></svg>`,
  tiktok: `<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M13 3h3c.2 2.2 1.6 3.7 3.8 3.9v3c-1.5 0-2.7-.4-3.8-1.1v6.4A5.3 5.3 0 1 1 10 10v3.1a2.3 2.3 0 1 0 3 2.2V3z"/></svg>`,
};

/** A complete printable document: A4 portrait, label on the top half, a cut
 *  line at the fold, and a review card on the bottom half.
 *
 *  Why a document and not a component: the label is printed from a hidden
 *  iframe (see `usePrintBlob`), where it needs its own page rules, its own
 *  fonts and none of the app's stylesheet — Tailwind's dark background alone
 *  would flood the page. Everything is inline; the only outward references
 *  are the logo and the fonts, both same-origin.
 *
 *  Design notes, so the next edit keeps the intent:
 *  - The island is the one line the freight counter actually reads. It sits
 *    in a solid black block at the largest size on the page; everything else
 *    ranks below it.
 *  - Black plus one accent (the logo's blue) and no tints. Half-tone greys
 *    band on cheap printers; a black fill does not.
 *  - Content stays 10mm+ inside the paper edge on every side so no printer's
 *    unprintable margin can clip it, and the fold falls exactly at 148.5mm so
 *    the cut half is a true A5.
 */
export function buildShippingLabelHtml(label: ShippingLabel, logoUrl: string): string {
  const e = escapeHtml;
  const referenceRows = label.reference
    ? `<div class="eyebrow">Référence</div><div class="ref-no">${e(label.reference)}</div>`
    : '';
  const phoneRow = label.recipientPhone ? `<div class="to-phone">${e(label.recipientPhone)}</div>` : '';

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Étiquette d'expédition${label.reference ? ` – ${e(label.reference)}` : ''}</title>
<style>
${fontFaceCss(logoUrl)}
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body {
  width: 210mm; height: 297mm; position: relative; overflow: hidden;
  font-family: 'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif;
  color: #111; font-size: 10pt; line-height: 1.3;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
  -webkit-font-smoothing: antialiased;
}
.label {
  position: relative; width: 210mm; height: 148.5mm;
  padding: 11mm 12mm 9mm 12mm; overflow: hidden;
  display: flex; flex-direction: column;
}
.head { display: flex; align-items: flex-end; justify-content: space-between; }
.logo { height: 9mm; width: auto; display: block; }
.head-right { text-align: right; }
.kicker { font-size: 8pt; font-weight: 700; letter-spacing: .22em; text-transform: uppercase; }
.sub { font-size: 8pt; color: #555; margin-top: 1mm; }
.strip { display: block; width: 100%; height: 3mm; }
.strip.head { margin: 3.5mm 0 4.5mm; }
.body { flex: 1; display: grid; grid-template-columns: 58mm 1fr; column-gap: 8mm; min-height: 0; }
.eyebrow { font-size: 7pt; font-weight: 700; letter-spacing: .2em; text-transform: uppercase; color: #1a9cd8; margin-bottom: 1.5mm; }
.from { display: flex; flex-direction: column; padding-right: 6mm; border-right: .3mm solid #111; }
.from-name { font-size: 12.5pt; font-weight: 800; letter-spacing: -.01em; }
.from-line { font-size: 9.5pt; }
.from-contact { font-size: 9pt; color: #333; }
.from-contact:first-of-type { margin-top: 1.5mm; }
.ref { margin-top: auto; padding-top: 4mm; }
.ref-no { font-size: 13pt; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: .02em; }
.to { position: relative; display: flex; flex-direction: column; min-width: 0; }
.to-name { font-size: 22pt; font-weight: 800; letter-spacing: -.015em; line-height: 1.1; overflow-wrap: anywhere; }
.to-phone { font-size: 13pt; font-weight: 500; margin-top: 1.5mm; font-variant-numeric: tabular-nums; }
.island { margin-top: 4.5mm; background: #111; color: #fff; padding: 4mm 5.5mm 4.5mm; border-radius: 1.5mm; }
.island .eyebrow { color: #6fcbf2; margin-bottom: .5mm; }
.island-name { font-size: 30pt; font-weight: 900; letter-spacing: -.02em; line-height: 1.05; overflow-wrap: anywhere; }
.service { margin-top: 3.5mm; display: inline-flex; align-self: flex-start; align-items: center; gap: 2mm; font-size: 9.5pt; font-weight: 600; padding: 1.5mm 3.5mm; border: .35mm solid #111; border-radius: 10mm; }
.service::before { content: ''; width: 2mm; height: 2mm; border-radius: 50%; background: #1a9cd8; }
.fragile { position: absolute; right: 1mm; bottom: 1mm; transform: rotate(-5deg); padding: 1.4mm 3.5mm; border: .6mm solid #111; border-radius: 1mm; font-size: 10pt; font-weight: 800; letter-spacing: .28em; text-transform: uppercase; }
.strip.foot { height: 4.5mm; margin: 3mm 0 0; }
.thanks { margin-top: 2.5mm; font-size: 9.5pt; font-style: italic; color: #222; display: flex; justify-content: space-between; align-items: baseline; gap: 4mm; }
.thanks b { font-style: normal; font-weight: 700; color: #1a9cd8; }
.thanks span { font-style: normal; font-size: 8pt; color: #666; white-space: nowrap; }
.cut { position: absolute; left: 8mm; right: 8mm; top: 148.5mm; border-top: .3mm dashed #999; }
.scissors { position: absolute; left: 0; top: -2.2mm; width: 4.2mm; height: 4.2mm; background: #fff; padding: 0 .4mm; }
.cut-hint { position: absolute; right: 0; top: -1.6mm; background: #fff; padding-left: 1.5mm; font-size: 6.5pt; color: #999; letter-spacing: .12em; text-transform: uppercase; }
.review { position: absolute; left: 0; top: 148.5mm; width: 210mm; height: 148.5mm; padding: 12mm 12mm 9mm; display: flex; flex-direction: column; overflow: hidden; }
.review-body { flex: 1; display: grid; grid-template-columns: 1fr 50mm; column-gap: 10mm; align-items: center; min-height: 0; }
.review-title { font-size: 23pt; font-weight: 900; letter-spacing: -.02em; line-height: 1.05; }
.review-title b { color: #1a9cd8; }
.review-text { margin: 4mm 0 0; font-size: 10.5pt; line-height: 1.45; color: #222; }
.stars { margin-top: 4mm; display: flex; gap: 1.2mm; }
.stars svg { width: 5.5mm; height: 5.5mm; }
.review-link { margin-top: 3mm; font-size: 9.5pt; font-weight: 600; overflow-wrap: anywhere; }
.review-link span { color: #1a9cd8; }
.socials { margin-top: 5mm; padding-top: 3.5mm; border-top: .3mm solid #111; display: flex; flex-wrap: wrap; align-items: center; gap: 2mm 5mm; font-size: 9pt; }
.socials .lead { font-weight: 700; }
.socials .net { display: inline-flex; align-items: center; gap: 1.4mm; font-weight: 600; }
.socials .net svg { width: 4mm; height: 4mm; }
.socials .site { margin-left: auto; font-weight: 700; color: #1a9cd8; }
.qr-box { justify-self: end; width: 50mm; border: .5mm solid #111; border-radius: 2mm; padding: 4mm; text-align: center; }
.qr svg { width: 100%; height: auto; display: block; }
.qr-caption { margin-top: 2.5mm; font-size: 7.5pt; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; }
</style>
</head>
<body>
<div class="label">
  <header class="head">
    <img class="logo" src="${e(logoUrl)}" alt="Aito3D">
    <div class="head-right">
      <div class="kicker">Étiquette d'expédition</div>
      <div class="sub">Fret aérien · Air Tahiti</div>
    </div>
  </header>
  ${NIHO_STRIP}
  <main class="body">
    <section class="from">
      <div class="eyebrow">Expéditeur</div>
      <div class="from-name">${e(AITO3D_SENDER.name)}</div>
      ${AITO3D_SENDER.addressLines.map((line) => `<div class="from-line">${e(line)}</div>`).join('\n      ')}
      <div class="from-contact">${e(AITO3D_SENDER.phone)}</div>
      <div class="from-contact">${e(AITO3D_SENDER.email)}</div>
      <div class="ref">
        ${referenceRows}
      </div>
    </section>
    <section class="to">
      <div class="eyebrow">Destinataire</div>
      <div class="to-name">${e(label.recipientName)}</div>
      ${phoneRow}
      <div class="island">
        <div class="eyebrow">Île de destination</div>
        <div class="island-name">${e(label.island)}</div>
      </div>
      ${label.serviceName ? `<div class="service">${e(label.serviceName)}</div>` : ''}
      <div class="fragile">Fragile</div>
    </section>
  </main>
  ${MAOHI_STRIP}
  <footer class="thanks">
    <div><b>Māuruuru roa !</b> Merci pour ta confiance, prends soin de tes pièces et à très bientôt.</div>
    <span>— l'équipe Aito3D</span>
  </footer>
</div>
<div class="cut" aria-hidden="true">${SCISSORS}<span class="cut-hint">Plier · découper ici</span></div>
<section class="review">
  <header class="head">
    <img class="logo" src="${e(logoUrl)}" alt="Aito3D">
    <div class="head-right">
      <div class="kicker">Ton avis compte</div>
      <div class="sub">Atelier de fabrication 3D · Arue, Tahiti</div>
    </div>
  </header>
  ${NIHO_STRIP}
  <div class="review-body">
    <div>
      <div class="review-title">Merci pour ta commande&nbsp;!</div>
      <p class="review-text">Aito3D, c'est un petit atelier d'Arue, et chaque avis compte énormément pour nous faire connaître. Si tes pièces te plaisent, prends une minute pour nous laisser un avis Google&nbsp;: scanne le code, ou tape le lien ci-dessous.</p>
      <div class="stars" aria-hidden="true">${STAR}${STAR}${STAR}${STAR}${STAR}</div>
      <div class="review-link">Avis Google&nbsp;: <span>${e(AITO3D_SENDER.reviewUrl)}</span></div>
      <div class="socials">
        <span class="lead">Suis-nous</span>
        <span class="net">${SOCIAL_ICONS.facebook}Facebook</span>
        <span class="net">${SOCIAL_ICONS.instagram}Instagram</span>
        <span class="net">${SOCIAL_ICONS.tiktok}TikTok</span>
        <span>${e(AITO3D_SENDER.socialHandle)}</span>
        <span class="site">${e(AITO3D_SENDER.website)}</span>
      </div>
    </div>
    <div class="qr-box">
      <div class="qr">${qrSvg(AITO3D_SENDER.reviewUrl)}</div>
      <div class="qr-caption">Scanne-moi</div>
    </div>
  </div>
  ${MAOHI_STRIP}
  <footer class="thanks">
    <div><b>Māuruuru roa !</b> À très bientôt à l'atelier.</div>
    <span>— l'équipe Aito3D</span>
  </footer>
</section>
</body>
</html>
`;
}
