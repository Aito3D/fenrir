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
  projectTitle: string;
  date: Date;
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
  now: Date = new Date(),
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
    projectTitle: project.description ?? '',
    date: now,
  };
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const frenchDate = (date: Date): string =>
  new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);

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

/** The tattoo band down the label's left edge: Marquesan niho (shark teeth)
 *  on both flanks, a spine of diamonds and chevrons between them. One tile,
 *  6mm wide (22.68 CSS px), repeated vertically. Solid black so it prints
 *  identically on a laser, an inkjet or a photocopier. */
const TATAU_BAND = `<svg class="tatau" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <defs><pattern id="tatau" width="22.68" height="34" patternUnits="userSpaceOnUse">
    <path d="M0 0L6 8.5 0 17ZM0 17L6 25.5 0 34Z"/>
    <path d="M22.68 0L16.68 8.5 22.68 17ZM22.68 17L16.68 25.5 22.68 34Z"/>
    <path d="M11.34 3L15 8.5 11.34 14 7.68 8.5Z"/>
    <path d="M7.68 19L11.34 23 15 19V22L11.34 26 7.68 22ZM7.68 27L11.34 31 15 27V30L11.34 34 7.68 30Z"/>
  </pattern></defs>
  <rect width="100%" height="100%" fill="url(#tatau)"/>
</svg>`;

/** The wave strip under the header — moana, the ocean the parcel crosses.
 *  Nested arcs, stroked, repeated horizontally. */
const MOANA_STRIP = `<svg class="moana" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <defs><pattern id="moana" width="13" height="9.45" patternUnits="userSpaceOnUse">
    <path d="M0 9A6.5 6.5 0 0 1 13 9" fill="none" stroke="#111" stroke-width="1.1"/>
    <path d="M3.4 9A3.1 3.1 0 0 1 9.6 9" fill="none" stroke="#111" stroke-width="1.1"/>
  </pattern></defs>
  <rect width="100%" height="100%" fill="url(#moana)"/>
</svg>`;

/** Scissors for the fold line. Drawn rather than the ✂ glyph: not every
 *  print font carries it, and a missing-glyph box on the cut line is worse
 *  than no scissors at all. */
const SCISSORS = `<svg class="scissors" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#999" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>
</svg>`;

