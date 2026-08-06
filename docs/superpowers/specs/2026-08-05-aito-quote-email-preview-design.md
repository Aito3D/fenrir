# Aito send-quote modal: a readable email preview

## Problem

`SendQuoteModal` previews the email Zoho Books would send, but the preview is
unreadable. `htmlToText` (`frontend/src/components/aito/htmlToText.ts:16`)
returns `parsed.body.textContent`, and `textContent` emits no newline for
`<br>`, `</p>`, `</div>` or `</tr>`. Books' template therefore collapses into a
single run-on string. The `whitespace-pre-line` on `SendQuoteModal.tsx:109`
honours only whatever source indentation happened to survive, so the breaks
that do appear fall in arbitrary places.

The container compounds it: a 128px-tall box (`max-h-32`) inside a 448px-wide
modal (`max-w-md`).

## Goal

The operator about to hit Send should see approximately what the client will
receive — structure, emphasis, and the estimate table intact.

## Approach

Render the body as HTML on a white "paper" panel inside a locked-down
`<iframe srcdoc>`, in a new component
`frontend/src/components/aito/QuoteEmailPreview.tsx`.

### Why an iframe

The codebase's established pattern for upstream HTML is
`dangerouslySetInnerHTML` + `DOMPurify` on a plain div (`ProjectDetailPage.tsx:903`,
`MakerworldPage.tsx:531`). That is the wrong fit here. Books' body is a
complete email document carrying its own `<style>` blocks with generic
selectors. Inlined into the page it either bleeds CSS into Bambuddy, or has its
styles stripped and stops resembling the email — which defeats the point of the
preview.

An iframe gives style isolation for free. That isolation is the requirement,
not a bonus.

### Security posture

This is upstream content on a template we do not control, so the defences are
layered rather than singular:

- `DOMPurify.sanitize` before the string reaches `srcdoc`, with
  `FORBID_TAGS: ['img', 'script', 'iframe', 'object', 'embed', 'link', 'base']`.

  `<style>` is deliberately **not** forbidden. Containing the template's own
  CSS is the entire reason for choosing an iframe; stripping it would discard
  the fidelity the iframe was chosen to buy. Inside an opaque-origin sandbox
  under `default-src 'none'`, a style block cannot execute, cannot reach the
  network, and cannot escape the frame. DOMPurify sanitizes its contents in
  any case.
- `sandbox=""` on the iframe — opaque origin, no script execution, no
  top-level navigation, no form submission.
- `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
  inside the srcdoc document, so even a sanitizer bypass cannot reach the
  network.

`style-src 'unsafe-inline'` is required and safe: email templates are
inline-styled by necessity, and with `script-src` denied by `default-src 'none'`
inline CSS cannot exfiltrate anything.

### Deliberate limitations

- **No images.** `img` is forbidden outright. This kills tracking pixels and
  broken-icon noise, at the cost of the sender's logo not appearing. Correct
  trade for a preview pane, and it avoids adding an "images blocked" string
  across all 13 locales.
- **Links are inert.** They render styled, but `sandbox=""` blocks navigation.
  Correct for a preview.
- **Fixed height, internal scroll** (`h-[min(55vh,26rem)]`). Auto-sizing to
  content would require `allow-same-origin` to measure `contentDocument`; a
  scroll box is what a preview wants regardless.

### Layout

- Modal `max-w-md` → `max-w-2xl`. The preview needs the width, or the
  template's tables re-wrap into nonsense.
- Subject promoted out of the `<dl>` into a labelled header row above the paper
  panel, so it reads as an email header rather than a definition list.

## Testing

- Hostile-payload assertion moves from `htmlToText` to the new component:
  the rendered `srcdoc` contains no `<script>` and no `onerror`.
- `sandbox=""` and the CSP meta are asserted present. These are the security
  contract; a later refactor dropping them must fail the suite.
- Block structure survives: `<p>A</p><p>B</p>` reaches `srcdoc` as two
  paragraphs, not `AB`.
- `img` is stripped from the sanitized output.
- A `<style>` block in the body survives into `srcdoc` — the fidelity the
  iframe exists to provide.

## Out of scope

- No backend change. `_quote_email_content` (`backend/app/api/routes/aito.py:879`)
  already returns exactly what is needed.
- No change to send semantics, recipient resolution, or the recipient dropdown.
- `htmlToText.ts` is deleted. `SendQuoteModal` is its only caller.
