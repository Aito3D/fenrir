import { describe, it, expect } from 'vitest';
import { itemCodes, markWords, matchedCode, nameColour } from '../../../components/orders/itemSearchText';
import type { OrderItemHit } from '../../../api/client';

describe('item search text', () => {
  it('marks every typed word in any order, accents and case aside', () => {
    expect(markWords('Bambu Lab - PETG - Jaune', 'jaun petg')).toEqual([
      { text: 'Bambu Lab - ', hit: false },
      { text: 'PETG', hit: true },
      { text: ' - ', hit: false },
      { text: 'Jaun', hit: true },
      { text: 'e', hit: false },
    ]);
    expect(markWords('Écran', 'ecr')).toEqual([{ text: 'Écr', hit: true }, { text: 'an', hit: false }]);
  });

  it('takes the first colour word of a name, French or English', () => {
    expect(nameColour('Bambu Lab - PETG HF - Jaune - 1kg')).toBe('#f4d000');
    expect(nameColour('PLA Silk Or')).toBe('#c9a227');
    expect(nameColour('Buse 0.4')).toBeUndefined();
  });

  it('names the code the text found, other than the SKU, and lists every code a scan can mean', () => {
    const item: OrderItemHit = { id: '1', name: 'Plateau', sku: 'PL-1', ean: '3760123456789', part_number: 'FAL-04', reference: 'PL-1', rate: 0, stock_on_hand: 1, product_type: 'goods' };
    expect(matchedCode(item, '3760123')).toBe('EAN 3760123456789');
    expect(matchedCode(item, 'fal 04')).toBeNull(); // the space is not in the code
    expect(matchedCode(item, 'fal-04')).toBe('FAL-04');
    expect(matchedCode(item, 'pl-1')).toBeNull(); // the reference is the SKU, already shown
    expect(itemCodes(item)).toEqual(['PL-1', '3760123456789', 'FAL-04', 'PL-1']);
  });
});