/** A complete printable document: A4 portrait, label on the top half, a cut
 *  line at the fold, the bottom half blank.
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
  const titleRow = label.projectTitle ? `<div class="ref-title">${e(label.projectTitle)}</div>` : '';
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
  padding: 11mm 12mm 9mm 22mm; overflow: hidden;
  display: flex; flex-direction: column;
}
.tatau { position: absolute; left: 10mm; top: 10mm; width: 6mm; height: 128.5mm; }
.head { display: flex; align-items: flex-end; justify-content: space-between; }
.logo { height: 9mm; width: auto; display: block; }
.head-right { text-align: right; }
.kicker { font-size: 8pt; font-weight: 700; letter-spacing: .22em; text-transform: uppercase; }
.sub { font-size: 8pt; color: #555; margin-top: 1mm; }
.moana { display: block; width: 100%; height: 2.5mm; margin: 3.5mm 0 4.5mm; }
.body { flex: 1; display: grid; grid-template-columns: 58mm 1fr; column-gap: 8mm; min-height: 0; }
.eyebrow { font-size: 7pt; font-weight: 700; letter-spacing: .2em; text-transform: uppercase; color: #1a9cd8; margin-bottom: 1.5mm; }
.from { display: flex; flex-direction: column; padding-right: 6mm; border-right: .3mm solid #111; }
.from-name { font-size: 12.5pt; font-weight: 800; letter-spacing: -.01em; }
.from-line { font-size: 9.5pt; }
.from-contact { font-size: 9pt; color: #333; }
.from-contact:first-of-type { margin-top: 1.5mm; }
.ref { margin-top: auto; padding-top: 4mm; }
.ref-no { font-size: 13pt; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: .02em; }
.ref-title { font-size: 9pt; color: #333; margin-top: .5mm; }
.ref-date { font-size: 8.5pt; color: #666; margin-top: 1.5mm; }
.to { position: relative; display: flex; flex-direction: column; min-width: 0; }
.to-name { font-size: 22pt; font-weight: 800; letter-spacing: -.015em; line-height: 1.1; overflow-wrap: anywhere; }
.to-phone { font-size: 13pt; font-weight: 500; margin-top: 1.5mm; font-variant-numeric: tabular-nums; }
.island { margin-top: 4.5mm; background: #111; color: #fff; padding: 4mm 5.5mm 4.5mm; border-radius: 1.5mm; }
.island .eyebrow { color: #6fcbf2; margin-bottom: .5mm; }
.island-name { font-size: 30pt; font-weight: 900; letter-spacing: -.02em; line-height: 1.05; overflow-wrap: anywhere; }
.service { margin-top: 3.5mm; display: inline-flex; align-self: flex-start; align-items: center; gap: 2mm; font-size: 9.5pt; font-weight: 600; padding: 1.5mm 3.5mm; border: .35mm solid #111; border-radius: 10mm; }
.service::before { content: ''; width: 2mm; height: 2mm; border-radius: 50%; background: #1a9cd8; }
.fragile { position: absolute; right: 1mm; bottom: 1mm; transform: rotate(-5deg); padding: 1.4mm 3.5mm; border: .6mm solid #111; border-radius: 1mm; font-size: 10pt; font-weight: 800; letter-spacing: .28em; text-transform: uppercase; }
.moana.foot { margin: 3mm 0 0; }
.thanks { margin-top: 2.5mm; font-size: 9.5pt; font-style: italic; color: #222; display: flex; justify-content: space-between; align-items: baseline; gap: 4mm; }
.thanks b { font-style: normal; font-weight: 700; color: #1a9cd8; }
.thanks span { font-style: normal; font-size: 8pt; color: #666; white-space: nowrap; }
.cut { position: absolute; left: 8mm; right: 8mm; top: 148.5mm; border-top: .3mm dashed #999; }
.scissors { position: absolute; left: 0; top: -2.2mm; width: 4.2mm; height: 4.2mm; background: #fff; padding: 0 .4mm; }
.cut-hint { position: absolute; right: 0; top: -1.6mm; background: #fff; padding-left: 1.5mm; font-size: 6.5pt; color: #999; letter-spacing: .12em; text-transform: uppercase; }
</style>
</head>
<body>
<div class="label">
  ${TATAU_BAND}
  <header class="head">
    <img class="logo" src="${e(logoUrl)}" alt="Aito3D">
    <div class="head-right">
      <div class="kicker">Étiquette d'expédition</div>
      <div class="sub">Fret aérien · Air Tahiti</div>
    </div>
  </header>
  ${MOANA_STRIP}
  <main class="body">
    <section class="from">
      <div class="eyebrow">Expéditeur</div>
      <div class="from-name">${e(AITO3D_SENDER.name)}</div>
      ${AITO3D_SENDER.addressLines.map((line) => `<div class="from-line">${e(line)}</div>`).join('\n      ')}
      <div class="from-contact">${e(AITO3D_SENDER.phone)}</div>
      <div class="from-contact">${e(AITO3D_SENDER.email)}</div>
      <div class="ref">
        ${referenceRows}
        ${titleRow}
        <div class="ref-date">Expédié le ${e(frenchDate(label.date))}</div>
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
  ${MOANA_STRIP.replace('class="moana"', 'class="moana foot"')}
  <footer class="thanks">
    <div><b>Māuruuru roa !</b> Merci pour votre confiance, prenez soin de vos pièces et à très bientôt.</div>
    <span>— l'équipe Aito3D</span>
  </footer>
</div>
<div class="cut" aria-hidden="true">${SCISSORS}<span class="cut-hint">Plier · découper ici</span></div>
</body>
</html>
`;
}
