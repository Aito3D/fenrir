import type { OrderItemHit } from '../../api/client';

/** Text helpers of the item search: the colour dot, the matched words and the sellable quantity of a result. */

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// shortcut: the basic colour words of the shop's item names (French and English), not the full colour catalogue; extend when a name shows no dot.
const COLOUR: Record<string, string> = {
  noir: '#111111', black: '#111111', blanc: '#f5f5f5', white: '#f5f5f5', gris: '#8a8a8a', grey: '#8a8a8a', gray: '#8a8a8a',
  rouge: '#d62828', red: '#d62828', bleu: '#1e5bd8', blue: '#1e5bd8', vert: '#2a9d3f', green: '#2a9d3f',
  jaune: '#f4d000', yellow: '#f4d000', orange: '#f08c00', rose: '#f28cb1', pink: '#f28cb1', violet: '#7b3fb5',
  purple: '#7b3fb5', marron: '#7a4a2a', brown: '#7a4a2a', beige: '#d8c3a0', or: '#c9a227', gold: '#c9a227',
  argent: '#c0c0c0', silver: '#c0c0c0',
};

/** The first colour word of an item name, as a swatch colour. */
export function nameColour(name: string): string | undefined {
  return fold(name).split(/[^a-z]+/).map(w => COLOUR[w]).find(Boolean);
}

/** ``name`` split into plain and matched parts: the spans holding a typed word, accents and case aside. */
export function markWords(name: string, typed: string): { text: string; hit: boolean }[] {
  const chars = [...name];
  const folded = chars.map(c => fold(c));
  const flat = folded.join('');
  const starts: number[] = []; // index in ``flat`` where each char begins
  folded.reduce((at, f) => (starts.push(at), at + f.length), 0);
  const hit = new Array<boolean>(chars.length).fill(false);
  for (const word of fold(typed).split(/\s+/).filter(Boolean)) {
    for (let at = flat.indexOf(word); at >= 0; at = flat.indexOf(word, at + 1)) {
      starts.forEach((s, i) => { if (s >= at && s < at + word.length) hit[i] = true; });
    }
  }
  const parts: { text: string; hit: boolean }[] = [];
  chars.forEach((c, i) => {
    const last = parts[parts.length - 1];
    if (last && last.hit === hit[i]) last.text += c;
    else parts.push({ text: c, hit: hit[i] });
  });
  return parts;
}

/** What can be sold: on hand minus what confirmed orders committed; on hand when Books did not say. */
export function available(item: OrderItemHit): number | null {
  return item.available ?? item.stock_on_hand;
}

/** The code (other than the SKU, always shown) that the typed text found, with its label: a scanned EAN, a part number… */
export function matchedCode(item: OrderItemHit, typed: string): string | null {
  const q = fold(typed).replace(/\s+/g, '');
  if (q.length < 2) return null;
  const codes: [string, string | undefined][] = [['EAN', item.ean], ['UPC', item.upc], ['', item.part_number], ['', item.reference]];
  const hit = codes.find(([, v]) => v && v !== item.sku && fold(v).includes(q));
  return hit ? `${hit[0]} ${hit[1]}`.trim() : null;
}

/** Every code a scan can mean: SKU, barcodes, part number, reference. */
export const itemCodes = (item: OrderItemHit): string[] => [item.sku, item.upc, item.ean, item.part_number, item.reference].filter((c): c is string => !!c);
