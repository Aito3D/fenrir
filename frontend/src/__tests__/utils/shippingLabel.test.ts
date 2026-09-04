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

const NOW = new Date('2026-09-03T10:00:00');

describe('shippingLabelFor', () => {
  it('returns null unless the project is in Finish', () => {
    expect(shippingLabelFor({ ...shipped, column: 'print' } as AitoProject, services, 'FA-26-0001', NOW)).toBeNull();
    expect(shippingLabelFor({ ...shipped, column: 'done' } as AitoProject, services, 'FA-26-0001', NOW)).toBeNull();
  });

  it('returns null when the project has no shipping', () => {
    expect(shippingLabelFor({ ...shipped, shipping_island: null } as AitoProject, services, 'FA-26-0001', NOW)).toBeNull();
  });

  it('assembles recipient, island, service and reference from the project', () => {
    const label = shippingLabelFor(shipped, services, 'FA-26-0001', NOW);
    expect(label).toEqual<ShippingLabel>({
      recipientName: 'Teva Tehei',
      recipientPhone: '(+689) 87.75.56.69',
      island: 'Bora Bora',
      serviceName: 'Livraison Avion Société',
      reference: 'FA-26-0001',
      projectTitle: 'Support de casque',
      date: NOW,
    });
  });

  it('falls back to a title-cased island key when the catalogue has not loaded', () => {
    const label = shippingLabelFor(shipped, [], 'FA-26-0001', NOW);
    expect(label?.island).toBe('Bora Bora');
  });

  it('falls back to the service key and an empty reference when the names are missing', () => {
    const label = shippingLabelFor(
      { ...shipped, shipping_service_name: null, shipping_first_name: null, shipping_last_name: 'SARL Manu' } as AitoProject,
      services,
      null,
      NOW,
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
    projectTitle: 'Support & casque',
    date: NOW,
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
    expect(html).toContain('Support &amp; casque');
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

  it('carries the French thank-you note and the date in French', () => {
    expect(html).toContain('Māuruuru');
    expect(html).toContain('3 septembre 2026');
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

  it('frames the label with Tahitian tatau motifs, each drawn once and repeated', () => {
    // Four motifs in the vertical band — enata, niho mano, the ocean curl,
    // tao spearheads — plus the two horizontal strips. Pinned by id so a
    // redesign that drops one is a deliberate edit here too.
    for (const motif of ['tatau-enata', 'tatau-niho', 'tatau-moana', 'tatau-tao', 'strip-niho', 'strip-moana']) {
      expect(html).toContain(`id="${motif}"`);
    }
    expect(html).toContain('class="tatau"');
  });

  it('omits the reference row rather than printing an empty one', () => {
    const without = buildShippingLabelHtml({ ...label, reference: '' }, 'x.png');
    expect(without).not.toContain('Référence');
    expect(html).toContain('Référence');
  });
});
