import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';

/** Books' email body, rendered as the client will see it.
 *
 *  An iframe rather than the `dangerouslySetInnerHTML` div used elsewhere in
 *  this codebase (ProjectDetailPage, MakerworldPage): the body is a whole
 *  email document carrying its own <style> blocks with generic selectors.
 *  Inlined into the page that CSS bleeds into Bambuddy; stripped, the preview
 *  stops resembling the email. Frame isolation is the requirement here, not a
 *  bonus — which is also why <style> survives sanitising while <img> does not.
 *
 *  Two layers, each covering threats the other does not, because the
 *  template is upstream content we do not control:
 *    - DOMPurify removes scripts, handlers, images, image-bearing inputs,
 *      framing tags and anything outside its HTML profile (e.g. the
 *      SVG/MathML tag sets, which can smuggle their own <image>). It is
 *      also the ONLY thing stopping a <meta http-equiv="refresh">
 *      self-navigation — sandbox="" still permits a frame to navigate
 *      itself, and CSP's default-src does not govern document navigation.
 *    - sandbox="" gives an opaque origin — no scripts, no form submission,
 *      no access to the parent document.
 *    - The in-document CSP denies every fetch. This is the ONLY thing
 *      stopping network egress from the <style> block DOMPurify deliberately
 *      lets through (e.g. body{background:url(https://exfil/?…)}) —
 *      sandbox="" places no restriction on subresource loads.
 */
export function QuoteEmailPreview({
  html,
  labelledBy,
}: {
  html: string;
  /** id of an external element (e.g. a form label) that names this frame.
   *  When given, it replaces `title` as the accessible name so a screen
   *  reader does not announce the same label twice. */
  labelledBy?: string;
}) {
  const { t } = useTranslation();

  const srcDoc = useMemo(() => {
    const clean = DOMPurify.sanitize(html, {
      // input is forbidden alongside img: DOMPurify's HTML profile allows
      // <input> as an ordinary form tag, so USE_PROFILES below does not
      // remove it — and type="image" src="…" is exactly as much of a
      // remote-resource / tracking vector as <img>.
      FORBID_TAGS: ['img', 'input', 'script', 'iframe', 'object', 'embed', 'link', 'base'],
      // Without this, DOMPurify treats a leading <style> as head content and
      // drops it entirely on serialisation (it is not part of ALLOWED_TAGS'
      // body context by default). Forcing a body context is what lets the
      // template's own CSS survive sanitising.
      FORCE_BODY: true,
      // Restricts ALLOWED_TAGS to the HTML profile. Without this, DOMPurify's
      // defaults also allow the SVG and MathML tag sets, and FORBID_TAGS
      // above does not cover them — <svg><image href="…tracker.gif"></svg>
      // would otherwise survive sanitising and be stopped only by the CSP.
      USE_PROFILES: { html: true },
    });
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  html { background: #fff; }
  body {
    margin: 0; padding: 16px; background: #fff; color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px; line-height: 1.5;
    /* Breaks long unbroken strings (e.g. URLs) that would otherwise force a
       horizontal scrollbar on their own. Per CSS Text 3, break-word is
       ignored when computing a table's min-content intrinsic size, so it
       does NOT shrink Books' fixed-width tables — table { max-width: 100% }
       below is what does that. */
    overflow-wrap: break-word;
  }
  /* Books' templates are built on fixed-width (600px) tables, divs and td
     wrappers. Without this each forces a horizontal scrollbar in a panel
     narrower than the desktop email client the template was designed for. */
  table, td, div { max-width: 100%; }
</style>
</head><body>${clean}</body></html>`;
  }, [html]);

  return (
    <iframe
      // Empty string, not omitted: an absent sandbox attribute applies no
      // restrictions at all, while sandbox="" applies all of them.
      sandbox=""
      // An iframe with no accessible name is worse than one with a name
      // duplicated by an external label, so title is the fallback.
      title={labelledBy ? undefined : t('aito.sendQuoteMessage')}
      aria-labelledby={labelledBy}
      srcDoc={srcDoc}
      className="w-full h-[min(55vh,26rem)] min-h-[14rem] rounded-lg border border-bambu-dark-tertiary bg-white"
    />
  );
}
