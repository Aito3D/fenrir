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
 *  Three independent layers, because the template is upstream content we do
 *  not control and one bypass should not be enough:
 *    1. DOMPurify removes scripts, handlers, images and framing tags.
 *    2. sandbox="" gives an opaque origin — no scripts, no navigation, no
 *       form submission, no access to the parent document.
 *    3. The in-document CSP denies every fetch, so even a sanitiser bypass
 *       reaches no network. 'unsafe-inline' for styles is required (email
 *       HTML is inline-styled by necessity) and harmless with scripts denied.
 */
export function QuoteEmailPreview({ html }: { html: string }) {
  const { t } = useTranslation();

  const srcDoc = useMemo(() => {
    const clean = DOMPurify.sanitize(html, {
      FORBID_TAGS: ['img', 'script', 'iframe', 'object', 'embed', 'link', 'base'],
      // Without this, DOMPurify treats a leading <style> as head content and
      // drops it entirely on serialisation (it is not part of ALLOWED_TAGS'
      // body context by default). Forcing a body context is what lets the
      // template's own CSS survive sanitising.
      FORCE_BODY: true,
    });
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  html { background: #fff; }
  body {
    margin: 0; padding: 16px; background: #fff; color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px; line-height: 1.5;
    /* Books' templates are built on fixed-width tables. Without this the
       table forces a horizontal scrollbar in a panel narrower than the
       desktop email client the template was designed for. */
    overflow-wrap: break-word;
  }
  table { max-width: 100%; }
</style>
</head><body>${clean}</body></html>`;
  }, [html]);

  return (
    <iframe
      // Empty string, not omitted: an absent sandbox attribute applies no
      // restrictions at all, while sandbox="" applies all of them.
      sandbox=""
      title={t('aito.sendQuoteMessage')}
      srcDoc={srcDoc}
      className="w-full h-[min(55vh,26rem)] rounded-lg border border-bambu-dark-tertiary bg-white"
    />
  );
}
