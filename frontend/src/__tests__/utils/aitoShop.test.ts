import { describe, expect, it } from 'vitest';
import { SHOP_DIRECTIONS_URL, shopMapEmbedUrl } from '../../utils/aitoShop';

/** Google's keyless embed cannot geocode the bare street address: it usually
 *  returns no location (the frame then shows the whole world) and once
 *  returned a point 600 m off. A query that leads with the business name
 *  resolves to the shop's own Google Business pin every time, in every
 *  language, so both the embed and the directions link must search for
 *  "Aito3D, <street>, Arue, Tahiti, …" — and never the en-dash form
 *  "Arue – Tahiti" that the printed address uses. */
const query = (url: string) => decodeURIComponent(new URL(url).searchParams.get('q') ?? new URL(url).searchParams.get('destination') ?? '');

describe('aitoShop', () => {
  it('embeds a map search led by the business name, with the address comma-separated', () => {
    const url = shopMapEmbedUrl('fr');
    expect(url).toMatch(/^https:\/\/www\.google\.com\/maps\?q=/);
    expect(url).toContain('&z=16&hl=fr&output=embed');
    expect(query(url)).toBe("Aito3D, 20 Route de l'eau Royale, Arue, Tahiti, Polynésie française");
  });

  it('points directions at the same business search', () => {
    expect(SHOP_DIRECTIONS_URL).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);
    expect(query(SHOP_DIRECTIONS_URL)).toBe("Aito3D, 20 Route de l'eau Royale, Arue, Tahiti, Polynésie française");
  });
});
