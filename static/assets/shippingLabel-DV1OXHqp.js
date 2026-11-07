import{i as e}from"./rolldown-runtime-aKtaBQYM.js";import{Wa as t}from"./icons-DLJZvt7k.js";import{l as n}from"./clientDraft-CQrgqHl-.js";import{t as r}from"./aitoSender-Qqyge70k.js";import{i,t as a}from"./server.browser-BtLq176D.js";import{t as o}from"./esm-nNRxuetL.js";var s=e(t(),1),c=a();function l(e,t,r){return e.column!==`finish`||e.shipping_island===null?null:{recipientName:[e.shipping_first_name,e.shipping_last_name].map(e=>(e??``).trim()).filter(Boolean).join(` `)||(e.client_name??``),recipientPhone:e.shipping_phone?n(e.shipping_phone):``,island:i(e.shipping_island,t),serviceName:e.shipping_service_name??e.shipping_service??``,reference:r??``}}var u=e=>e.replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`);function d(e){try{let t=(t,n)=>`@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:swap;src:url('${new URL(`/fonts/${t}`,e).href}') format('woff2');unicode-range:${n};}`;return t(`inter-latin.woff2`,`U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F`)+t(`inter-latin-ext.woff2`,`U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F`)}catch{return``}}var f=e=>`<svg class="strip ${e}" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <defs><pattern id="strip-niho-${e}" width="20" height="11.34" patternUnits="userSpaceOnUse">
    <path d="M0 0 10 9.5 20 0Z"/>
    <rect x="0" y="10.2" width="20" height="1.14"/>
  </pattern></defs>
  <rect width="100%" height="100%" fill="url(#strip-niho-${e})"/>
