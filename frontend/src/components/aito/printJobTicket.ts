import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../../i18n';
import { JobTicket, type JobTicketProps } from './JobTicket';

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Print rules for the ticket. Black on white with no tints (half-tones band
 *  on the shop's printer), system fonts (a web font can miss the print
 *  snapshot), and a task block never split across a page break so a step's
 *  tick box stays beside its task's title. */
const CSS = `
@page { size: A4 portrait; margin: 14mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; font-size: 12pt; line-height: 1.35; color: #111; }
.head { display: flex; justify-content: space-between; gap: 8mm; padding-bottom: 4mm; border-bottom: .5mm solid #111; }
.eyebrow { font-size: 8pt; font-weight: 700; letter-spacing: .2em; text-transform: uppercase; }
.ids { display: flex; align-items: baseline; gap: 4mm; margin-top: 1.5mm; }
.card-no { font-size: 24pt; font-weight: 800; }
.quote-no { font-size: 13pt; font-weight: 600; font-variant-numeric: tabular-nums; }
.client { font-size: 15pt; font-weight: 700; margin-top: 1mm; }
.phone { font-variant-numeric: tabular-nums; }
.dates { display: flex; gap: 8mm; margin: 2.5mm 0 0; }
.dates dt { font-size: 8pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.dates dd { margin: 0; font-weight: 600; }
.qr { flex: none; width: 32mm; }
.qr svg { width: 100%; height: auto; display: block; }
.description { margin: 4mm 0 0; white-space: pre-wrap; }
.task { margin-top: 6mm; break-inside: avoid; page-break-inside: avoid; }
.task-title { font-size: 13pt; margin: 0 0 2mm; padding-bottom: 1mm; border-bottom: .3mm solid #111; }
.steps { list-style: none; margin: 0; padding: 0; }
.step { padding: 1.5mm 0; break-inside: avoid; page-break-inside: avoid; }
.step-row { display: flex; align-items: baseline; gap: 3mm; }
.tick { flex: none; width: 4.5mm; height: 4.5mm; border: .4mm solid #111; border-radius: .6mm; transform: translateY(.6mm); }
.step-name { font-weight: 700; min-width: 28mm; }
.step-details { font-variant-numeric: tabular-nums; }
.step-note { margin: .8mm 0 0 7.5mm; font-size: 10.5pt; white-space: pre-wrap; }
.foot { margin-top: 8mm; padding-top: 2mm; border-top: .3mm solid #111; font-size: 9pt; }
`;

/** A complete printable document for `usePrintBlob`: the `JobTicket` view as
 *  static markup, plus its own page rules — in the hidden iframe there is no
 *  app stylesheet, and Tailwind's dark canvas would flood the page anyway. */
export function buildJobTicketHtml(props: JobTicketProps): string {
  const body = renderToStaticMarkup(createElement(JobTicket, props));
  const title = `${i18n.t('aito.jobTicketTitle')} #${props.project.id}`;
  return `<!doctype html>
<html lang="${escapeHtml(i18n.language)}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>${body}</body>
</html>`;
}
