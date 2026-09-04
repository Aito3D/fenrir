import { describe, it, expect } from 'vitest';
import { AITO3D_SENDER, buildShippingLabelHtml, shippingLabelFor } from '../../utils/shippingLabel';
import type { ShippingLabel } from '../../utils/shippingLabel';
import type { AitoProject, AitoShippingService } from '../../api/client';

/** A finished, shipped, invoiced project — the one case the label exists for. */
const shipped = {
  id: 7,
  column: 'finish',
  description: 'Support de casque',
  shipping_island: 'bora-bora',
  shipping_service: 'societe',
  shipping_service_name: 'Livraison Avion Société',
  shipping_first_name: 'Teva',
  shipping_last_name: 'Tehei',
  shipping_phone: '+689-87755669',
} as unknown as AitoProject;

const services: AitoShippingService[] = [
  {
    key: 'societe',
    name: 'Livraison Avion Société',
    rate: 1500,
    islands: [{ key: 'bora-bora', label: 'Bora Bora' }],
  } as unknown as AitoShippingService,
];

describe('shippingLabelFor', () => {
  it('returns null unless the project is in Finish', () => {
    expect(shippingLabelFor({ ...shipped, column: 'print' } as AitoProject, services, 'FA-26-0001')).toBeNull();
    expect(shippingLabelFor({ ...shipped, column: 'done' } as AitoProject, services, 'FA-26-0001')).toBeNull();
  });

  it('returns null when the project has no shipping', () => {
    expect(shippingLabelFor({ ...shipped, shipping_island: null } as AitoProject, services, 'FA-26-0001')).toBeNull();
  });

  it('assembles recipient, island, service and reference from the project', () => {
    const label = shippingLabelFor(shipped, services, 'FA-26-0001');
    expect(label).toEqual<ShippingLabel>({
      recipientName: 'Teva Tehei',
      recipientPhone: '(+689) 87.75.56.69',
      island: 'Bora Bora',
      serviceName: 'Livraison Avion Société',
      reference: 'FA-26-0001',
    });
  });

  it('falls back to a title-cased island key when the catalogue has not loaded', () => {
    const label = shippingLabelFor(shipped, [], 'FA-26-0001');
    expect(label?.island).toBe('Bora Bora');
  });

  it('falls back to the service key and an empty reference when the names are missing', () => {
    const label = shippingLabelFor(
      { ...shipped, shipping_service_name: null, shipping_first_name: null, shipping_last_name: 'SARL Manu' } as AitoProject,
      services,
      null,
    );
    expect(label?.serviceName).toBe('societe');
    expect(label?.recipientName).toBe('SARL Manu');
    expect(label?.reference).toBe('');
  });
});

describe('buildShippingLabelHtml', () => {
  const label: ShippingLabel = {
    recipientName: 'Teva <Tehei>',
    recipientPhone: '(+689) 87.75.56.69',
    island: 'Bora Bora',
    serviceName: 'Livraison Avion Société',
    reference: 'FA-26-0001',
  };
  const html = buildShippingLabelHtml(label, 'https://app.example/assets/aito3d.png');

  it('is a standalone A4 document with the label on the top half and a cut line', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('size: A4');
    expect(html).toContain('height: 148.5mm');
    expect(html).toContain('class="cut"');
  });

  it('prints the recipient block, escaping what came from the operator', () => {
    expect(html).toContain('Teva &lt;Tehei&gt;');
    expect(html).not.toContain('Teva <Tehei>');
    // Neutral on purpose: nothing on the outside of the parcel says what is
    // in it or when it left — no project title, no date.
    expect(html).not.toContain('Support');
    expect(html).not.toContain('Expédié');
    // A French long date, e.g. "3 septembre 2026". (Not a bare year: the
    // font's unicode-range "U+2000-206F" would trip that.)
    expect(html).not.toMatch(/\b\d{1,2} [a-zéû]+ 20\d\d\b/);
    expect(html).toContain('(+689) 87.75.56.69');
    expect(html).toContain('Bora Bora');
    expect(html).toContain('Livraison Avion Société');
    expect(html).toContain('FA-26-0001');
  });

  it('prints the Aito3D sender block and logo', () => {
    expect(html).toContain('https://app.example/assets/aito3d.png');
    for (const line of [AITO3D_SENDER.name, ...AITO3D_SENDER.addressLines, AITO3D_SENDER.phone, AITO3D_SENDER.email]) {
      expect(html).toContain(line);
    }
  });

  it('carries the thank-you note in French, in tutoiement', () => {
    expect(html).toContain('Māuruuru');
    expect(html).toContain('Merci pour ta confiance');
    expect(html).not.toContain('votre');
  });

  it('loads Inter from the logo origin, and silently skips the fonts when the logo has none', () => {
    expect(html).toContain("src:url('https://app.example/fonts/inter-latin.woff2')");
    // Without `swap`, Chrome hides text for up to 3s while the font loads —
    // and a print snapshot taken inside that window is a label with no words.
    expect(html.match(/font-display:swap/g)).toHaveLength(2);
    // A data: URL is a valid URL with no origin to resolve `/fonts/` against;
    // a relative path has no origin at all. Neither may throw — the label is
    // still complete in the system font.
    expect(buildShippingLabelHtml(label, 'data:image/png;base64,AAAA')).not.toContain('@font-face');
    expect(buildShippingLabelHtml(label, 'aito3d.png')).not.toContain('@font-face');
  });

  it('frames the label with two Tahitian tatau strips and no side band', () => {
    // The same niho mano run under the header and above the thank-you line,
    // each with its own pattern id. Pinned so a redesign that drops one is a
    // deliberate edit here too. The vertical band down the left edge and the
    // organic foot strip were both removed on request.
    for (const motif of ['strip-niho-head', 'strip-niho-foot']) {
      expect(html).toContain(`id="${motif}"`);
    }
    expect(html).not.toContain('class="tatau"');
  });

  it('fills the bottom half with a review card: thanks, a Google review link and its QR code', () => {
    expect(html).toContain('class="review"');
    expect(html).toContain('top: 148.5mm');
    expect(html).toContain('Merci pour ta commande');
    // The link printed as text AND as a scannable code — a printed URL
    // nobody will retype is not a call to action.
    expect(html).toContain(AITO3D_SENDER.reviewUrl.replace(/&/g, '&amp;'));
    expect(html).toContain('class="qr"');
    expect(html).toMatch(/class="qr"[\s\S]*<svg[\s\S]*shape-rendering="crispEdges"/);
    // Same register as the label's own note.
    expect(html).not.toContain('votre');
    // The follow-us line and the site, under the review ask.
    for (const text of ['Facebook', 'Instagram', 'TikTok', AITO3D_SENDER.socialHandle, AITO3D_SENDER.website]) {
      expect(html).toContain(text);
    }
    // The card stays plain: no tatau strips and no closing note — those
    // belong to the label above the fold, not to this half.
    const card = html.slice(html.indexOf('class="review"'));
    expect(card).not.toContain('class="strip');
    expect(card).not.toContain('class="thanks"');
  });

  it('omits the reference row rather than printing an empty one', () => {
    const without = buildShippingLabelHtml({ ...label, reference: '' }, 'x.png');
    expect(without).not.toContain('Référence');
    expect(html).toContain('Référence');
  });
});