</svg>`,p=`<svg class="scissors" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#999" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>
</svg>`,m=`<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.5l2.9 6.1 6.7.8-4.9 4.6 1.3 6.6L12 17.3 6 20.6l1.3-6.6L2.4 9.4l6.7-.8z"/></svg>`,h=e=>(0,c.renderToStaticMarkup)((0,s.createElement)(o,{value:e,size:160,level:`M`,marginSize:0})),g={facebook:`<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M14 8h3V4h-3c-2.8 0-4.5 1.7-4.5 4.5V11H7v4h2.5v6h4v-6H17l.5-4h-4V9c0-.6.4-1 .5-1z"/></svg>`,instagram:`<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><circle cx="12" cy="12" r="3.8"/><circle cx="17.2" cy="6.8" r=".9" fill="#111" stroke="none"/></svg>`,tiktok:`<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M13 3h3c.2 2.2 1.6 3.7 3.8 3.9v3c-1.5 0-2.7-.4-3.8-1.1v6.4A5.3 5.3 0 1 1 10 10v3.1a2.3 2.3 0 1 0 3 2.2V3z"/></svg>`};function _(e,t){let n=u,i=e.reference?`<div class="eyebrow">Référence</div><div class="ref-no">${n(e.reference)}</div>`:``,a=e.recipientPhone?`<div class="to-phone">${n(e.recipientPhone)}</div>`:``;return`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Étiquette d'expédition${e.reference?` – ${n(e.reference)}`:``}</title>
<style>
${d(t)}
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
.strip.foot { margin: 3mm 0 0; }
.thanks { margin-top: 2.5mm; font-size: 9.5pt; font-style: italic; color: #222; display: flex; justify-content: space-between; align-items: baseline; gap: 4mm; }
.thanks b { font-style: normal; font-weight: 700; color: #1a9cd8; }
.thanks span { font-style: normal; font-size: 8pt; color: #666; white-space: nowrap; }
.cut { position: absolute; left: 8mm; right: 8mm; top: 148.5mm; border-top: .3mm dashed #999; }
.scissors { position: absolute; left: 0; top: -2.2mm; width: 4.2mm; height: 4.2mm; background: #fff; padding: 0 .4mm; }
.cut-hint { position: absolute; right: 0; top: -1.6mm; background: #fff; padding-left: 1.5mm; font-size: 6.5pt; color: #999; letter-spacing: .12em; text-transform: uppercase; }
.review { position: absolute; left: 0; top: 148.5mm; width: 210mm; height: 148.5mm; padding: 14mm 14mm 12mm; display: flex; flex-direction: column; overflow: hidden; }
.review .head { padding-bottom: 4mm; border-bottom: .3mm solid #111; }
.review-body { flex: 1; display: grid; grid-template-columns: 1fr 50mm; column-gap: 12mm; align-items: center; min-height: 0; padding: 2mm 0; }
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
.socials .site { flex-basis: 100%; margin-top: .5mm; font-weight: 700; color: #1a9cd8; }
.qr-box { justify-self: end; width: 50mm; border: .5mm solid #111; border-radius: 2mm; padding: 4mm; text-align: center; }
.qr svg { width: 100%; height: auto; display: block; }
.qr-caption { margin-top: 2.5mm; font-size: 7.5pt; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; }
</style>
</head>
<body>
<div class="label">
  <header class="head">
    <img class="logo" src="${n(t)}" alt="Aito3D">
    <div class="head-right">
      <div class="kicker">Étiquette d'expédition</div>
      <div class="sub">Fret aérien · Air Tahiti</div>
    </div>
  </header>
  ${f(`head`)}
  <main class="body">
    <section class="from">
      <div class="eyebrow">Expéditeur</div>
      <div class="from-name">${n(r.name)}</div>
      ${r.addressLines.map(e=>`<div class="from-line">${n(e)}</div>`).join(`
      `)}
      <div class="from-contact">${n(r.phone)}</div>
      <div class="from-contact">${n(r.email)}</div>
      <div class="ref">
        ${i}
      </div>
    </section>
    <section class="to">
      <div class="eyebrow">Destinataire</div>
      <div class="to-name">${n(e.recipientName)}</div>
      ${a}
      <div class="island">
        <div class="eyebrow">Île de destination</div>
        <div class="island-name">${n(e.island)}</div>
      </div>
      ${e.serviceName?`<div class="service">${n(e.serviceName)}</div>`:``}
      <div class="fragile">Fragile</div>
    </section>
  </main>
  ${f(`foot`)}
  <footer class="thanks">
    <div><b>Māuruuru roa !</b> Merci pour ta confiance, prends soin de tes pièces et à très bientôt.</div>
    <span>— l'équipe Aito3D</span>
  </footer>
</div>
<div class="cut" aria-hidden="true">${p}<span class="cut-hint">Plier · découper ici</span></div>
<section class="review">
  <header class="head">
    <img class="logo" src="${n(t)}" alt="Aito3D">
    <div class="head-right">
      <div class="kicker">Ton avis compte</div>
      <div class="sub">Atelier de fabrication 3D · Arue, Tahiti</div>
    </div>
  </header>
  <div class="review-body">
    <div>
      <div class="review-title">Merci pour ta commande&nbsp;!</div>
      <p class="review-text">Aito3D, c'est un petit atelier d'Arue, et chaque avis compte énormément pour nous faire connaître. Si tes pièces te plaisent, prends une minute pour nous laisser un avis Google&nbsp;: scanne le code, ou tape le lien ci-dessous.</p>
      <div class="stars" aria-hidden="true">${m}${m}${m}${m}${m}</div>
      <div class="review-link">Avis Google&nbsp;: <span>${n(r.reviewUrl)}</span></div>
      <div class="socials">
        <span class="lead">Suis-nous</span>
        <span class="net">${g.facebook}Facebook</span>
        <span class="net">${g.instagram}Instagram</span>
        <span class="net">${g.tiktok}TikTok</span>
        <span>${n(r.socialHandle)}</span>
        <span class="site">${n(r.website)}</span>
      </div>
    </div>
    <div class="qr-box">
      <div class="qr">${h(r.reviewUrl)}</div>
      <div class="qr-caption">Scanne-moi</div>
    </div>
  </div>
</section>
</body>
</html>
`}export{_ as buildShippingLabelHtml,l as shippingLabelFor};