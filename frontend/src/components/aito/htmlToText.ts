/** Books' rendered email body, reduced to plain text for the preview.
 *
 *  DOMParser rather than innerHTML on a live node: parsing into an inert
 *  document runs no script, fires no `onerror`, and fetches no remote image.
 *  The result is handed to React as a child, so it is escaped again on the way
 *  out. A preview is worth a scroll box; it is not worth an injection surface
 *  fed by a template we do not control.
 */
export function htmlToText(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  // <script>/<style> content is still a text-node child in an inert document
  // (parsing doesn't execute it, but textContent walks it like any other
  // text), so it has to be dropped explicitly rather than trusted to fall
  // out of a plain textContent read.
  parsed.querySelectorAll('script, style').forEach((el) => el.remove());
  return (parsed.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}
