import { describe, it, expect } from 'vitest';
import { render } from '../utils';
import { QuoteEmailPreview } from '../../components/aito/QuoteEmailPreview';

/** Reads the iframe's srcdoc. The component's whole contract lives in that
 *  attribute: jsdom does not execute or even parse srcdoc content, so the
 *  attribute string is both what we can assert on and exactly what a real
 *  browser would be handed. */
function srcdocOf(container: HTMLElement): string {
  const frame = container.querySelector('iframe');
  expect(frame).not.toBeNull();
  return frame!.getAttribute('srcdoc') || '';
}

describe('QuoteEmailPreview', () => {
  it('keeps block structure instead of collapsing it to one line', () => {
    // The bug this component replaces: textContent glued adjacent blocks
    // together, so the whole email arrived as a single run-on string.
    const { container } = render(
      <QuoteEmailPreview html="<p>Bonjour</p><p>Merci</p>" />,
    );
    const srcdoc = srcdocOf(container);
    expect(srcdoc).toContain('<p>Bonjour</p>');
    expect(srcdoc).toContain('<p>Merci</p>');
    expect(srcdoc).not.toContain('BonjourMerci');
  });

  it('strips scripts and event handlers from upstream HTML', () => {
    // Books' template is upstream content we do not control.
    const hostile =
      '<img src=x onerror="window.__pwned = true">' +
      '<script>window.__pwned = true</script>Bonjour';
    const { container } = render(<QuoteEmailPreview html={hostile} />);
    const srcdoc = srcdocOf(container);
    expect(srcdoc).not.toContain('<script');
    expect(srcdoc).not.toContain('onerror');
    expect(srcdoc).toContain('Bonjour');
  });

  it('strips images, so no tracking pixel can fire', () => {
    const { container } = render(
      <QuoteEmailPreview html='<p>Hi</p><img src="https://tracker.example/p.gif">' />,
    );
    expect(srcdocOf(container)).not.toContain('<img');
  });

  it('strips SVG and input tracking-pixel lookalikes, not just <img>', () => {
    // FORBID_TAGS alone does not cover DOMPurify's default SVG/MathML tag
    // sets, so these two remote-resource vectors need USE_PROFILES: {html}.
    const hostile =
      '<svg><image href="https://tracker.example/p.gif"></svg>' +
      '<input type="image" src="https://tracker.example/p.gif">';
    const { container } = render(<QuoteEmailPreview html={hostile} />);
    const srcdoc = srcdocOf(container);
    expect(srcdoc).not.toContain('tracker.example');
    expect(srcdoc).not.toContain('<svg');
    expect(srcdoc).not.toContain('<image');
    expect(srcdoc).not.toContain('<input');
  });

  it('keeps the template style block, which is why this is an iframe', () => {
    // Fidelity: the template's own CSS is the reason for frame isolation.
    // Stripping it would discard exactly what the iframe was chosen to buy.
    const { container } = render(
      <QuoteEmailPreview html="<style>p { color: red }</style><p>Hi</p>" />,
    );
    // Regex, not toContain: DOMPurify runs its CSS sanitiser over style
    // blocks and may re-emit the rule without the spacing we wrote.
    expect(srcdocOf(container)).toMatch(/color\s*:\s*red/);
  });

  it('locks the frame down with an empty sandbox and a deny-all CSP', () => {
    // Security contract. A refactor that drops either of these must fail here.
    const { container } = render(<QuoteEmailPreview html="<p>Hi</p>" />);
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(srcdocOf(container)).toContain("default-src 'none'");
  });

  it('gives the frame an accessible name', () => {
    const { container } = render(<QuoteEmailPreview html="<p>Hi</p>" />);
    expect(container.querySelector('iframe')!.getAttribute('title')).toBeTruthy();
  });
});
