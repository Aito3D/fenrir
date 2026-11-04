import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AITO3D_SENDER } from '../../utils/aitoSender';

/** The sender block used to live in `utils/shippingLabel.ts`, which imports
 *  `react-dom/server` and the QR renderer. The public tracking shell is in
 *  the app entry, so that one constant dragged a 195 KB chunk into every
 *  page load. It now lives on its own; the label module re-exports it. */
describe('AITO3D_SENDER', () => {
  it('exposes the shop sender block', () => {
    expect(AITO3D_SENDER.name).toBe('Aito3D');
    expect(AITO3D_SENDER.email).toBe('contact@aito3d.fr');
  });

  it('is not imported from the shipping-label module by the tracking shell', () => {
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
    for (const rel of [
      '../../components/aito/trackingShell.tsx',
      '../../components/aito/TrackingPaymentMethods.tsx',
      '../../components/aito/TrackingShopPanel.tsx',
      '../../utils/aitoShop.ts',
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/from '(\.\.\/)*(\.\/)?utils\/shippingLabel'|from '\.\/shippingLabel'/);
      expect(src, rel).toMatch(/aitoSender'/);
    }
  });
});
